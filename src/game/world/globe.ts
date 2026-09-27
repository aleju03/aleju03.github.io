import * as THREE from 'three'
import { elevationAt, SEA_Y } from './land'
import { biomeAt } from './terrain'
import { placeAt } from './settlements'
import { BIOMES, URBAN_TINT, type BiomeId } from './biomes'
import { canvasTexture } from '../core/textures'
import { moonAlbedo } from '../levels/moon'
import { EARTH_R, MOON_R } from '../levels/space'

/*
  The planet from above, and the Moon: two spheres drawn by one program.

  The overworld is an endless plane, so there is no planet to photograph
  from orbit. This draws one. The Earth is a sphere hung under the camera
  with its pole directly below it, and its surface is *painted from the
  same fields the ground is built from* (land.ts's elevation, the biome
  classifier, the town sites), sampled around where the player is, so the
  continents you see from orbit are the land you climbed out of and your
  own spot is on top. The world does not wrap: a flight across the globe is
  a flight across the plane, the pole following you, and the far side of
  the ball is simply whatever lies a hemisphere's arc away.

  Four things keep it cheap and seamless:

  - **one grid, any radius.** The mesh is a polar grid in arc length from
    the pole, rings packed quadratically so the cap under you is finely cut
    and the far side coarse. The vertex shader bends it onto a sphere of
    whatever radius it is handed, which is how the globe continues the far
    field's own bend (levels/space.ts's curveK) past its rim during the
    climb, and how the same mesh is the Moon and the Earth in the Moon's sky.
  - **a map in world coordinates.** The painting is a square texture holding
    the whole planet as an azimuthal-equidistant disc around an anchor
    (distance from the anchor is distance from the centre, linearly, so a
    texel covers the same ground in both directions everywhere: a square-root
    mapping that crowded texels near the anchor stretched every town into a
    spoke), baked progressively (a coarse sixteenth first, then every texel)
    a few milliseconds a frame, and double-buffered so a re-anchor never shows
    a half-painted map. Moving within REBAKE of the anchor costs nothing,
    since the shader reads the map through the live pole.
  - **under the far field, never through it.** While the streamed ground is
    drawn the globe discards its own cap out to the far field's reach and
    sinks a little with distance, so the two never fight for a pixel; above
    the ground's fade it is the whole planet. (A polygon offset was tried
    and is wrong here: its slope term is enormous on a sphere seen edge-on,
    and it pushed the whole horizon behind the sky dome.)
  - **no program mid-flight.** Both spheres share one ShaderMaterial and the
    atmosphere's halo is a plain additive sprite, the program the sun's halo
    already uses; `warm(true)` shows all of it for the covered compile at
    world attach, so the first climb links nothing.

  Lit by its own sun uniform (the sky's), with clouds, a terminator, the
  towns lit on the night side and a blue rim, all in the fragment shader.
  Colours are linear, and the look (render/pixelLook.ts) grades and
  posterizes it like everything else; its alpha is the look's veil code, so
  it takes no outline ink, because a depth buffer thousands of units deep
  cannot resolve its folds and inked it drew the grid's spokes.
*/

/** texels per side of the Earth's map, and the Moon's */
const RES = 1024
const MOON_RES = 256
/** rings and segments of the polar grid */
const RINGS = 110
const SEGS = 128
/** re-anchor the Earth's map once the pole has drifted this far from it.
    The map is uniform, so this is only about keeping the far edge of the
    visible hemisphere on the map: half the planet's arc is the limit */
const REBAKE = 20000

const VERT = /* glsl */ `
  attribute vec2 aPolar;
  uniform vec2 uPole;
  uniform float uArc;
  uniform float uCurvR;
  uniform float uRad;
  uniform float uSink;
  varying vec2 vSample;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    float s = aPolar.x * uArc;
    float th = min(3.14159265, s / uCurvR);
    vec2 dir = vec2(sin(aPolar.y), cos(aPolar.y));
    vSample = uPole + s * dir;
    vS = s;
    float r = uRad - uSink * s;
    float sh = sin(th);
    float h2 = sin(th * 0.5);
    // the origin is the pole on the surface, not the centre, so the cap
    // under the camera is small numbers; 1 - cos is written as 2 sin^2 so
    // it survives float32 at a radius of four hundred thousand
    vec3 p = vec3(r * sh * dir.x, (r - uRad) - 2.0 * r * h2 * h2, r * sh * dir.y);
    // lit in world space: the sun is a world direction set once a frame, so
    // nothing here depends on which camera draws it
    vN = normalize(mat3(modelMatrix) * vec3(sh * dir.x, cos(th), sh * dir.y));
    vView = cameraPosition - (modelMatrix * vec4(p, 1.0)).xyz;
    gl_Position = projectionMatrix * (modelViewMatrix * vec4(p, 1.0));
  }
`

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uAnchor;
  uniform float uArc;
  uniform vec3 uSun;
  uniform float uKind;
  uniform float uHole;
  uniform float uFade;
  uniform float uClouds;
  uniform float uRim;
  uniform float uTime;
  varying vec2 vSample;
  varying float vS;
  varying vec3 vN;
  varying vec3 vView;
  float gHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float gNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x),
               mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // the classic 4x4 ordered dither, per pixel of the look's low-res target
  float bayer4(vec2 p) {
    ivec2 q = ivec2(mod(floor(p), 4.0));
    float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    return (m[q.y * 4 + q.x] + 0.5) / 16.0;
  }
  void main() {
    if (vS < uHole) discard;
    if (uFade < 0.999 && bayer4(gl_FragCoord.xy) >= uFade) discard;
    vec2 d = vSample - uAnchor;
    float dl = length(d);
    vec2 uv = 0.5 + 0.5 * (min(dl, uArc) / uArc) * (dl > 1e-3 ? d / dl : vec2(0.0));
    vec4 tex = texture2D(uMap, uv);
    vec3 alb = tex.rgb * tex.rgb;
    vec3 n = normalize(vN);
    vec3 v = normalize(vView);
    float ndl = dot(n, uSun);
    vec3 col;
    if (uKind < 0.5) {
      col = alb * (0.035 + 1.3 * max(ndl, 0.0));
      // weather: two octaves of drifting value noise over the map's own
      // coordinates, so a cloud stays over the same coast as you circle
      vec2 cp = vSample / 7000.0 + vec2(uTime * 0.004, uTime * 0.0017);
      float cn = gNoise(cp) * 0.62 + gNoise(cp * 2.3 + 7.1) * 0.38;
      float cov = smoothstep(0.56, 0.68, cn) * uClouds;
      col = mix(col, vec3(0.95, 0.97, 1.0) * (0.03 + 1.25 * max(ndl, 0.0)), cov * 0.9);
      // the towns, lit, on the night side
      float dark = 1.0 - smoothstep(-0.22, 0.06, ndl);
      col += tex.a * dark * vec3(1.9, 1.2, 0.55) * (1.0 - cov * 0.8);
      // the air seen edge-on: a blue rim, strongest toward the light
      float rim = pow(1.0 - max(dot(n, v), 0.0), 4.0);
      col += vec3(0.16, 0.34, 0.8) * rim * (0.1 + 0.9 * smoothstep(-0.35, 0.35, ndl)) * uRim;
    } else {
      col = alb * (0.015 + 1.45 * max(ndl, 0.0));
    }
    // written as a veil (render/shaders.ts's alpha codes): solid, but with
    // no ink. From orbit the depth buffer cannot resolve the surface's
    // folds, and inked it drew the polar grid's spokes across the planet
    gl_FragColor = vec4(col, 0.6);
  }
`

/** the polar grid: (arc fraction, azimuth) per vertex, rings quadratic */
const polarGrid = () => {
  const polar = new Float32Array((RINGS + 1) * (SEGS + 1) * 2)
  const pos = new Float32Array((RINGS + 1) * (SEGS + 1) * 3)
  for (let i = 0; i <= RINGS; i++) {
    const f = (i / RINGS) ** 2
    for (let j = 0; j <= SEGS; j++) {
      const k = i * (SEGS + 1) + j
      polar[k * 2] = f
      polar[k * 2 + 1] = (j / SEGS) * Math.PI * 2
    }
  }
  const idx: number[] = []
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * (SEGS + 1) + j
      const b = a + 1
      const c = a + SEGS + 1
      const d = c + 1
      // wound so the outside faces out (counter-clockwise seen from above
      // the pole): the other way round, back-face culling kept the far
      // hemisphere's inside and the planet was drawn inside out
      idx.push(a, d, b, a, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  // the real positions are the vertex shader's; this only has to exist
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aPolar', new THREE.BufferAttribute(polar, 2))
  g.setIndex(idx)
  // bounds are set per placement (see `bound`): the shader decides the shape
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1)
  return g
}

/** an RGBA map the bake writes into, mipmapped (it is minified hard from orbit) */
const makeMap = (res: number) => {
  const data = new Uint8Array(res * res * 4)
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
}

/* ------------------------------------------------------------ painting -- */

const lin = (hex: string) => new THREE.Color(hex)
const BIOME_RGB = new Map<BiomeId, [THREE.Color, THREE.Color]>()
for (const id of Object.keys(BIOMES) as BiomeId[]) {
  BIOME_RGB.set(id, [lin(BIOMES[id].tint[0]), lin(BIOMES[id].tint[1])])
}
const URBAN = lin(URBAN_TINT[0])
const SHALLOW = lin('#2f7f8f')
const DEEP = lin('#0b2346')
const tmp = new THREE.Color()

/** one texel of the Earth: albedo (stored as its square root, which is
    decoded in the shader, so the darks keep their steps) and the towns'
    night glow in alpha */
const earthTexel = (x: number, z: number, out: Uint8Array, o: number) => {
  const e = elevationAt(x, z)
  let glow = 0
  if (e < SEA_Y) {
    tmp.copy(SHALLOW).lerp(DEEP, Math.min(1, (SEA_Y - e) / 26))
  } else {
    const b = biomeAt(x, z, e, 0)
    const pair = BIOME_RGB.get(b)
    if (pair) tmp.copy(pair[0]).lerp(pair[1], 0.5)
    else tmp.setRGB(0.3, 0.3, 0.25)
    const place = placeAt(x, z)
    if (place.district) {
      tmp.lerp(URBAN, place.district === 'suburb' ? 0.45 : 0.8)
      glow = place.district === 'downtown' ? 1 : place.district === 'midrise' ? 0.75 : 0.4
    }
  }
  out[o] = Math.round(Math.sqrt(Math.max(0, tmp.r)) * 255)
  out[o + 1] = Math.round(Math.sqrt(Math.max(0, tmp.g)) * 255)
  out[o + 2] = Math.round(Math.sqrt(Math.max(0, tmp.b)) * 255)
  out[o + 3] = Math.round(glow * 255)
}

/** one texel of the Moon, moon-local (its anchor is the landing site) */
const moonTexel = (u: number, v: number, out: Uint8Array, o: number) => {
  const g = Math.sqrt(moonAlbedo(u, v))
  out[o] = Math.round(g * 0.99 * 255)
  out[o + 1] = Math.round(g * 0.97 * 255)
  out[o + 2] = Math.round(g * 0.94 * 255)
  out[o + 3] = 0
}

/**
 * A progressive bake of one map: every texel's world point is the inverse of
 * the shader's mapping (distance from the anchor, linear in the radius). The
 * first pass paints every fourth texel as a 4x4 block, a whole planet in a
 * sixteenth of the work; the second fills the rest.
 */
interface Bake {
  tex: THREE.DataTexture
  ax: number
  az: number
  arc: number
  res: number
  sample: (x: number, z: number, out: Uint8Array, o: number) => void
  row: number
  pass: 0 | 1 | 2
}

const bakeRow = (b: Bake) => {
  const { res } = b
  const data = b.tex.image.data as Uint8Array
  const texel = (i: number, j: number) => {
    const ux = ((i + 0.5) / res) * 2 - 1
    const uz = ((j + 0.5) / res) * 2 - 1
    // past the disc (the corners) the rim is repeated: only the mips see it
    const rho = Math.hypot(ux, uz)
    const s = rho > 1 ? b.arc / rho : b.arc
    return [b.ax + ux * s, b.az + uz * s] as const
  }
  const j = b.row
  if (b.pass === 0) {
    for (let i = 0; i < res; i += 4) {
      const [x, z] = texel(i + 1.5, j + 1.5)
      const o = (j * res + i) * 4
      b.sample(x, z, data, o)
      for (let dj = 0; dj < 4; dj++)
        for (let di = 0; di < 4; di++) {
          const q = ((j + dj) * res + i + di) * 4
          if (q !== o) data.copyWithin(q, o, o + 4)
        }
    }
    b.row += 4
    if (b.row >= res) {
      b.pass = 1
      b.row = 0
    }
  } else if (b.pass === 1) {
    for (let i = 0; i < res; i++) {
      const [x, z] = texel(i, j)
      b.sample(x, z, data, (j * res + i) * 4)
    }
    b.row += 1
    if (b.row >= res) b.pass = 2
  }
}

/* ---------------------------------------------------------------- halo -- */

/** the air around the limb: a ring of light on a sprite, its inside hidden
    behind the globe by the depth test. The limb is placed at HALO_LIMB of
    the sprite's radius, so the ring hugs it at any distance */
const HALO_LIMB = 0.9
const makeHaloTexture = () =>
  canvasTexture([256, 256], (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    // the limb lands at 0.9 of the sprite's radius (see HALO_LIMB)
    g.addColorStop(0, 'rgba(90,150,255,0)')
    g.addColorStop(0.86, 'rgba(90,150,255,0)')
    g.addColorStop(0.9, 'rgba(120,175,255,0.85)')
    g.addColorStop(0.94, 'rgba(90,150,255,0.25)')
    g.addColorStop(1, 'rgba(90,150,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

/* ---------------------------------------------------------------- build -- */

export interface Globes {
  /** the Earth's map is painted around (x, z): re-anchored once the pole
      drifts REBAKE from it. Cheap to call every frame */
  wantEarth: (x: number, z: number) => void
  /** the Moon's map (baked once) */
  wantMoon: () => void
  /** spend up to `ms` on whichever bake is running */
  work: (ms: number) => void
  readonly earthReady: boolean
  /** the Earth under the camera, pole straight down, bent to `curvR` */
  earthBelow: (o: {
    cam: THREE.Vector3; poleY: number; curvR: number; hole: number; fade: number
    /** sink under the far field (it is still drawn) */
    offset: boolean; clouds: number; rim: number; halo: number
  }) => void
  /** the Earth as a body in the sky: centred `dist` along `dir` from the
      camera at `rad`, its anchor (where you left) turned toward you */
  earthInSky: (cam: THREE.Vector3, dir: THREE.Vector3, dist: number, rad: number) => void
  /** the Moon, its centre and radius in the scene, its landing site facing
      `pole` (unit, from its centre) */
  moonAt: (centre: THREE.Vector3, rad: number, pole: THREE.Vector3, fade: number) => void
  hideEarth: () => void
  hideMoon: () => void
  /** the sun's direction and the clock, once a frame */
  setSun: (dir: THREE.Vector3, time: number) => void
  /** everything visible, out of sight, for a covered compile */
  warm: (on: boolean) => void
}

export const buildGlobes = (opts: {
  parent: THREE.Object3D
  trackDisposable: (d: { dispose: () => void }) => void
}): Globes => {
  const { parent, trackDisposable } = opts
  const grid = polarGrid()
  trackDisposable(grid)

  const sunWorld = new THREE.Vector3(0, 1, 0)
  const time = { value: 0 }
  const makeMat = (map: THREE.Texture, kind: number) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: map },
        uAnchor: { value: new THREE.Vector2() },
        uPole: { value: new THREE.Vector2() },
        uArc: { value: Math.PI * EARTH_R },
        uCurvR: { value: EARTH_R },
        uRad: { value: EARTH_R },
        uSink: { value: 0 },
        uSun: { value: sunWorld },
        uKind: { value: kind },
        uHole: { value: 0 },
        uFade: { value: 1 },
        uClouds: { value: 0 },
        uRim: { value: 1 },
        uTime: time,
      },
      fog: false,
      lights: false,
    })
    trackDisposable(m)
    return m
  }

  // the Earth's two maps (front shows, back bakes) and the Moon's one
  const maps = [makeMap(RES), makeMap(RES)]
  for (const t of maps) trackDisposable(t)
  let front = -1
  let bake: Bake | null = null
  let bakeSlot = 0
  const anchors = [new THREE.Vector2(), new THREE.Vector2()]
  const moonMap = makeMap(MOON_RES)
  trackDisposable(moonMap)
  let moonBake: Bake | null = null
  let moonReady = false

  const earthMat = makeMat(maps[0], 0)
  const earth = new THREE.Mesh(grid, earthMat)
  earth.name = 'globe-earth'
  earth.frustumCulled = false
  earth.visible = false
  earth.userData.dynamic = true
  // under the far field's opaque ground, after it (see the header)
  earth.renderOrder = -1
  parent.add(earth)

  const moonMat = makeMat(moonMap, 1)
  moonMat.uniforms.uArc.value = Math.PI * MOON_R
  moonMat.uniforms.uCurvR.value = MOON_R
  moonMat.uniforms.uRad.value = MOON_R
  const moon = new THREE.Mesh(grid, moonMat)
  moon.name = 'globe-moon'
  moon.frustumCulled = false
  moon.visible = false
  moon.userData.dynamic = true
  parent.add(moon)

  const haloTex = makeHaloTexture()
  trackDisposable(haloTex)
  // the same kind of material as the sky's sun halo, so the same program
  const haloMat = new THREE.MeshBasicMaterial({
    map: haloTex, transparent: true, opacity: 0, fog: false,
    depthWrite: false, blending: THREE.AdditiveBlending,
  })
  trackDisposable(haloMat)
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), haloMat)
  trackDisposable(halo.geometry)
  halo.name = 'globe-halo'
  halo.frustumCulled = false
  halo.visible = false
  halo.renderOrder = -9.55
  halo.userData.dynamic = true
  parent.add(halo)

  const startEarth = (x: number, z: number) => {
    bakeSlot = front === 0 ? 1 : 0
    anchors[bakeSlot].set(x, z)
    bake = {
      tex: maps[bakeSlot], ax: x, az: z, arc: Math.PI * EARTH_R, res: RES,
      sample: earthTexel, row: 0, pass: 0,
    }
  }

  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const tv = new THREE.Vector3()
  const tc = new THREE.Vector3()


  return {
    wantEarth: (x, z) => {
      // a bake for somewhere you have since flown away from is abandoned
      // rather than finished: the map you need is the one under you now
      if (bake && Math.hypot(x - bake.ax, z - bake.az) > REBAKE) bake = null
      if (bake) return
      if (front < 0 || Math.hypot(x - anchors[front].x, z - anchors[front].y) > REBAKE) startEarth(x, z)
    },
    wantMoon: () => {
      if (moonReady || moonBake) return
      moonBake = {
        tex: moonMap, ax: 0, az: 0, arc: Math.PI * MOON_R, res: MOON_RES,
        sample: moonTexel, row: 0, pass: 0,
      }
    },
    work: (ms) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        const b = bake ?? moonBake
        if (!b) return
        const passWas = b.pass
        bakeRow(b)
        const rowsUp = b.pass !== passWas || (b.pass === 1 && b.row % 128 === 0)
        if (b === bake) {
          // the coarse pass finished: it is a whole planet, so show it now
          // and refine in place
          if (passWas === 0 && b.pass === 1) {
            front = bakeSlot
            earthMat.uniforms.uMap.value = maps[front]
            earthMat.uniforms.uAnchor.value.copy(anchors[front])
          }
          if (rowsUp) b.tex.needsUpdate = true
          if (b.pass === 2) bake = null
        } else {
          if (rowsUp) b.tex.needsUpdate = true
          if (b.pass === 2) {
            moonBake = null
            moonReady = true
          }
        }
      }
    },
    get earthReady() {
      return front >= 0
    },
    earthBelow: (o) => {
      if (front < 0) {
        earth.visible = false
        halo.visible = false
        return
      }
      const u = earthMat.uniforms
      earth.visible = o.fade > 0.001
      earth.position.set(o.cam.x, o.poleY, o.cam.z)
      earth.quaternion.identity()
      earth.updateMatrixWorld()
      u.uPole.value.set(o.cam.x, o.cam.z)
      u.uArc.value = Math.PI * EARTH_R
      u.uCurvR.value = o.curvR
      u.uRad.value = o.curvR
      u.uSink.value = o.offset ? 0.01 : 0
      u.uHole.value = o.hole
      u.uFade.value = o.fade
      u.uClouds.value = o.clouds
      u.uRim.value = o.rim
      // the halo: a ring at the limb, on a sprite just behind the limb's
      // distance so the globe's own depth hides its inside
      const h = Math.max(1, o.cam.y - (o.poleY - 0))
      const d = o.curvR + h
      const limb = Math.sqrt(Math.max(1, d * d - o.curvR * o.curvR))
      const ang = Math.asin(Math.min(0.9999, o.curvR / d))
      const L = limb * 1.02
      halo.visible = o.halo > 0.01 && earth.visible
      if (halo.visible) {
        tv.set(0, -1, 0)
        halo.position.copy(o.cam).addScaledVector(tv, L)
        halo.scale.setScalar((L * Math.tan(Math.min(1.45, ang))) / HALO_LIMB)
        halo.lookAt(o.cam)
        halo.updateMatrixWorld()
        haloMat.opacity = o.halo
      }
    },
    earthInSky: (cam, dir, dist, rad) => {
      if (front < 0) {
        earth.visible = false
        halo.visible = false
        return
      }
      const u = earthMat.uniforms
      earth.visible = true
      // the pole (where you left) turned to face the camera
      tc.copy(cam).addScaledVector(dir, dist - rad)
      earth.position.copy(tc)
      tv.copy(dir).negate()
      q.setFromUnitVectors(up, tv)
      earth.quaternion.copy(q)
      earth.updateMatrixWorld()
      u.uPole.value.copy(anchors[front])
      u.uArc.value = Math.PI * EARTH_R
      u.uCurvR.value = EARTH_R
      u.uRad.value = rad
      u.uSink.value = 0
      u.uHole.value = 0
      u.uFade.value = 1
      u.uClouds.value = 1
      u.uRim.value = 1
      halo.visible = true
      const L = dist * 1.0
      halo.position.copy(cam).addScaledVector(dir, L)
      halo.scale.setScalar((L * Math.tan(Math.asin(Math.min(0.99, rad / dist)))) / HALO_LIMB)
      halo.lookAt(cam)
      halo.updateMatrixWorld()
      haloMat.opacity = 1
    },
    moonAt: (centre, rad, pole, fade) => {
      moon.visible = moonReady && fade > 0.001
      if (!moon.visible) return
      const u = moonMat.uniforms
      moon.position.copy(centre).addScaledVector(pole, rad)
      q.setFromUnitVectors(up, pole)
      moon.quaternion.copy(q)
      moon.updateMatrixWorld()
      u.uPole.value.set(0, 0)
      u.uAnchor.value.set(0, 0)
      u.uRad.value = rad
      u.uCurvR.value = MOON_R
      u.uArc.value = Math.PI * MOON_R
      u.uFade.value = fade
    },
    hideEarth: () => {
      earth.visible = false
      halo.visible = false
    },
    hideMoon: () => {
      moon.visible = false
    },
    setSun: (dir, t) => {
      sunWorld.copy(dir)
      time.value = t
    },
    warm: (on) => {
      for (const m of [earth, moon, halo]) {
        m.visible = on
        if (on) {
          m.position.set(0, -2e4, 0)
          m.updateMatrixWorld()
        }
      }
    },
  }
}
