/*
  The programs of the pixel look, as source.

  They are RawShaderMaterials on purpose. A ShaderMaterial would pull in
  three's prefix (tone mapping, colour-space chunks, fog) and key its program
  on renderer state, and the whole point of this pass is that the renderer's
  own tone mapping and output encoding are switched *off* (see pixelLook.ts):
  the look owns every step from linear HDR to the byte on screen, and nothing
  about it may change which program is bound when a pref moves. Everything
  that varies is a uniform.

  GRADE runs at the internal resolution, once per chunky pixel, in the order
  light travels: the fake lights (lamp pools and the headlamp, which only
  exist here), the outlines, the air between the eye and the surface, then
  exposure and ACES, the baked grade, grain, the banded posterize and
  the vignette. BLIT runs at the canvas's resolution and does one texelFetch,
  the nearest-neighbour upscale and nothing else, so the expensive half of
  the look is paid on a quarter or a ninth of the pixels. PUNCH redraws the
  glass holes at the canvas's own resolution, so the edge of a live-DOM screen
  is a clean line rather than a staircase of chunky pixels.
*/

/** how many lamp pools the look shades at once; the nearest ones win */
export const MAX_POOLS = 16

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
  /** camera near, far; tan of the half field of view on x and y */
  uniform vec2 uClip;
  uniform vec2 uTan;
  /** camera position and orientation, to put a pixel back in the world */
  uniform vec3 uCamPos;
  uniform mat3 uCamRot;
  /** the scene's own fog: near, far, and whether there is any */
  uniform vec3 uFog;
  /** silhouette darken, fold ink, convex lift */
  uniform vec3 uEdge;
  /** silhouette gap: a constant and a fraction of depth; fold threshold
      (1 - cos of the angle between neighbouring normals); convex threshold */
  uniform vec4 uEdgeK;
  /** lightness steps, chroma step, dither band width, grain */
  uniform vec4 uPost;
  uniform float uVignette;
  uniform vec2 uRes;
  uniform float uFrame;

  /** the air: start, e-folding distance, ceiling, and plane count (0 smooth) */
  uniform vec4 uAir;
  /** the air's colour (linear), and the sun's warm glow into it */
  uniform vec3 uAirCol;
  uniform vec3 uSunDir;
  uniform vec3 uSunGlow;
  /** how far the sky at the horizon is pulled into the air, how far up that
      reaches, and how much of the whole sky goes with it */
  uniform vec3 uSkyAir;
  /** the air's height layer: base y, thickness, how much it applies (0 off,
      the walker's air), and the range at which the world ends (0 none) */
  uniform vec4 uAirLift;

  /** lamp pools: world xyz and radius; their count, colour*gain */
  uniform vec4 uPools[${MAX_POOLS}];
  uniform int uPoolCount;
  uniform vec3 uPoolCol;
  /** how much a lamp lights the air around itself, and that halo's radius */
  uniform vec2 uHalo;
  /** the ambient light a night surface is lit by, to recover its albedo */
  uniform vec3 uAmbient;
  /** the headlamp: world position, direction, colour*gain, and
      (range, cos of the outer cone, cos of the inner cone, on) */
  uniform vec3 uHeadPos;
  uniform vec3 uHeadDir;
  uniform vec3 uHeadCol;
  uniform vec4 uHeadK;
  /** a flash (an explosion): world xyz and radius (0 off), colour*gain */
  uniform vec4 uFlash;
  uniform vec3 uFlashCol;

  out vec4 outColor;

  // distance along the view axis; perspectiveDepthToViewZ, negated
  float dist(ivec2 p) {
    ivec2 q = clamp(p, ivec2(0), ivec2(uRes) - 1);
    float d = texelFetch(tDepth, q, 0).x;
    return (uClip.x * uClip.y) / (uClip.y - (uClip.y - uClip.x) * d);
  }
  vec3 viewRay(ivec2 p) {
    vec2 ndc = (vec2(p) + 0.5) / uRes * 2.0 - 1.0;
    return vec3(ndc * uTan, -1.0);
  }
  vec3 viewPos(ivec2 p) {
    return viewRay(p) * dist(p);
  }
  // a normal from depth alone: per axis, the one-sided difference that stays
  // on this pixel's own surface, so a fold does not smear across a gap
  vec3 normalAt(ivec2 p) {
    vec3 c = viewPos(p);
    vec3 l = viewPos(p + ivec2(-1, 0));
    vec3 r = viewPos(p + ivec2(1, 0));
    vec3 d = viewPos(p + ivec2(0, -1));
    vec3 u = viewPos(p + ivec2(0, 1));
    vec3 dx = abs(l.z - c.z) < abs(r.z - c.z) ? c - l : r - c;
    vec3 dy = abs(d.z - c.z) < abs(u.z - c.z) ? c - d : u - c;
    return normalize(cross(dx, dy));
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
  /** threshold in (0, 1) */
  float bayer(ivec2 p) {
    return (BAYER[(p.y & 3) * 4 + (p.x & 3)] + 0.5) / 16.0;
  }
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  // Round x onto a grid of step 1/n, dithering only inside a band of width w
  // around each boundary: w = 1 is a full ordered dither (a screen door over
  // every gradient), small w is flat posterized bands with a short dithered
  // seam between them, which is what reads as pixel art
  float band(float x, float n, float thr, float w) {
    float s = x * n;
    float i = floor(s);
    float f = clamp((s - i - 0.5) / max(w, 1e-3) + 0.5, 0.0, 1.0);
    return (i + step(thr, f)) / n;
  }

  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 src = texelFetch(tColor, p, 0);
    vec3 col = src.rgb;
    // Clamped: the scene target is half float, and additive sprites (stars,
    // halos, fireflies) blend alpha as src.a * src.a + dst.a, which piles up
    // past 1 there where an 8-bit canvas would have clamped it. Written back
    // premultiplied, an alpha of 1.3 is a pixel 30% brighter than it was
    // drawn: every star, faded out to nothing, came back as a glowing dot
    float a = min(src.a, 1.0);
    // A light source: alpha written as 254/255 (see GLOW_ALPHA in
    // pixelLook.ts) is solid, not a hole, takes no outline ink and no fake
    // lamp light, and skips the baked grade, whose
    // chroma cap and hue pull would otherwise turn an energy beam into the
    // same murky pastel as the sky behind it. It still takes ACES and the
    // posterize, so it bands and dithers like everything else
    float emits = a >= 0.99 && a < 0.9985 ? 1.0 : 0.0;
    if (emits > 0.5) a = 1.0;
    float depth = texelFetch(tDepth, p, 0).x;
    bool sky = depth >= 0.999999;
    vec3 ray = viewRay(p);
    vec3 dirW = normalize(uCamRot * ray);

    // A hole (the CSS3D glass writes a near-zero alpha) is redrawn exactly
    // at full resolution by the punch pass. Here it is filled from its solid
    // neighbours, so the chunky pixels along its rim are bezel, not window
    if (a < 0.99) {
      vec3 acc = vec3(0.0);
      float n = 0.0;
      for (int i = 0; i < 4; i++) {
        ivec2 q = p + ivec2(i == 0 ? -1 : i == 1 ? 1 : 0, i == 2 ? -1 : i == 3 ? 1 : 0);
        vec4 s = texelFetch(tColor, clamp(q, ivec2(0), ivec2(uRes) - 1), 0);
        if (s.a > 0.99) { acc += s.rgb; n += 1.0; }
      }
      col = n > 0.0 ? acc / n : col;
      a = 1.0;
    }

    float zc = dist(p);
    vec3 vp = ray * zc;
    float range = length(vp);
    // how much of this pixel the air has, all told; the posterize bands a
    // pixel that is nothing but air the way it bands the sky
    float airAll = 0.0;

    if (!sky) {
      vec3 wp = uCamPos + uCamRot * vp;
      // ---- fake light: lamp pools and the headlamp ----------------------
      // A surface at night is roughly albedo * ambient, so dividing the
      // ambient back out recovers something to light. These lights are not
      // in any material, so they cost no program and can come and go freely
      vec3 albedo = clamp(col / max(uAmbient, vec3(0.004)), 0.0, 1.2);
      vec3 lit = vec3(0.0);
      for (int i = 0; i < ${MAX_POOLS}; i++) {
        if (i >= uPoolCount) break;
        vec4 L = uPools[i];
        vec3 d = wp - L.xyz;
        float k = clamp(1.0 - dot(d, d) / (L.w * L.w), 0.0, 1.0);
        // a streetlamp shines down: nothing above the head is lit by it
        k *= smoothstep(0.6, -0.4, d.y);
        lit += uPoolCol * (k * k);
      }
      if (uHeadK.w > 0.5) {
        vec3 d = wp - uHeadPos;
        float r = length(d);
        // squared, so the beam fades out over its whole width instead of
        // ending on a rim: a torch, not a projected disc
        float cone = smoothstep(uHeadK.y, uHeadK.z, dot(d / max(r, 1e-3), uHeadDir));
        cone *= cone;
        float fall = 1.0 / (1.0 + (r / uHeadK.x) * (r / uHeadK.x) * 4.0);
        lit += uHeadCol * cone * fall;
      }
      if (uFlash.w > 0.0) {
        // a blast lights everything round it, above and below, by day too
        vec3 d = wp - uFlash.xyz;
        float k = clamp(1.0 - dot(d, d) / (uFlash.w * uFlash.w), 0.0, 1.0);
        lit += uFlashCol * (k * k);
      }
      // an ordered jitter on the light itself, so the posterize cuts its
      // falloff into dithered steps instead of concentric rings
      col += albedo * lit * (1.0 + (bayer(p + ivec2(3, 2)) - 0.5) * 0.7) * (1.0 - emits);

      // ---- outlines, from depth alone -----------------------------------
      float fogK = uFog.z > 0.5 ? 1.0 - smoothstep(uFog.x, uFog.y, zc) : 1.0;
      fogK *= fogK;
      float zl = dist(p + ivec2(-1, 0));
      float zr = dist(p + ivec2(1, 0));
      float zd = dist(p + ivec2(0, -1));
      float zu = dist(p + ivec2(0, 1));
      float gap = uEdgeK.x + zc * uEdgeK.y;
      // silhouette: a neighbour a long way *behind* this pixel means this
      // pixel is the rim of the nearer thing, so the line lands on the object
      float behind = max(max(zl, zr), max(zu, zd)) - zc;
      float front = zc - min(min(zl, zr), min(zu, zd));
      float sil = smoothstep(gap, gap * 1.6, behind);
      float calm = 1.0 - step(gap * 0.5, max(behind, front));
      // folds: the angle between this pixel's normal and its right and upper
      // neighbours', one pixel wide, and only close enough that depth can
      // still resolve a normal (past that it is noise, and fog anyway)
      float fold = 0.0;
      float convex = 0.0;
      if (calm > 0.5 && zc < 90.0) {
        vec3 nc = normalAt(p);
        float bend = max(1.0 - dot(nc, normalAt(p + ivec2(1, 0))),
                         1.0 - dot(nc, normalAt(p + ivec2(0, 1))));
        fold = smoothstep(uEdgeK.z, uEdgeK.z * 2.2, bend) * (1.0 - smoothstep(50.0, 90.0, zc));
        // the second difference of 1/z says which folds face the eye
        float ic = 1.0 / zc;
        float lap = ((1.0 / zl + 1.0 / zr) + (1.0 / zu + 1.0 / zd) - 4.0 * ic) / ic;
        convex = smoothstep(uEdgeK.w, uEdgeK.w * 2.5, -lap);
      }
      col *= 1.0 - fold * (1.0 - convex) * uEdge.y * fogK;
      col *= 1.0 + convex * uEdge.z * fogK;

      // ---- the air ------------------------------------------------------
      // aerial perspective as a few readable planes: near things keep their
      // colour, the middle distance flattens toward the air, the far one is
      // a silhouette in it. Quantized with the same banded dither as the
      // colour, so the planes step rather than smear
      // From the air, a ray looking down crosses the thin top of the haze
      // and a ray along the ground crosses all of it: the optical depth of
      // an exponential layer between the two heights, per unit of range
      float optical = range;
      if (uAirLift.z > 0.0) {
        float hc = max(uCamPos.y - uAirLift.x, 0.0) / uAirLift.y;
        float hp = max(wp.y - uAirLift.x, 0.0) / uAirLift.y;
        float dh = hc - hp;
        float f = abs(dh) < 1e-3 ? exp(-hc) : (exp(-hp) - exp(-hc)) / dh;
        optical = range * mix(1.0, f, uAirLift.z);
      }
      float air = 1.0 - exp(-max(0.0, optical - uAir.x) / uAir.y);
      if (uAir.w > 0.5) air = band(air, uAir.w, bayer(p + ivec2(1, 3)), 0.25);
      air *= uAir.z;
      // ...and where the world ends, the air has all of it
      if (uAirLift.w > 0.0) air = max(air, smoothstep(uAirLift.w * 0.45, uAirLift.w, range));
      airAll = air;
      float toward = max(dot(dirW, uSunDir), 0.0);
      vec3 airCol = uAirCol + uSunGlow * pow(toward, 6.0);
      col = mix(col, airCol, air);

      // the silhouette's ink goes on *after* the air, so a roofline a block
      // away keeps its line instead of having it hazed off with the wall.
      // Against the sky it is inked harder and fades less with the fog:
      // that edge is the shape, and it is the one Lethal's ink carries
      float farZ = uClip.y * 0.98;
      bool skyBehind = max(max(zl, zr), max(zu, zd)) > farZ;
      // The floor on that fade is only for things the fog has not eaten: a
      // roofline the fog has fully swallowed kept 55% of its ink and drew a
      // ghost skyline on the empty haze. It follows how much of the thing
      // is still there to see, both to the scene fog and to the air
      float seen = uFog.z > 0.5 ? 1.0 - smoothstep(uFog.x, uFog.y, zc) : 1.0;
      float silK = skyBehind
        ? min(0.92, uEdge.x * 1.5) * max(fogK, 0.6 * smoothstep(0.0, 0.45, seen))
        : uEdge.x * fogK;
      // a light has no ink: the physgun's beam is a glow, not an object
      silK *= 1.0 - smoothstep(0.7, 0.97, air);
      // and a rim the air has taken most of carries no line against the
      // sky: inked, the far edge of the world read as the lip of a bowl
      // Distance takes the line too, whatever the air says: a ridge a few
      // hundred metres off inked against the sky is the lip of a bowl
      if (skyBehind) silK *= (1.0 - smoothstep(0.3, 0.7, air)) * (1.0 - smoothstep(90.0, 260.0, range));
      col *= 1.0 - sil * silK * (1.0 - emits);
    } else {
      // ---- the sky, tied to the air --------------------------------------
      float toward = max(dot(dirW, uSunDir), 0.0);
      // the sky's glow toward the sun is broader than the air's: at dusk it
      // is the warm side of the sky, and the only warm thing up there
      vec3 airCol = uAirCol + uSunGlow * pow(toward, 3.0);
      float low = 1.0 - smoothstep(0.0, uSkyAir.y, dirW.y);
      float pull = clamp(uSkyAir.x * low + uSkyAir.z, 0.0, 1.0);
      // from the air, the sky seen under the horizon (past the world's rim)
      // is the rim's own colour: all air
      // Gradually, over the dip from the geometric horizon down to the rim:
      // a step here drew a pale band with a ruler-straight top edge across
      // every high view, the clouds sliced off flat along it
      if (uAirLift.w > 0.0) pull = max(pull, uAirLift.z * smoothstep(0.16, -0.04, dirW.y));
      col = mix(col, airCol, pull);
    }

    // ---- lamp halos: the air lit around each lamp ----------------------
    // the closest approach of this pixel's ray to the lamp, before the ray
    // hits anything, is how much of the lamp's lit air it passes through
    if (uPoolCount > 0 && uHalo.x > 0.0) {
      float reach = sky ? 1e6 : range;
      float glow = 0.0;
      for (int i = 0; i < ${MAX_POOLS}; i++) {
        if (i >= uPoolCount) break;
        vec3 toL = uPools[i].xyz - uCamPos;
        float t = clamp(dot(toL, dirW), 0.0, reach);
        vec3 off = toL - dirW * t;
        glow += exp(-dot(off, off) / (uHalo.y * uHalo.y));
      }
      // jittered like the pools, or a halo in the sky (which bands with no
      // dithered seam at all) posterizes into a stack of hard rings
      glow *= 1.0 + (bayer(p + ivec2(1, 2)) - 0.5) * 0.9;
      col += uPoolCol * glow * uHalo.x;
    }
    // ...and the flash's, a ball of lit air a third of its radius across
    if (uFlash.w > 0.0) {
      float reach = sky ? 1e6 : range;
      vec3 toL = uFlash.xyz - uCamPos;
      float t = clamp(dot(toL, dirW), 0.0, reach);
      vec3 off = toL - dirW * t;
      float r = uFlash.w * 0.3;
      col += uFlashCol * 0.18 * exp(-dot(off, off) / (r * r));
    }

    // ---- tone and grade -------------------------------------------------
    vec3 disp = toSrgb(aces(col));
    vec3 lutUv = disp * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    vec3 graded = mix(texture(tLutA, lutUv).rgb, texture(tLutB, lutUv).rgb, uMood);
    disp = mix(disp, graded, uGrade * (1.0 - emits));


    // ---- banded posterize, in OKLab ------------------------------------
    // Lightness and chroma quantize separately: the lightness steps are the
    // visible bands, the chroma grid is the palette. Grain goes in first, so
    // it lives on the band edges (where a real posterized image flickers)
    // rather than as noise over flat colour
    vec3 lab = oklab(toLinear(disp));
    if (sky || airAll > 0.985) {
      // (a pixel that is nothing but air bands with it, or the rim of the
      // world is a seam of dithered checker against the sky beside it)
      // The sky bands clean: more steps, no dithered seam, no grain and its
      // own chroma untouched. A cloud is a soft gradient over a large area,
      // and the ground's treatment turned every one into a blotch with a
      // dithered halo round it
      if (uPost.x > 0.5) lab.x = band(lab.x, uPost.x * 1.6, 0.5, 0.0);
    } else if (uPost.x > 0.5) {
      lab.x += (hash(vec2(p) + fract(uFrame * 0.618) * 97.0) - 0.5) * uPost.w;
      lab.x = band(lab.x, uPost.x, bayer(p), uPost.z);
      // chroma in polar form: the hue stays where it is and only its
      // strength steps. A square a/b grid put every near-grey (a wall, a
      // road, a cloud) right on a bin edge at half a step off neutral, and
      // dithered it into a checker. The grid is fine enough that a muted
      // colour keeps its hue: only what is under half a step goes grey (an
      // earlier dead zone here rounded a whole grey-ish downtown to 0)
      float t2 = bayer(p.yx + ivec2(2, 1));
      float C = length(lab.yz);
      float Cq = band(C, 1.0 / uPost.y, t2, uPost.z);
      lab.yz *= C > 1e-5 ? Cq / C : 0.0;
    }
    disp = toSrgb(clamp(fromOklab(lab), 0.0, 1.0));

    // vignette, after the posterize: banded, a vignette is a set of rings
    // drawn on the sky, and unbanded it is only the corners going dim
    vec2 uv = gl_FragCoord.xy / uRes - 0.5;
    disp *= 1.0 - uVignette * smoothstep(0.35, 1.1, dot(uv, uv) * 2.2);

    // premultiplied, as the canvas composites it. Always opaque: the holes
    // are the punch pass's business now
    outColor = vec4(disp * a, a);
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

/*
  The punch: a glass hole's own mesh, drawn at the canvas's full resolution
  after the upscale, writing the hole's tint straight into the canvas. It
  depth-tests by hand against the look's low-resolution depth, so whatever
  stands in front of the screen (a hand, a chair back) still covers it, at
  the look's own chunky resolution, while the glass's outline is exact.
*/
export const PUNCH_VERT = /* glsl */ `
  in vec3 position;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const PUNCH_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;

  uniform sampler2D tDepth;
  uniform vec4 uMap;
  uniform vec2 uClip;
  uniform float uAlpha;

  out vec4 outColor;

  float lin(float d) {
    return (uClip.x * uClip.y) / (uClip.y - (uClip.y - uClip.x) * d);
  }

  void main() {
    ivec2 p = ivec2((gl_FragCoord.xy - uMap.xy) * uMap.zw);
    float d = texelFetch(tDepth, clamp(p, ivec2(0), textureSize(tDepth, 0) - 1), 0).x;
    // linear, with a hand's width of slack: the chunky texel on the glass's
    // rim may have seen the bezel a few centimetres in front of it, and that
    // must not notch the edge back in. Anything nearer than that is really
    // in front of the screen, and covers it
    if (lin(d) < lin(gl_FragCoord.z) - 0.2) discard;
    outColor = vec4(0.0, 0.0, 0.0, uAlpha);
  }
`
