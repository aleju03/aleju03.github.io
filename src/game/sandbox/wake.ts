import * as THREE from 'three'
import type { Prop } from './props'

/*
  The waterline: what tells the eye a prop is *in* the sea rather than
  pasted on it.

  Two things, both drawn for the pixel look rather than for a close-up. A
  floater wears a foam collar, a flat ring on the drawn surface hugging its
  waterline, and sheds a fainter ring that swells outward and fades every
  couple of seconds, brighter while it is moving through the water. And a
  prop that goes in hard throws a splash: two rings racing out from the
  entry and a spray of chunky droplets, square on purpose because at the
  look's resolution a droplet is two pixels and a round one would be the
  same two pixels. The world's own ripple rings (the water shader's, through
  the facade's `splash` hook) are laid under that as well, so the sea itself
  answers.

  It is decoration and holds no state the simulation reads. Everything is
  drawn from the simulated clock the facade passes in, so a film of the same
  run shows the same foam, and it costs two instanced draws. Its materials
  live in the sandbox root from the start (with an instance colour already
  written, which is a program define), so the covered compile that links the
  props' material links these too and nothing new appears mid-walk. Additive,
  so a fading ring fades by its instance colour, with the fog made to take
  light away rather than to add its own colour to a ring far out.

  Headless (no parent) it builds nothing and every call is a no-op.
*/

const MAX_RINGS = 96
const MAX_DROPS = 160
/** splashes remembered at once; the oldest is overwritten */
const MAX_SPLASHES = 12
/** how long a splash lives, seconds */
const SPLASH_LIFE = 1.1

interface Splash {
  x: number
  y: number
  z: number
  /** radius of what went in */
  r: number
  /** 0..1 */
  power: number
  at: number
  seed: number
}

export interface Wake {
  /** a prop went in hard at (x, y, z) on the surface */
  splash: (x: number, y: number, z: number, speed: number, radius: number, time: number) => void
  /** redraw every collar and splash for simulated time `time` */
  draw: (
    time: number,
    each: (fn: (p: Prop) => void) => void,
    surfaceAt: (x: number, z: number) => number,
  ) => void
  dispose: () => void
}

/** the foam's light at full strength. Linear, like everything the look
    grades: a quarter of white here is already a bright band after the tone
    curve, and at the first try's 0.8 every ring posterized to paper white */
const FOAM = new THREE.Color(0.3, 0.37, 0.4)

export const createWake = (root: THREE.Object3D | null): Wake => {
  if (!root) return { splash: () => {}, draw: () => {}, dispose: () => {} }

  // a thin annulus, flat on the water; scaled per instance to the waterline
  const ringGeo = new THREE.RingGeometry(0.86, 1, 28, 1)
  ringGeo.rotateX(-Math.PI / 2)
  // additive in colour and *nothing* in alpha: three's AdditiveBlending adds
  // alpha too, the look's target is half float, so a ring wrote alpha 2 and
  // the grade pass (which premultiplies on the way out) drew it twice as
  // bright, paper white whatever colour it was given
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthWrite: false,
    fog: true,
  })
  // additive light fades toward nothing in the fog, not toward the fog
  // colour: a ring far out should vanish, not glow the colour of the haze
  ringMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float wakeFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float wakeFog = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        gl_FragColor.rgb *= 1.0 - wakeFog;
      #endif`,
    )
  }
  ringMat.customProgramCacheKey = () => 'sandbox-wake'
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS)
  rings.name = 'sandbox-wake'
  rings.frustumCulled = false
  rings.castShadow = false
  rings.receiveShadow = false
  rings.renderOrder = 2
  rings.userData.dynamic = true
  rings.setColorAt(0, FOAM)
  rings.count = 0

  const dropGeo = new THREE.BoxGeometry(1, 1, 1)
  const dropMat = new THREE.MeshBasicMaterial({ color: 0xe4f2f6, fog: true })
  const drops = new THREE.InstancedMesh(dropGeo, dropMat, MAX_DROPS)
  drops.name = 'sandbox-spray'
  drops.frustumCulled = false
  drops.castShadow = false
  drops.receiveShadow = false
  drops.userData.dynamic = true
  drops.count = 0
  root.add(rings, drops)

  const splashes: Splash[] = []
  let head = 0
  let seed = 1

  const m4 = new THREE.Matrix4()
  const q0 = new THREE.Quaternion()
  const pos = new THREE.Vector3()
  const scl = new THREE.Vector3()
  const col = new THREE.Color()
  let nr = 0
  let nd = 0

  const ring = (x: number, y: number, z: number, r: number, light: number) => {
    if (nr >= MAX_RINGS || light <= 0.01 || r <= 0.01) return
    pos.set(x, y, z)
    scl.set(r, 1, r)
    m4.compose(pos, q0, scl)
    rings.setMatrixAt(nr, m4)
    col.copy(FOAM).multiplyScalar(Math.min(1, light))
    rings.setColorAt(nr, col)
    nr++
  }

  const hash = (n: number) => {
    const s = Math.sin(n * 12.9898) * 43758.5453
    return s - Math.floor(s)
  }

  return {
    splash: (x, y, z, speed, radius, time) => {
      const s: Splash = {
        x, y, z, r: radius, power: Math.min(1, speed / 22), at: time, seed: seed++,
      }
      if (splashes.length < MAX_SPLASHES) splashes.push(s)
      else {
        splashes[head] = s
        head = (head + 1) % MAX_SPLASHES
      }
    },
    draw: (time, each, surfaceAt) => {
      nr = 0
      nd = 0
      each((p) => {
        const m = p.mesh
        if (!m || p.parked || p.wet <= 0.01 || p.wet >= 0.985) return
        const x = m.position.x
        const z = m.position.z
        // the waterline's reach: the prop's box turned into the world, seen
        // from above, which is what the sea actually meets
        const q = m.quaternion
        const e = p.extents
        const xx = 1 - 2 * (q.y * q.y + q.z * q.z)
        const xy = 2 * (q.x * q.y - q.w * q.z)
        const xz = 2 * (q.x * q.z + q.w * q.y)
        const zx = 2 * (q.x * q.z - q.w * q.y)
        const zy = 2 * (q.y * q.z + q.w * q.x)
        const zz = 1 - 2 * (q.x * q.x + q.y * q.y)
        const hx = Math.abs(xx) * e.x + Math.abs(xy) * e.y + Math.abs(xz) * e.z
        const hz = Math.abs(zx) * e.x + Math.abs(zy) * e.y + Math.abs(zz) * e.z
        const reach = Math.max(hx, hz) * 0.92 + 0.3
        const y = surfaceAt(x, z) + 0.05
        const v = p.body.linvel()
        const stir = Math.min(1, Math.hypot(v.x, v.y, v.z) * 0.8)
        const ph = p.id * 1.618
        // the collar, breathing a little with the swell
        ring(x, y, z, reach * (1 + 0.05 * Math.sin(time * 1.7 + ph)), 0.22 + 0.25 * stir)
        // the ring it sheds, every two seconds or so, swelling out and fading
        const k = (time * 0.45 + ph) % 1
        ring(x, y - 0.01, z, reach * (1.15 + 0.8 * k), (1 - k) * (1 - k) * (0.12 + 0.2 * stir))
      })
      for (const s of splashes) {
        const age = time - s.at
        if (age < 0 || age > SPLASH_LIFE) continue
        const f = 1 - age / SPLASH_LIFE
        // two rings racing out, the second a beat behind
        ring(s.x, s.y + 0.06, s.z, s.r + age * (4 + 5 * s.power), f * f * (0.3 + 0.35 * s.power))
        if (age > 0.12) ring(s.x, s.y + 0.05, s.z, s.r * 0.7 + (age - 0.12) * 3, f * f * (0.2 + 0.25 * s.power))
        // the spray: ballistic, from where it went in, gone at the surface
        const n = Math.round(6 + 12 * s.power)
        for (let i = 0; i < n && nd < MAX_DROPS; i++) {
          const a = hash(s.seed * 31 + i) * Math.PI * 2
          const out = (1.2 + 3.2 * hash(s.seed * 17 + i * 3)) * (0.6 + s.power)
          const up = (4 + 7 * hash(s.seed * 7 + i * 5)) * (0.5 + s.power)
          const dy = up * age - 17 * age * age
          if (dy < -0.05) continue
          const rr = s.r * 0.7 + out * age
          const size = (0.13 + 0.12 * hash(s.seed + i * 11)) * (1 - 0.5 * age / SPLASH_LIFE)
          pos.set(s.x + Math.cos(a) * rr, s.y + dy, s.z + Math.sin(a) * rr)
          scl.set(size, size, size)
          m4.compose(pos, q0, scl)
          drops.setMatrixAt(nd++, m4)
        }
      }
      rings.count = nr
      drops.count = nd
      if (nr) {
        rings.instanceMatrix.needsUpdate = true
        if (rings.instanceColor) rings.instanceColor.needsUpdate = true
      }
      if (nd) drops.instanceMatrix.needsUpdate = true
    },
    dispose: () => {
      rings.removeFromParent()
      drops.removeFromParent()
      ringGeo.dispose()
      dropGeo.dispose()
      ringMat.dispose()
      dropMat.dispose()
    },
  }
}
