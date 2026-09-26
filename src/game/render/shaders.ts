/*
  The two programs of the pixel look, as source.

  They are RawShaderMaterials on purpose. A ShaderMaterial would pull in
  three's prefix (tone mapping, colour-space chunks, fog) and key its program
  on renderer state, and the whole point of this pass is that the renderer's
  own tone mapping and output encoding are switched *off* (see pixelLook.ts):
  the look owns every step from linear HDR to the byte on screen, and nothing
  about it may change which program is bound when a pref moves. Everything
  that varies is a uniform.

  GRADE runs at the internal resolution, once per chunky pixel: outlines from
  depth, exposure and ACES, the baked grade, the OKLab posterize with its
  ordered dither, and the vignette. BLIT runs at the canvas's resolution and
  does one texelFetch, which is the nearest-neighbour upscale and nothing
  else, so the expensive half of the look is paid on a quarter or a ninth of
  the pixels.
*/

export const FULLSCREEN_VERT = /* glsl */ `
  in vec3 position;
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

export const GRADE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  precision highp sampler3D;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler3D tLutA;
  uniform sampler3D tLutB;
  /** 0 day table .. 1 night table */
  uniform float uMood;
  /** 0 ungraded .. 1 fully graded */
  uniform float uGrade;
  uniform float uLutSize;
  uniform float uExposure;
  /** camera near, far */
  uniform vec2 uClip;
  /** fog near, far, and whether there is any */
  uniform vec3 uFog;
  /** silhouette darken, convex lift, concave darken */
  uniform vec3 uEdge;
  /** silhouette gap: a constant and a fraction of depth; crease threshold */
  uniform vec3 uEdgeK;
  /** lightness steps, chroma step, dither amount */
  uniform vec3 uPost;
  uniform float uVignette;
  uniform vec2 uRes;

  out vec4 outColor;

  // positive distance along the view axis; perspectiveDepthToViewZ, negated
  float dist(ivec2 p) {
    ivec2 q = clamp(p, ivec2(0), ivec2(uRes) - 1);
    float d = texelFetch(tDepth, q, 0).x;
    return (uClip.x * uClip.y) / (uClip.y - (uClip.y - uClip.x) * d);
  }

  vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  // three's ACES fit, verbatim, so the materials tuned under it still read
  vec3 aces(vec3 color) {
    const mat3 IN = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777));
    const mat3 OUT = mat3(
      vec3(1.60475, -0.10208, -0.00327),
      vec3(-0.53108, 1.10813, -0.07276),
      vec3(-0.07367, -0.00605, 1.07602));
    color *= uExposure / 0.6;
    color = OUT * RRTAndODTFit(IN * color);
    return clamp(color, 0.0, 1.0);
  }

  vec3 toSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  vec3 oklab(vec3 c) {
    vec3 lms = vec3(
      dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
      dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
      dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
    lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
    return vec3(
      dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
      dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
      dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
  }
  vec3 fromOklab(vec3 c) {
    vec3 lms = vec3(
      c.x + 0.3963377774 * c.y + 0.2158037573 * c.z,
      c.x - 0.1055613458 * c.y - 0.0638541728 * c.z,
      c.x - 0.0894841775 * c.y - 1.2914855480 * c.z);
    lms = lms * lms * lms;
    return vec3(
      dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
      dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
      dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
  }

  const float BAYER[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0);
  float bayer(ivec2 p) {
    return (BAYER[(p.y & 3) * 4 + (p.x & 3)] + 0.5) / 16.0 - 0.5;
  }

  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 src = texelFetch(tColor, p, 0);
    vec3 col = src.rgb;

    // ---- outlines, from depth alone -------------------------------------
    // Only where the pixel is solid: the CSS3D glass holes write a near-zero
    // alpha and must come through untouched
    if (src.a > 0.99) {
      float zc = dist(p);
      float zl = dist(p + ivec2(-1, 0));
      float zr = dist(p + ivec2(1, 0));
      float zd = dist(p + ivec2(0, -1));
      float zu = dist(p + ivec2(0, 1));
      // how much this pixel fades into the fog: an outline on something the
      // air has already swallowed is a line drawn on nothing
      float fogK = uFog.z > 0.5
        ? 1.0 - smoothstep(uFog.x, uFog.y, zc) : 1.0;
      fogK *= fogK;
      float gap = uEdgeK.x + zc * uEdgeK.y;
      // silhouette: a neighbour a long way *behind* this pixel means this
      // pixel is the rim of the nearer thing, so the 1px line lands on the
      // object rather than on whatever is behind it
      float behind = max(max(zl, zr), max(zu, zd)) - zc;
      float sil = smoothstep(gap, gap * 1.6, behind);
      // creases: the second difference of 1/z, which is exactly zero across
      // any plane (1/z is affine in screen space) and signed at a fold.
      // Skipped next to a depth break, where it is the silhouette's business
      float front = zc - min(min(zl, zr), min(zu, zd));
      float ic = 1.0 / zc;
      float lap = ((1.0 / zl + 1.0 / zr) + (1.0 / zu + 1.0 / zd) - 4.0 * ic) / ic;
      float calm = 1.0 - step(gap * 0.5, max(behind, front));
      float convex = smoothstep(uEdgeK.z, uEdgeK.z * 2.5, -lap) * calm;
      float concave = smoothstep(uEdgeK.z, uEdgeK.z * 2.5, lap) * calm;
      col *= 1.0 - sil * uEdge.x * fogK;
      col *= 1.0 + convex * uEdge.y * fogK;
      col *= 1.0 - concave * uEdge.z * fogK;
    }

    // ---- tone and grade -------------------------------------------------
    vec3 disp = toSrgb(aces(col));
    vec3 lutUv = disp * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    vec3 graded = mix(texture(tLutA, lutUv).rgb, texture(tLutB, lutUv).rgb, uMood);
    disp = mix(disp, graded, uGrade);

    // vignette, before the posterize so its falloff bands and dithers too
    vec2 uv = gl_FragCoord.xy / uRes - 0.5;
    disp *= 1.0 - uVignette * smoothstep(0.35, 0.95, dot(uv, uv) * 2.2);

    // ---- posterize with an ordered dither, in OKLab ---------------------
    // Lightness and chroma quantize separately: the lightness steps are the
    // visible bands, the chroma grid is the palette. The chroma dither reads
    // the matrix transposed, so the two thresholds do not land on the same
    // pixels and stack into one coarse pattern
    if (uPost.x > 0.5) {
      vec3 lab = oklab(toLinear(disp));
      float t = bayer(p) * uPost.z;
      float t2 = bayer(p.yx + ivec2(2, 1)) * uPost.z;
      lab.x = floor(lab.x * uPost.x + 0.5 + t) / uPost.x;
      lab.yz = floor(lab.yz / uPost.y + 0.5 + t2) * uPost.y;
      disp = toSrgb(clamp(fromOklab(lab), 0.0, 1.0));
    }

    // premultiplied, as the canvas composites it
    outColor = vec4(disp * src.a, src.a);
  }
`

export const BLIT_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;

  uniform sampler2D tSrc;
  /** viewport origin in device pixels, and source texels per device pixel */
  uniform vec4 uMap;

  out vec4 outColor;

  void main() {
    ivec2 p = ivec2((gl_FragCoord.xy - uMap.xy) * uMap.zw);
    outColor = texelFetch(tSrc, clamp(p, ivec2(0), textureSize(tSrc, 0) - 1), 0);
  }
`
