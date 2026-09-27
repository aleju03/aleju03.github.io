import * as THREE from 'three'
import { CHUNK, OFF_X, OFF_Z, chunkX, chunkZ, originX, originZ } from './grid'
import { groundSample, heightAt, SEA_Y } from './terrain'
import { nearestTown, placeAt, townsNear, type District, type Town } from './settlements'
import { liveOf, networkOf, parcelsInChunk, prepareTown, SPINE_REACH } from './streets'
import type { BuildKind } from './buildings'
import { BIOMES, type BiomeId } from './biomes'
import { hash2 } from './noise'
import { FIELDS_GLSL } from './groundLook'
import { gfx } from './quality'

/*
  The far field: the planet past the loaded ring, for anyone looking at it
  from the air.

  The streamed ring is a few hundred units across and built for a walker,
  which is right on the ground and a white wall from a helicopter: at a
  hundred units up most of the frame used to be fog, because the fog had to
  hide the ring's edge. This module draws everything past that edge, out to
  a few kilometres, cheaply enough to leave on:

  - **terrain** as nested square rings of tiles, each ring's cells twice the
    size of the one inside it (8, 16, 32, 64 units; `gfx.farLevels` decides
    how many), a 5x5 of tiles per ring centred on the camera's tile. Heights
    are `heightAt`, the same field the chunk lattice caches, so a far vertex
    that lands on a lattice point *is* the lattice point; colours are
    `groundSample`, the same rules the chunk ground bakes. The sea is the
    same mesh held flat at the waterline, with the depth under it kept as an
    attribute so the shader can band it and draw a one-pixel foam line at
    the shore. Streets, in town and on the roads out, are strips laid off
    the town's plan (streets.ts), and forests get a canopy of lit crowns,
    because the loaded ring's real trees stop three chunks out.
  - **towns** as impostors: every platted lot of every district, off the
    same parcel list `chunk.ts`'s buildBlock builds from, as boxes with a
    gable on a house, windows drawn by the shader and lit at night. Merged
    into the tile's one geometry, so a tile is one draw. A tile grows the
    plans of the towns near it a slice at a time before it samples any
    height (streets.ts's prepareTown), so meeting a new city from the air
    never costs its whole plan in one frame.

  Three rules keep it seamless.

  **Nothing is drawn twice.** One material (one program) draws every tile of
  every ring and discards two things per fragment: whatever lies inside the
  next-finer ring's square (`uHole`), and any chunk the streamer has built
  and finished fading in (`uMask`, a 16x16 texel-per-chunk mask around the
  camera). A chunk dissolving in over its birth fade therefore dithers
  across the far field under it rather than over a hole, and the far field
  is gone from under it the moment it is solid.

  **No crack between rings.** A ring's outer edge is where the next one's
  hole begins, and its every other edge vertex has no partner in the coarser
  ring. So each vertex carries the height its edge would have in the coarser
  ring (`aExt.y`, the mean of its two neighbours along the edge), and the
  vertex shader uses it whenever the vertex lies on its ring's committed
  square: the two edges are then the same polyline, exactly.

  **A ring moves atomically.** When the camera crosses into a new tile, the
  ring's new 5x5 is built in the background (time-boxed slices, a row of
  samples at a time) while the old one keeps drawing, and is swapped in
  whole. A ring only swaps if its square still contains the finer ring's and
  sits inside the coarser one's, which is what keeps the holes nested.

  Leaving the planet (levels/space.ts), the same program bends every tile
  onto the planet's curve about the eye (`uCurve`, a parabola that
  world/globe.ts's sphere continues past the rim) and dithers the whole
  field out over the globe (`uFarFade`), so orbit is two uniforms, not a
  new program.

  Cost, measured: see `npm run measure -- far`.
*/

/** tile edge per ring, in units: a 5x5 of these is a ring */
const TILE = [256, 512, 1024, 2048]
/** cells per tile edge */
const N = 32
/** tiles either side of the centre tile */
const SPAN = 2
/** the chunk mask's edge, in chunks, centred on the camera's chunk */
const MASK = 16
/** how many rings carry town impostors, and of what: the first all of a
    town, the second its midrise and downtown, the third only the towers
    (blockImpostors). Past that, and under each cut, the ground shader
    paints the blocks as roofs */
const IMPOSTOR_LEVELS = 3

export interface FarField {
  /** parented to the streamer's root */
  root: THREE.Group
  /**
   * Recentre the rings on the camera and refresh the chunk mask. `ready`
   * answers whether a chunk's own ground is built and fully faded in there
   */
  update: (
    x: number, z: number, alt: number, ready: (cx: number, cz: number) => boolean, epoch: number,
  ) => void
  /** build queued tile slices for up to `ms` milliseconds; returns the time spent */
  work: (ms: number) => number
  /** how far from (x, z) the committed rings reach without a gap, or 0 */
  reach: (x: number, z: number) => number
  /** true once every ring has committed a full square */
  readonly complete: boolean
  readonly visible: boolean
  readonly pending: number
  /** night 0..1: the impostors' windows */
  setNight: (n: number) => void
  /** leaving the planet (levels/space.ts): bend by `curve` (1 / 2R, 0 flat)
      about the eye, and dither out to `fade` (1 drawn, 0 gone) */
  setSpace: (curve: number, eyeX: number, eyeZ: number, fade: number) => void
  /** meshes, vertices and tiles currently drawn, for the harness */
  stats: () => { tiles: number; verts: number; tris: number }
  dispose: () => void
}

/* ------------------------------------------------------------ material -- */

const FAR_VERT_HEAD = /* glsl */ `
  attribute vec4 aFar;
  attribute vec3 aExt;
  attribute vec3 aLeaf;
  attribute vec2 aOwn;
  uniform vec4 uRect[4];
  uniform float uCurve;
  uniform vec2 uEye;
  varying vec3 vFarW;
  varying vec4 vFar;
  varying float vDepth;
  varying vec3 vLeaf;
  varying float vFarNY;
  varying float vField;
  varying vec2 vMaskP;
`
const FAR_VERT_BODY = /* glsl */ `
  vFar = aFar;
  vFarNY = normal.y;
  vDepth = aExt.x;
  vField = aExt.z;
  vLeaf = aLeaf;
  // a ground vertex on its own ring's committed square takes the height the
  // coarser ring draws there, so the two edges are one polyline
  if (aFar.x < 0.5) {
    vec4 r = uRect[int(aFar.y + 0.5)];
    if (abs(transformed.x - r.x) < 0.5 || abs(transformed.x - r.z) < 0.5 ||
        abs(transformed.z - r.y) < 0.5 || abs(transformed.z - r.w) < 0.5) {
      transformed.y = aExt.y;
    }
  }
  vFarW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  // where the chunk mask is read: a building's impostor asks about the chunk
  // that builds the real one (see Soup.own), everything else about itself
  vMaskP = aOwn.x > 1e8 ? vFarW.xz : aOwn;
  // from high up the ground bends onto the planet (levels/space.ts): a
  // parabola in the distance from the camera, which world/globe.ts's sphere
  // continues past the rim. vFarW keeps the unbent height for the patterns
  if (uCurve > 0.0) {
    vec2 cd = vFarW.xz - uEye;
    transformed.y -= uCurve * dot(cd, cd);
  }
`

const FAR_FRAG_HEAD = /* glsl */ `
  uniform sampler2D uMask;
  uniform vec2 uMaskO;
  uniform vec4 uHole[4];
  uniform vec3 uWater;
  uniform float uNight;
  uniform float uFarFade;
  varying vec3 vFarW;
  varying vec4 vFar;
  varying float vDepth;
  varying vec3 vLeaf;
  varying float vFarNY;
  varying float vField;
  varying vec2 vMaskP;
  ${FIELDS_GLSL}
  float farHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float farNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(farHash(i), farHash(i + vec2(1.0, 0.0)), f.x),
               mix(farHash(i + vec2(0.0, 1.0)), farHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`

/** discard what a finer ring or a built chunk already draws */
const FAR_FRAG_CLIP = /* glsl */ `
  {
    // leaving the planet: the ground dithers out over the globe under it,
    // one ordered-dither threshold per pixel of the look's target
    if (uFarFade < 0.999) {
      ivec2 dq = ivec2(mod(floor(gl_FragCoord.xy), 4.0));
      float dm[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
      if ((dm[dq.y * 4 + dq.x] + 0.5) / 16.0 >= uFarFade) discard;
    }
    vec4 hr = uHole[int(vFar.y + 0.5)];
    if (vFarW.x > hr.x && vFarW.x < hr.z && vFarW.z > hr.y && vFarW.z < hr.w) discard;
    vec2 cc = floor((vMaskP - vec2(${OFF_X.toFixed(2)}, ${OFF_Z.toFixed(2)})) / ${CHUNK.toFixed(1)}) - uMaskO;
    if (cc.x >= 0.0 && cc.y >= 0.0 && cc.x < ${MASK.toFixed(1)} && cc.y < ${MASK.toFixed(1)}) {
      if (texelFetch(uMask, ivec2(cc), 0).r > 0.5) discard;
    }
  }
`

/*
  The far field's surface, in the look's terms: flat bands and one-pixel
  lines. Every pattern knows how many world units a pixel covers here
  (`px`) and hands itself to its own average before it would alias, so a
  street grid or a window grid two kilometres off is a tone, not moire.
*/
const FAR_FRAG_COLOR = /* glsl */ `
  vec3 farN = vec3(0.0);
  float farHit = 0.0;
  float farLit = 0.0;
  {
    vec3 fw = fwidth(vFarW);
    float px = max(max(fw.x, fw.z), 1e-3);
    if (vFar.x < 0.5) {
      if (vDepth > 0.0) {
        // the sea in three flat shelves, lighter where it is shallow, and a
        // foam line one pixel wide where it meets the land
        // the same shelves the near sea draws (streamer.ts), out to the
        // horizon: reef, shelf, slope, and the open sea past the drop-off
        float jd = vDepth + (farHash(floor(vFarW.xz * 0.25)) - 0.5) * 1.2;
        float sh = jd < 1.1 ? 1.0 : jd < 3.0 ? 0.62 : jd < 7.0 ? 0.32 : jd < 14.0 ? 0.1 : 0.0;
        diffuseColor.rgb = uWater * mix(vec3(1.0), vec3(1.45, 2.05, 1.85), sh) * (jd > 14.0 ? 0.7 : 1.0) + 0.02 * sh;
      }
      if (vDepth <= 0.0 && vFar.z < 0.5) {
        // what the chunk ground (groundLook.ts) draws by geometry alone, so
        // the ring and the far field agree from the air: cliffs are stone,
        // and every gentle shore has a beach
        float h = -vDepth;
        float j = (farHash(floor(vFarW.xz * 0.5)) - 0.5) * 0.3;
        bool cliff = vFarNY < 0.8 + j * 0.1;
        if (cliff) diffuseColor.rgb = diffuse * vec3(0.12, 0.115, 0.108);
        if (cliff || vFar.w < -0.5) {
          // stone reads as stone from a kilometre off by its strata: dark
          // courses a few units apart, fading to their tone past a pixel,
          // or a cliff band is a grey stripe the eye takes for haze
          float sy = fract(vFarW.y / 5.0 + farHash(floor(vFarW.xz / 24.0)) * 0.6);
          float sw = clamp(fwidth(vFarW.y) / 5.0, 0.01, 0.5);
          float line = smoothstep(0.42 - sw, 0.42 + sw, abs(sy - 0.5));
          // ...and gullies down the face, a few units wide, which survive
          // the distance the strata do not: a cliff band a kilometre off
          // read as a pale stripe of haze until it had them
          float gully = step(0.56, farNoise(vec2((vFarW.x + vFarW.z) / 7.0, vFarW.y / 30.0)));
          diffuseColor.rgb *= (0.76 - 0.3 * line) * (1.0 - 0.25 * gully);
        }
        else if (h + j < 1.4) diffuseColor.rgb = diffuse * vec3(0.54, 0.45, 0.23) * (h < 0.55 ? 0.72 : 1.0);
        if (vFar.w < -1.5 && !cliff) {
          // snow country: bare rock breaks through on every slope and ridge,
          // in streaks down the fall line, or a range is one white sheet
          float streak = farNoise(vec2((vFarW.x - vFarW.z) / 11.0, vFarW.y / 40.0));
          float bare = step(0.5, streak + (0.95 - vFarNY) * 4.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * vec3(0.16, 0.15, 0.15), bare);
        }
      }
      if (vDepth <= 0.0 && vFar.z < 0.5 && vField > 0.05 && vFarNY > 0.93 && -vDepth > 1.6) {
        // farmland (groundLook.ts's FIELDS_GLSL), the same fields the chunk
        // ground draws, so they run on across the ring's edge
        float hedgeK;
        vec4 fd = fields(vFarW.xz, px, hedgeK);
        float on = step(0.5, vField + 0.35);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * fd.rgb, fd.a * on);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * vec3(0.07, 0.13, 0.05), hedgeK * on);
      }
      float dw = fwidth(vDepth);
      float foam = 1.0 - smoothstep(0.0, dw * 1.3 + 0.02, abs(vDepth));
      float surf = 1.0 - smoothstep(0.0, dw * 1.0 + 0.02, abs(vDepth - 1.6));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.95, 0.96), max(foam, surf * 0.55 * step(0.0, vDepth)));
      if (vDepth <= 0.0 && vFar.z > 0.01) {
        // Past the rings that carry impostors, a town's lots are painted: a
        // roof per lot in the district's colours, at the district's lot size.
        // The streets are real strips now (townRoads), laid over the paint,
        // so it needs no street grid of its own, and its lattice is simply
        // world-aligned: at a kilometre only the tone of the roofs reads
        float code = floor(vFar.z + 0.5);
        int lv = int(vFar.y + 0.5);
        bool paint = (code == 1.0 && lv >= 1) || (code == 2.0 && lv >= 2) || (code == 3.0 && lv >= 3);
        if (paint) {
          float lotS = code == 1.0 ? 19.0 : code == 2.0 ? 27.0 : 42.0;
          vec2 cellW = vFarW.xz / lotS;
          vec2 li = floor(cellW);
          vec2 lf = cellW - li;
          float hh = farHash(li * 7.0 + 3.0);
          float fill = code == 1.0 ? 0.3 : code == 2.0 ? 0.4 : 0.43;
          vec2 e = abs(lf - 0.5);
          float keep = step(hh, code == 1.0 ? 0.72 : 0.88);
          float inside = step(max(e.x, e.y), fill) * keep;
          float rd = 1.0 - smoothstep(0.5, 1.2, px / (lotS * fill));
          float cover = mix(fill * fill * 4.0 * 0.8, inside, rd);
          vec3 roof = code == 1.0
            ? (hh < 0.3 ? vec3(0.4, 0.12, 0.07) : hh < 0.5 ? vec3(0.2, 0.12, 0.08) : hh < 0.7 ? vec3(0.12, 0.13, 0.15) : vec3(0.26, 0.24, 0.21))
            : code == 2.0 ? vec3(0.15, 0.14, 0.13) : vec3(0.1, 0.1, 0.11);
          // a suburb roof has a ridge: its two slopes in two tones
          if (code == 1.0) roof *= mix(1.0, (hh > 0.5 ? lf.x : lf.y) < 0.5 ? 1.0 : 0.72, rd);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * roof, cover);
          farLit += uNight * cover * (code == 1.0 ? 0.05 : 0.09);
        }
      }
      if (vDepth <= 0.0 && vFar.w > 0.01) {
        // a canopy: one crown per 8-unit cell where the biome's tree count
        // says there is one, domed so the sun lights one side of it
        vec2 q = vFarW.xz / 8.0;
        vec2 ci = floor(q);
        float detail = 1.0 - smoothstep(0.35, 0.8, px / 8.0);
        if (detail > 0.0) {
          float best = 1e9;
          // stands and clearings: the biome's density, swung by a slow noise
          // so a wood is clumped rather than planted on a grid
          float dens = vFar.w * (0.45 + 1.1 * farNoise(vFarW.xz / 46.0));
          for (int y = -1; y <= 1; y++)
            for (int x = -1; x <= 1; x++) {
              vec2 c = ci + vec2(float(x), float(y));
              if (farHash(c) > dens) continue;
              float r = 0.34 + 0.26 * farHash(c + 7.13);
              vec2 ctr = c + 0.5 + (vec2(farHash(c + 3.1), farHash(c + 5.7)) - 0.5) * 0.85;
              vec2 dd = q - ctr;
              float k = dot(dd, dd) / (r * r);
              if (k < 1.0 && k < best) {
                best = k;
                farN = normalize(vec3(dd.x / r, sqrt(1.0 - k) * 1.1, dd.y / r));
              }
            }
          // a forest floor is in the crowns' shade; a crown carries a rim
          // of ink where it rounds away, which is what makes a blob of
          // green read as a tree from above rather than as a stain
          vec3 floorC = diffuseColor.rgb * mix(1.0, 0.5, clamp(dens, 0.0, 1.0));
          vec3 crownC = vLeaf * mix(0.82, 0.45, smoothstep(0.6, 0.8, best));
          diffuseColor.rgb = mix(diffuseColor.rgb, best < 1.0 ? crownC : floorC, detail);
          if (best < 1.0) farHit = detail * step(best, 0.62);
        }
        // past the point a crown is a pixel, the canopy is a flat tone
        // with stands and gaps in it at a scale that survives distance, or
        // a forest four kilometres off is a flat green felt
        float stand = farNoise(vFarW.xz / 28.0) * 0.6 + farNoise(vFarW.xz / 9.0) * 0.4;
        diffuseColor.rgb = mix(diffuseColor.rgb, vLeaf * (0.5 + 0.45 * stand), (1.0 - detail) * vFar.w * 0.9);
      }
    } else if (vFar.x < 1.5) {
      // a wall: windows on a floor grid, glass by day, some lit by night
      vec3 fn = normalize(cross(dFdx(vFarW), dFdy(vFarW)));
      float u = abs(fn.x) > 0.5 ? vFarW.z : vFarW.x;
      float office = step(0.5, vFar.z);
      vec2 cell = vec2(mix(3.2, 2.4, office), mix(3.0, 3.4, office));
      vec2 wv = vec2(u, vFarW.y) / cell;
      vec2 f = fract(wv);
      float win = step(0.26, f.x) * step(f.x, mix(0.7, 0.82, office)) * step(0.34, f.y) * step(f.y, 0.82);
      float detail = 1.0 - smoothstep(0.3, 0.6, px / cell.x);
      float share = mix(0.18, 0.4, office);
      float glass = mix(share, win, detail);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.04, 0.05), glass * 0.85);
      // a third of the windows are lit; once a window is under a pixel the
      // wall keeps only their share of the glow, or a far block at night
      // is one lit slab
      float on = step(farHash(floor(wv) + vFar.w), 0.34);
      farLit = uNight * mix(share * 0.035, win * on, detail);
    } else if (abs(vFar.z) > 0.001) {
      // a street strip (townRoads): z runs -1..1 across it and w is the arc
      // length along it, so the night's lamps are a dot every 24 units at
      // the kerb, the dots a town is made of from the air after dark
      float wlamp = 0.6 + px * 0.5;
      float kerb = (1.0 - abs(vFar.z)) * 3.4;
      float lamp = (1.0 - smoothstep(0.0, wlamp, abs(mod(vFar.w, 24.0) - 12.0))) *
        (1.0 - smoothstep(0.0, wlamp, kerb));
      farLit += uNight * lamp * 1.3;
    }
  }
`
const FAR_FRAG_NORMAL = /* glsl */ `
  if (farHit > 0.0) normal = normalize(mix(normal, (viewMatrix * vec4(farN, 0.0)).xyz, farHit));
`
const FAR_FRAG_EMISSIVE = /* glsl */ `
  totalEmissiveRadiance += farLit * vec3(2.4, 1.6, 0.8);
`

interface FarUniforms {
  uMask: { value: THREE.DataTexture }
  uMaskO: { value: THREE.Vector2 }
  uHole: { value: THREE.Vector4[] }
  uRect: { value: THREE.Vector4[] }
  uWater: { value: THREE.Color }
  uNight: { value: number }
  uCurve: { value: number }
  uEye: { value: THREE.Vector2 }
  uFarFade: { value: number }
}

const makeFarMaterial = (u: FarUniforms) => {
  // the same grey the chunk detail soup multiplies by: the chunk ground's
  // detail map averages a little under white, so this is the match for it
  const mat = new THREE.MeshLambertMaterial({ color: 0xe0e0e0, vertexColors: true })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FAR_VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FAR_VERT_BODY}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FAR_FRAG_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FAR_FRAG_CLIP}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FAR_FRAG_COLOR}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${FAR_FRAG_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FAR_FRAG_EMISSIVE}`)
  }
  mat.customProgramCacheKey = () => 'far-field-3'
  return mat
}

/* ------------------------------------------------------------ geometry -- */

/** growable typed arrays for one tile's merged geometry */
class Soup {
  pos: number[] = []
  nor: number[] = []
  col: number[] = []
  far: number[] = []
  ext: number[] = []
  leaf: number[] = []
  own: number[] = []
  idx: number[] = []
  /** the point whose chunk decides whether this geometry is drawn: unset
      (1e9) means the vertex's own. A lot can straddle a chunk border now, and
      the chunk its centre is in builds the real building, so its impostor has
      to disappear exactly when *that* chunk is up, not piecewise wherever a
      neighbour is: at the edge of the ring that drew half a ghost box round
      a real tower */
  ownX = 1e9
  ownZ = 1e9
  get count() {
    return this.pos.length / 3
  }
  vert(
    x: number, y: number, z: number, nx: number, ny: number, nz: number,
    c: THREE.Color, kind: number, level: number, a: number, b: number,
    depth = 0, stitch = y, leaf?: THREE.Color, field = 0,
  ) {
    this.pos.push(x, y, z)
    this.nor.push(nx, ny, nz)
    this.col.push(c.r, c.g, c.b)
    this.far.push(kind, level, a, b)
    this.ext.push(depth, stitch, field)
    if (leaf) this.leaf.push(leaf.r, leaf.g, leaf.b)
    else this.leaf.push(0, 0, 0)
    this.own.push(this.ownX, this.ownZ)
  }
  /** a flat quad from four corners wound counter-clockwise seen from outside */
  quad(
    p: number[][], n: [number, number, number], c: THREE.Color,
    kind: number, level: number, a: number, b: number,
  ) {
    const o = this.count
    for (const v of p) this.vert(v[0], v[1], v[2], n[0], n[1], n[2], c, kind, level, a, b)
    this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3)
  }
  tri(
    p: number[][], n: [number, number, number], c: THREE.Color,
    kind: number, level: number,
  ) {
    const o = this.count
    for (const v of p) this.vert(v[0], v[1], v[2], n[0], n[1], n[2], c, kind, level, 0, 0)
    this.idx.push(o, o + 1, o + 2)
  }
  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('aFar', new THREE.Float32BufferAttribute(this.far, 4))
    g.setAttribute('aExt', new THREE.Float32BufferAttribute(this.ext, 3))
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.leaf, 3))
    g.setAttribute('aOwn', new THREE.Float32BufferAttribute(this.own, 2))
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

/** how much canopy a biome carries: its trees per chunk over one per 8-unit cell */
const TREE_KINDS = new Set(['broadleaf', 'birch', 'pine', 'palm', 'acacia', 'deadtree'])
const CANOPY: Partial<Record<BiomeId, number>> = {}
const LEAF: Partial<Record<BiomeId, THREE.Color>> = {}
for (const [id, b] of Object.entries(BIOMES) as Array<[BiomeId, (typeof BIOMES)[BiomeId]]>) {
  let n = 0
  for (const s of b.flora) if (TREE_KINDS.has(s.kind)) n += s.per
  // ...and scrub counts for a little: open country with no trees at all
  // reads from the air as a flat camouflage of its two ground tints, and a
  // sprinkle of bushes is what makes it read as land
  for (const s of b.flora) if (s.kind === 'bush' || s.kind === 'shrub') n += s.per * 0.35
  CANOPY[id] = Math.min(0.92, n / 64)
  LEAF[id] = new THREE.Color(b.pal.leaf).multiplyScalar(0.92)
}

/* ------------------------------------------------------------ impostors -- */

const hex = (s: string) => new THREE.Color(s)
const WALLS: Record<District, THREE.Color[]> = {
  suburb: ['#d3ccbb', '#c4b595', '#b9aa92', '#a7b0ae', '#cdbf9f'].map(hex),
  midrise: ['#8b5f48', '#9a7057', '#7f6b5c', '#a4937b', '#86776a'].map(hex),
  downtown: ['#8a9298', '#727f8a', '#a3a49c', '#5f6d78', '#94907f'].map(hex),
}
const ROOFS: Record<District, THREE.Color[]> = {
  suburb: ['#7a4331', '#5a4a44', '#6e6458', '#8a4c34', '#4f5358'].map(hex),
  midrise: ['#4c4740', '#57524a', '#4a4f52'].map(hex),
  downtown: ['#4a4f52', '#55585a', '#43403a'].map(hex),
}

const imp = new THREE.Color()

/**
 * One building as far geometry: a box of walls, and either a flat roof or a
 * gable along its longer side.
 */
const building = (
  s: Soup, level: number, x: number, z: number, w: number, d: number,
  y0: number, h: number, gable: number, wall: THREE.Color, roof: THREE.Color,
  office: number, seed: number,
) => {
  const x0 = x - w / 2
  const x1 = x + w / 2
  const z0 = z - d / 2
  const z1 = z + d / 2
  const y1 = y0 + h
  imp.copy(wall)
  // walls: kind 1, windows on them
  s.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], imp, 1, level, office, seed)
  s.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], imp, 1, level, office, seed)
  s.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], imp, 1, level, office, seed)
  s.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], imp, 1, level, office, seed)
  if (gable <= 0) {
    s.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], roof, 2, level, 0, 0)
    return
  }
  const alongX = w >= d
  const ry = y1 + gable
  if (alongX) {
    const nz = gable / Math.hypot(gable, d / 2)
    const ny = (d / 2) / Math.hypot(gable, d / 2)
    s.quad([[x0, y1, z1], [x1, y1, z1], [x1, ry, z], [x0, ry, z]], [0, ny, nz], roof, 2, level, 0, 0)
    s.quad([[x1, y1, z0], [x0, y1, z0], [x0, ry, z], [x1, ry, z]], [0, ny, -nz], roof, 2, level, 0, 0)
    s.tri([[x1, y1, z1], [x1, y1, z0], [x1, ry, z]], [1, 0, 0], imp, 1, level)
    s.tri([[x0, y1, z0], [x0, y1, z1], [x0, ry, z]], [-1, 0, 0], imp, 1, level)
  } else {
    const nx = gable / Math.hypot(gable, w / 2)
    const ny = (w / 2) / Math.hypot(gable, w / 2)
    s.quad([[x1, y1, z1], [x1, y1, z0], [x, ry, z0], [x, ry, z1]], [nx, ny, 0], roof, 2, level, 0, 0)
    s.quad([[x0, y1, z0], [x0, y1, z1], [x, ry, z1], [x, ry, z0]], [-nx, ny, 0], roof, 2, level, 0, 0)
    s.tri([[x0, y1, z1], [x1, y1, z1], [x, ry, z1]], [0, 0, 1], imp, 1, level)
    s.tri([[x1, y1, z0], [x0, y1, z0], [x, ry, z0]], [0, 0, -1], imp, 1, level)
  }
}

/** kit heights the lot's `height` does not describe */
const shapeOf = (kind: BuildKind, height: number, w: number, d: number) => {
  switch (kind) {
    case 'house': return { h: 4.4, gable: Math.min(w, d) * 0.32 }
    case 'shop': return { h: 6.2, gable: 0 }
    case 'warehouse': return { h: 9, gable: Math.min(w, d) * 0.12 }
    case 'chapel': return { h: 9.5, gable: Math.min(w, d) * 0.3 }
    case 'parking': return { h: 12, gable: 0 }
    default: return { h: Math.max(8, height), gable: 0 }
  }
}

/**
 * A chunk's buildings as impostors, off the same platted lots `chunk.ts`
 * builds (streets.ts's parcels, one list per town): the same footprint,
 * facing, kind and height, so the replay is exact by construction rather
 * than by re-drawing a seeded sequence in step. Only the ground under a
 * footprint is sampled differently (corners of the far terrain rather than
 * the chunk's lattice), so a lot on a slope the chunk refuses can still
 * stand here. From where anyone sees these, that is the same skyline.
 */
const blockImpostors = (
  s: Soup, level: number, cx: number, cz: number, ground: (x: number, z: number) => number,
) => {
  const mx = originX(cx) + CHUNK / 2
  const mz = originZ(cz) + CHUNK / 2
  const base = (bx: number, bz: number, w: number, d: number) => {
    let lo2 = Infinity
    let hi = -Infinity
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const y = ground(bx + sx * w / 2, bz + sz * d / 2)
      lo2 = Math.min(lo2, y)
      hi = Math.max(hi, y)
    }
    return [lo2, hi] as const
  }
  for (const t of townsNear(mx, mz)) {
    if (Math.hypot(t.x - mx, t.z - mz) > t.radius * 1.35 + 100) continue
    for (const p of parcelsInChunk(t, cx, cz)) {
      if (p.use !== 'build' || p.cx !== cx || p.cz !== cz) continue
      const district = p.district
      // the second ring only keeps what stands up out of the ground colour
      if (level > 0 && district === 'suburb') continue
      if (level > 1 && district !== 'downtown') continue
      const block = p.kind === 'warehouse' || p.kind === 'chapel' || p.kind === 'parking'
      const [y0, y1] = base(p.x, p.z, p.w, p.d)
      if (y0 < SEA_Y + 1 || y1 - y0 > (block ? 3 : 2.2)) continue
      const walls = WALLS[district]
      const roofs = ROOFS[district]
      const sh = shapeOf(p.kind, p.height, p.w, p.d)
      const k = hash2(Math.round(p.x), Math.round(p.z), 0x51f3)
      s.ownX = p.x
      s.ownZ = p.z
      building(s, level, p.x, p.z, p.w, p.d, y0 - 0.5, sh.h + 0.5, sh.gable,
        walls[k % walls.length], roofs[(k >>> 8) % roofs.length],
        p.kind === 'house' ? 0 : district === 'suburb' ? 0 : 1, (k & 0xffff) / 97)
      s.ownX = 1e9
      s.ownZ = 1e9
    }
  }
}

/* ---------------------------------------------------------------- roads -- */

const ASPHALT = new THREE.Color('#2b2d31').multiplyScalar(1.1)

/**
 * The streets, as flat strips laid on the far terrain: every street of every
 * town near the tile, in town and on the roads out, straight off the plan
 * (streets.ts) rather than sampled. A strip goes down per step of each
 * segment whose middle is inside this tile and where the street is present
 * (roadAt's own rule: live, and belonging to the town that claims the
 * ground), following the tile's own height samples and lifted a little more
 * the coarser the ring.
 */
function* townRoads(
  s: Soup, level: number, x0: number, z0: number, S: number, cell: number,
  ground: (x: number, z: number) => number,
): Generator<void, void> {
  const lift = 0.4 + cell * 0.06
  const half = 3.4
  const step = Math.max(cell, 8)
  const x1 = x0 + S
  const z1 = z0 + S
  const towns = townsNear(x0 + S / 2, z0 + S / 2)
  const shared = towns.length > 1
  for (const t of towns) {
    const reach = t.radius * SPINE_REACH + 200
    const dx = Math.max(x0 - t.x, 0, t.x - x1)
    const dz = Math.max(z0 - t.z, 0, t.z - z1)
    if (Math.hypot(dx, dz) > reach) continue
    const net = networkOf(t)
    let n = 0
    for (const p of net.pieces) {
      if (p.bulb) continue
      const bx = p.ax + p.ux * p.len
      const bz = p.az + p.uz * p.len
      if (Math.max(p.ax, bx) < x0 - half || Math.min(p.ax, bx) > x1 + half ||
        Math.max(p.az, bz) < z0 - half || Math.min(p.az, bz) > z1 + half) continue
      const k = Math.max(1, Math.round(p.len / step))
      const nx = -p.uz * half
      const nz = p.ux * half
      for (let i = 0; i < k; i++) {
        const f0 = i / k
        const f1 = (i + 1) / k
        const mx = p.ax + p.ux * p.len * (f0 + f1) / 2
        const mz = p.az + p.uz * p.len * (f0 + f1) / 2
        if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue
        if (liveOf(p, p.len * (f0 + f1) / 2) < 0.35) continue
        if (shared && nearestTown(mx, mz) !== t) continue
        const ax = p.ax + p.ux * p.len * f0
        const az = p.az + p.uz * p.len * f0
        const ex = p.ax + p.ux * p.len * f1
        const ez = p.az + p.uz * p.len * f1
        const ya = Math.max(ground(ax, az), SEA_Y + 0.3) + lift
        const yb = Math.max(ground(ex, ez), SEA_Y + 0.3) + lift
        const o = s.count
        // across (-1..1) and arc length ride along for the night's lamps
        const sa = p.street.s[p.i] + p.len * f0
        const sb = p.street.s[p.i] + p.len * f1
        s.vert(ax - nx, ya, az - nz, 0, 1, 0, ASPHALT, 2, level, -1, sa)
        s.vert(ax + nx, ya, az + nz, 0, 1, 0, ASPHALT, 2, level, 1, sa)
        s.vert(ex - nx, yb, ez - nz, 0, 1, 0, ASPHALT, 2, level, -1, sb)
        s.vert(ex + nx, yb, ez + nz, 0, 1, 0, ASPHALT, 2, level, 1, sb)
        // wound to face up whichever way the street runs
        s.idx.push(o, o + 1, o + 3, o, o + 3, o + 2)
      }
      // a slice every so often: a city is a few thousand segments
      if ((++n & 255) === 255) yield
    }
  }
}

/* ---------------------------------------------------------------- tiles -- */

const tileCol = new THREE.Color()
const tileLeaf = new THREE.Color()

/**
 * One tile, as a resumable job: it yields after every few rows of samples so
 * the drain can stop between slices, and returns the finished geometry.
 */
function* tileJob(level: number, ti: number, tj: number): Generator<void, THREE.BufferGeometry> {
  const S = TILE[level]
  const cell = S / N
  const x0 = OFF_X + ti * S
  const z0 = OFF_Z + tj * S
  // grow the street plans (and, where impostors will want them, the lots) of
  // every town near the tile a slice at a time, before the height samples
  // below ask for them all at once: a city's plan is several milliseconds
  // in one piece, and this is where a town is usually first met
  const near = new Set<Town>()
  for (const [px, pz] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) {
    for (const t of townsNear(x0 + S * px, z0 + S * pz)) near.add(t)
  }
  for (const t of near) {
    const dx = Math.max(x0 - t.x, 0, t.x - x0 - S)
    const dz = Math.max(z0 - t.z, 0, t.z - z0 - S)
    if (Math.hypot(dx, dz) > t.radius * SPINE_REACH + 200) continue
    yield* prepareTown(t, level < IMPOSTOR_LEVELS)
  }
  const W = N + 3
  const h = new Float32Array(W * W)
  for (let b = 0; b < W; b++) {
    for (let a = 0; a < W; a++) h[b * W + a] = heightAt(x0 + (a - 1) * cell, z0 + (b - 1) * cell)
    if (b & 1) yield
  }
  const H = (a: number, b: number) => h[(b + 1) * W + (a + 1)]
  const s = new Soup()
  const V = N + 1
  const clampY = (y: number) => Math.max(y, SEA_Y)
  for (let b = 0; b < V; b++) {
    for (let a = 0; a < V; a++) {
      const x = x0 + a * cell
      const z = z0 + b * cell
      const y = H(a, b)
      const gx = (H(a + 1, b) - H(a - 1, b)) / (2 * cell)
      const gz = (H(a, b + 1) - H(a, b - 1)) / (2 * cell)
      const wet = y < SEA_Y
      let nx = -gx
      let ny = 1
      let nz = -gz
      if (wet) { nx = 0; nz = 0 }
      const nl = Math.hypot(nx, ny, nz)
      nx /= nl; ny /= nl; nz /= nl
      const g = groundSample(x, z, y, Math.hypot(gx, gz))
      tileCol.setRGB(g.r, g.g, g.b)
      // the district, as a code the shader paints by: 1 suburb, 2 midrise,
      // 3 downtown
      const dist = placeAt(x, z).district
      const town = dist === 'downtown' ? 3 : dist === 'midrise' ? 2 : dist ? 1 : 0
      // a town keeps a few garden trees; the sea none
      // (-1 is bare rock: a cliff band the shader draws in strata)
      const canopy = wet ? 0 : town ? 0.12 * (1 - g.paved)
        : g.biome === 'rock' ? -1 : g.biome === 'snow' ? -2 : CANOPY[g.biome] ?? 0
      tileLeaf.copy(LEAF[g.biome] ?? tileCol)
      // the height this vertex has in the next ring out, where it has one:
      // an odd vertex on the tile's edge sits between two that ring shares
      let stitch = clampY(y)
      const edgeX = a === 0 || a === N
      const edgeZ = b === 0 || b === N
      if (edgeX && (b & 1)) stitch = (clampY(H(a, b - 1)) + clampY(H(a, b + 1))) / 2
      else if (edgeZ && (a & 1)) stitch = (clampY(H(a - 1, b)) + clampY(H(a + 1, b))) / 2
      s.vert(x, clampY(y), z, nx, ny, nz, tileCol, 0, level, town, canopy,
        SEA_Y - y, stitch, tileLeaf, g.field)
    }
    if (b % 3 === 2) yield
  }
  for (let b = 0; b < N; b++)
    for (let a = 0; a < N; a++) {
      const p = b * V + a
      // the diagonal the chunk lattice uses (terrain.ts): a -> d
      s.idx.push(p, p + V, p + V + 1, p, p + V + 1, p + 1)
    }
  const ground = (x: number, z: number) => {
    const fa = Math.min(N, Math.max(0, (x - x0) / cell))
    const fb = Math.min(N, Math.max(0, (z - z0) / cell))
    const a = Math.min(N - 1, Math.floor(fa))
    const b = Math.min(N - 1, Math.floor(fb))
    const u = fa - a
    const v = fb - b
    return (H(a, b) * (1 - u) + H(a + 1, b) * u) * (1 - v) + (H(a, b + 1) * (1 - u) + H(a + 1, b + 1) * u) * v
  }
  const c0 = chunkX(x0 + 1)
  const d0 = chunkZ(z0 + 1)
  const per = S / CHUNK
  if (level < IMPOSTOR_LEVELS) {
    for (let dz = 0; dz < per; dz++) {
      for (let dx = 0; dx < per; dx++) {
        blockImpostors(s, level, c0 + dx, d0 + dz, ground)
        if ((dx & 3) === 3) yield
      }
      yield
    }
  }
  yield* townRoads(s, level, x0, z0, S, cell, ground)
  yield
  return s.build()
}

/* ----------------------------------------------------------------- rings -- */

interface Tile {
  key: string
  i: number
  j: number
  mesh: THREE.Mesh
}

interface Ring {
  level: number
  S: number
  /** the committed centre tile, NaN before the first commit */
  ci: number
  cj: number
  tiles: Map<string, Tile>
  /** the square the committed tiles cover */
  rect: THREE.Vector4
  /** a centre being built toward, and what it has so far */
  next: { ci: number; cj: number; tiles: Map<string, Tile | null>; waited: number } | null
}

interface Job {
  ring: Ring
  key: string
  i: number
  j: number
  gen: Generator<void, THREE.BufferGeometry>
}

const EMPTY = () => new THREE.Vector4(0, 0, 0, 0)

export const buildFarField = (opts: {
  parent: THREE.Object3D
  /** the near sea's own colour object, shared so the day cycle tints both */
  water: THREE.Color
  trackDisposable: (d: { dispose: () => void }) => void
}): FarField => {
  const root = new THREE.Group()
  root.name = 'far-field'
  opts.parent.add(root)
  const tilesRoot = new THREE.Group()
  root.add(tilesRoot)
  tilesRoot.visible = false

  const maskData = new Uint8Array(MASK * MASK)
  const maskTex = new THREE.DataTexture(maskData, MASK, MASK, THREE.RedFormat, THREE.UnsignedByteType)
  maskTex.minFilter = maskTex.magFilter = THREE.NearestFilter
  maskTex.needsUpdate = true
  // 0 rings is a far field that never shows (and a ring that widens the old
  // way): the harness's before-and-after, and a floor for a card that needs one
  const levels = Math.max(0, Math.min(TILE.length, gfx.farLevels))
  const U: FarUniforms = {
    uMask: { value: maskTex },
    uMaskO: { value: new THREE.Vector2(-1e4, -1e4) },
    uHole: { value: [EMPTY(), EMPTY(), EMPTY(), EMPTY()] },
    uRect: { value: [EMPTY(), EMPTY(), EMPTY(), EMPTY()] },
    uWater: { value: opts.water },
    uNight: { value: 0 },
    uCurve: { value: 0 },
    uEye: { value: new THREE.Vector2() },
    uFarFade: { value: 1 },
  }
  const mat = makeFarMaterial(U)
  opts.trackDisposable(mat)
  opts.trackDisposable(maskTex)

  /*
    The one stand-in that is always visible. CrtScene links the world's
    programs with compileAsync under the boot cover, which only sees what is
    visible; the tiles are hidden on the ground and may not exist yet. One
    degenerate triangle carrying every attribute, drawn nowhere, keeps the
    far field's program in that compile.
  */
  const warm = new Soup()
  warm.tri([[0, -1e4, 0], [0, -1e4, 0], [0, -1e4, 0]], [0, 1, 0], new THREE.Color(), 3, 0)
  const warmMesh = new THREE.Mesh(warm.build(), mat)
  warmMesh.frustumCulled = false
  warmMesh.matrixAutoUpdate = false
  root.add(warmMesh)
  opts.trackDisposable(warmMesh.geometry)

  const rings: Ring[] = []
  for (let l = 0; l < levels; l++) {
    rings.push({
      level: l, S: TILE[l], ci: Number.NaN, cj: Number.NaN,
      tiles: new Map(), rect: EMPTY(), next: null,
    })
  }
  const jobs: Job[] = []
  let visible = false

  const rectOf = (r: Ring, ci: number, cj: number, out: THREE.Vector4) =>
    out.set(
      OFF_X + (ci - SPAN) * r.S, OFF_Z + (cj - SPAN) * r.S,
      OFF_X + (ci + SPAN + 1) * r.S, OFF_Z + (cj + SPAN + 1) * r.S,
    )
  const inside = (a: THREE.Vector4, b: THREE.Vector4) =>
    a.x >= b.x && a.y >= b.y && a.z <= b.z && a.w <= b.w
  const committed = (r: Ring) => Number.isFinite(r.ci)

  const pushUniforms = () => {
    for (let l = 0; l < rings.length; l++) {
      U.uRect.value[l].copy(rings[l].rect)
      if (l > 0 && committed(rings[l - 1])) U.uHole.value[l].copy(rings[l - 1].rect)
      else U.uHole.value[l].set(0, 0, 0, 0)
      // a tile wholly inside the hole would only be discarded pixel by
      // pixel, after paying for its vertices: about a third of every ring
      const h = U.uHole.value[l]
      const S = rings[l].S
      for (const t of rings[l].tiles.values()) {
        const x0 = OFF_X + t.i * S
        const z0 = OFF_Z + t.j * S
        t.mesh.visible = !(x0 >= h.x && z0 >= h.y && x0 + S <= h.z && z0 + S <= h.w)
      }
    }
  }

  const tileMesh = (g: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(g, mat)
    m.matrixAutoUpdate = false
    m.castShadow = false
    m.receiveShadow = false
    return m
  }

  const plan = (r: Ring, ci: number, cj: number) => {
    const want = new Map<string, Tile | null>()
    for (let j = cj - SPAN; j <= cj + SPAN; j++)
      for (let i = ci - SPAN; i <= ci + SPAN; i++) {
        const key = `${i},${j}`
        const have = r.tiles.get(key) ?? r.next?.tiles.get(key) ?? null
        want.set(key, have)
        if (!have && !jobs.some((q) => q.ring === r && q.key === key)) {
          jobs.push({ ring: r, key, i, j, gen: tileJob(r.level, i, j) })
        }
      }
    // jobs for a centre nobody wants any more are dropped
    for (let k = jobs.length - 1; k >= 0; k--) {
      if (jobs[k].ring === r && !want.has(jobs[k].key)) jobs.splice(k, 1)
    }
    r.next = { ci, cj, tiles: want, waited: 0 }
    // the job list is short (a few rows of tiles): nearest ring first, then
    // nearest tile, so detail arrives where the camera is
    jobs.sort((a, b) => a.ring.level - b.ring.level ||
      (Math.abs(a.i - a.ring.next!.ci) + Math.abs(a.j - a.ring.next!.cj)) -
      (Math.abs(b.i - b.ring.next!.ci) + Math.abs(b.j - b.ring.next!.cj)))
  }

  const scratch = EMPTY()
  const tryCommit = (r: Ring) => {
    const n = r.next
    if (!n) return
    for (const t of n.tiles.values()) if (!t) return
    rectOf(r, n.ci, n.cj, scratch)
    const finer = rings[r.level - 1]
    const coarser = rings[r.level + 1]
    const ok = (!coarser || !committed(coarser) || inside(scratch, coarser.rect)) &&
      (!finer || !committed(finer) || inside(finer.rect, scratch))
    // nesting is what keeps the holes closed; a teleport can leave two rings
    // each waiting on the other, so after a second the finer one wins
    if (!ok && ++n.waited < 60) return
    for (const [key, t] of r.tiles) {
      if (n.tiles.get(key) === t) continue
      tilesRoot.remove(t.mesh)
      t.mesh.geometry.dispose()
    }
    r.tiles = new Map()
    for (const [key, t] of n.tiles) {
      r.tiles.set(key, t!)
      if (!t!.mesh.parent) tilesRoot.add(t!.mesh)
    }
    r.ci = n.ci
    r.cj = n.cj
    r.rect.copy(scratch)
    r.next = null
    pushUniforms()
  }

  let maskEpoch = Number.NaN
  const update: FarField['update'] = (x, z, alt, ready, epoch) => {
    for (const r of rings) {
      const ci = Math.floor((x - OFF_X) / r.S)
      const cj = Math.floor((z - OFF_Z) / r.S)
      const tci = r.next ? r.next.ci : r.ci
      const tcj = r.next ? r.next.cj : r.cj
      if (tci !== ci || tcj !== cj) {
        if (committed(r) && r.ci === ci && r.cj === cj) {
          // back where the committed square already is: stop building away
          for (let k = jobs.length - 1; k >= 0; k--) if (jobs[k].ring === r) jobs.splice(k, 1)
          r.next = null
        } else {
          plan(r, ci, cj)
        }
      }
      tryCommit(r)
    }
    // the far field shows once the camera is off the ground; the hysteresis
    // keeps a hovering helicopter from toggling it every frame
    const want = visible ? alt > 12 : alt > 16
    visible = want && rings.length > 0 && committed(rings[0])
    tilesRoot.visible = visible
    if (!visible) return
    const pcx = chunkX(x)
    const pcz = chunkZ(z)
    const ox = pcx - MASK / 2
    const oz = pcz - MASK / 2
    let changed = U.uMaskO.value.x !== ox || U.uMaskO.value.y !== oz
    // the mask only moves when the streamer's set of solid chunks does
    // (`epoch`) or the camera changes chunk: no per-frame lookups otherwise
    if (!changed && epoch === maskEpoch) return
    maskEpoch = epoch
    for (let j = 0; j < MASK; j++)
      for (let i = 0; i < MASK; i++) {
        const v = ready(ox + i, oz + j) ? 255 : 0
        if (maskData[j * MASK + i] !== v) {
          maskData[j * MASK + i] = v
          changed = true
        }
      }
    if (changed) {
      U.uMaskO.value.set(ox, oz)
      maskTex.needsUpdate = true
    }
  }

  const work = (ms: number) => {
    if (ms <= 0 || !jobs.length) return 0
    const t0 = performance.now()
    while (jobs.length && performance.now() - t0 < ms) {
      const job = jobs[0]
      const step = job.gen.next()
      if (!step.done) continue
      jobs.shift()
      const t: Tile = { key: job.key, i: job.i, j: job.j, mesh: tileMesh(step.value) }
      const n = job.ring.next
      if (n && n.tiles.has(job.key)) n.tiles.set(job.key, t)
      else step.value.dispose()
      tryCommit(job.ring)
    }
    return performance.now() - t0
  }

  const reach = (x: number, z: number) => {
    let out = 0
    for (const r of rings) {
      if (!committed(r)) break
      out = Math.min(x - r.rect.x, z - r.rect.y, r.rect.z - x, r.rect.w - z)
    }
    return Math.max(0, out)
  }

  return {
    root,
    update,
    work,
    reach,
    get complete() {
      return rings.length > 0 && rings.every(committed)
    },
    get visible() {
      return visible
    },
    get pending() {
      return jobs.length
    },
    setNight: (n) => {
      U.uNight.value = n
    },
    setSpace: (curve, eyeX, eyeZ, fade) => {
      U.uCurve.value = curve
      U.uEye.value.set(eyeX, eyeZ)
      U.uFarFade.value = fade
    },
    stats: () => {
      let tiles = 0
      let verts = 0
      let tris = 0
      for (const r of rings)
        for (const t of r.tiles.values()) {
          tiles++
          verts += t.mesh.geometry.getAttribute('position').count
          tris += (t.mesh.geometry.index?.count ?? 0) / 3
        }
      return { tiles, verts, tris }
    },
    dispose: () => {
      for (const r of rings) for (const t of r.tiles.values()) t.mesh.geometry.dispose()
      jobs.length = 0
    },
  }
}
