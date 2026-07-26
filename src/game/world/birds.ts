import * as THREE from 'three'
import { seeded } from '../core/rand'
import { gfx } from './quality'
import { SEA_Y, terrainY } from './terrain'

/*
  The birds: a handful of flocks turning slow circles over whatever ground the
  player happens to be standing on.

  A sky with nothing in it reads as a backdrop no matter how well it is
  painted — the clouds drift, but they drift at the speed of weather, which is
  slow enough that a still frame and a moving one look the same. Something has
  to cross it at a speed the eye can read. That is all this module is for.

  Three rules shape it:

  - **Flocks are session state, not world state**, like the fleet. Nothing is
    written into a chunk and nothing streams: a flock is a centre that wanders,
    a radius, an angular speed, and per-bird offsets around that ring. When a
    flock falls further behind than the fog reaches (the world is endless and
    a walker outruns a circling bird in about a minute) it is re-anchored at
    the far edge of visibility in a fresh random direction, where the fog hides
    the cut. So there is always life overhead and never a bird that pops in at
    arm's length.
  - **One draw call, one clock.** Every bird in every flock is an instance of
    the same six-triangle wing pair, and the flap is a vertex-shader rotation
    of each wing about the body axis — the CPU writes a matrix per bird per
    frame and nothing else. Amplitude breathes on a slow wave, so birds trade
    off between flapping and gliding instead of beating in perpetual lockstep.
  - **They follow the terrain, not the sea.** The ring's altitude is measured
    off the highest ground under it (probed at the centre and four points of
    the circle), so a flock crossing a ridge climbs over it rather than
    through it, and one over water holds its height above the waterline.

  Birds are a daylight thing here: the whole set fades out with the sun and
  the update loop returns early once it is dark, which is also why nothing
  needs to be roosted anywhere.
*/

export interface BirdsHandles {
  /** advance the flocks; `day`/`twilight` come straight from the sky state */
  update: (camPos: THREE.Vector3, dt: number, day: number, twilight: number) => void
}

interface BuildOpts {
  parent: THREE.Object3D
  trackDisposable: (d: { dispose: () => void }) => void
}

interface Flock {
  /** centre of the ring, in world xz */
  cx: number
  cz: number
  /** the ground it is holding its altitude over, smoothed */
  ground: number
  alt: number
  radius: number
  /** angular speed, signed: the sign is which way the flock circles */
  w: number
  /** current phase around the ring */
  a: number
  /** heading the centre itself wanders along, and how fast it turns */
  drift: number
  turn: number
  speed: number
  /** slice of the instance buffer this flock owns */
  first: number
  count: number
}

/*
  How far a flock may fall behind before it is re-cut somewhere else. The
  threshold is past the daylight fog far plane (240) so the cut itself is never
  on screen, but the *new* ring is well inside it: birds are fog-blended like
  everything else, so one arriving at 130 units fades up out of the haze rather
  than popping, and a walker who keeps walking keeps meeting flocks instead of
  watching them all fall permanently behind the fog.
*/
const RECUT_FAR = 290
const RECUT_NEAR = 125
const RECUT_SPAN = 70

/*
  One bird: two wings and a sliver of a body, in local space with +z forward
  and x along the wingspan. `aSpan` is 0 at the shoulder and 1 at the tip,
  which is both the flap weight and the reason the body stays still.
  DoubleSide because a bird is seen from below as often as from above and a
  one-sided wing disappears every time it banks.

  Each wing is *two* spanwise segments rather than one quad, because the flap
  is a rotation weighted by span: with a single quad the wing pivots as a rigid
  plank and a bird at the top of its beat is two black sticks at right angles
  to each other. The mid station bends, so the same rotation reads as a wing.
  The chord is generous for the same reason — a correctly proportioned bird at
  this scale is a scratch on the screen.
*/
const makeBirdGeometry = () => {
  const pos: number[] = []
  const span: number[] = []
  const tri = (
    a: [number, number, number], b: [number, number, number], c: [number, number, number],
  ) => {
    pos.push(...a, ...b, ...c)
    span.push(Math.abs(a[0]), Math.abs(b[0]), Math.abs(c[0]))
  }
  // spanwise stations: fraction out, leading edge z, trailing edge z. The
  // trailing edge sweeps back faster than the leading one, which is the swept
  // wing every soaring bird has
  const ST: [number, number, number][] = [
    [0, 0.26, -0.36],
    [0.5, 0.17, -0.32],
    [0.82, 0.03, -0.34],
    [1.06, -0.12, -0.32],
  ]
  for (const s of [1, -1]) {
    for (let k = 0; k < ST.length - 1; k++) {
      const [x0, f0, b0] = ST[k]
      const [x1, f1, b1] = ST[k + 1]
      const A: [number, number, number] = [s * x0, 0, f0]
      const B: [number, number, number] = [s * x1, 0, f1]
      const C: [number, number, number] = [s * x1, 0, b1]
      const D: [number, number, number] = [s * x0, 0, b0]
      tri(A, B, C)
      tri(A, C, D)
    }
  }
  // head and tail, so the silhouette has a direction at any distance
  tri([0, 0, 0.5], [0.075, 0, -0.06], [-0.075, 0, -0.06])
  tri([0.075, 0, -0.06], [0, 0, -0.7], [-0.075, 0, -0.06])
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aSpan', new THREE.Float32BufferAttribute(span, 1))
  return geo
}

export function buildBirds(opts: BuildOpts): BirdsHandles {
  const { parent, trackDisposable } = opts

  const rand = seeded(0xb12d5)
  const flocks: Flock[] = []
  const total = gfx.birds
  {
    let first = 0
    while (first < total) {
      const count = Math.min(total - first, 5 + Math.floor(rand() * 7))
      flocks.push({
        cx: 0, cz: 0, ground: 0,
        alt: 0, radius: 1, w: 0, a: 0, drift: 0, turn: 0, speed: 0,
        first, count,
      })
      first += count
    }
  }

  // per-bird offsets inside its flock: where on the ring, how far off it, how
  // high, and its own bob. Fixed for the session — a flock keeps its shape
  const oa = new Float32Array(total)
  const or = new Float32Array(total)
  const oy = new Float32Array(total)
  const ob = new Float32Array(total)
  const os = new Float32Array(total)
  const flap = new Float32Array(total * 2)
  for (let i = 0; i < total; i++) {
    oa[i] = (rand() - 0.5) * 1.5
    or[i] = (rand() - 0.5) * 22
    oy[i] = (rand() - 0.5) * 9
    ob[i] = 0.5 + rand() * 0.9
    os[i] = 1.05 + rand() * 0.75
    flap[i * 2] = rand() * Math.PI * 2
    flap[i * 2 + 1] = 7 + rand() * 6
  }

  const geo = makeBirdGeometry()
  geo.setAttribute('aFlap', new THREE.InstancedBufferAttribute(flap, 2))
  trackDisposable(geo)

  const uTime = { value: 0 }
  const mat = new THREE.MeshBasicMaterial({
    color: '#3a4049', side: THREE.DoubleSide, transparent: true, opacity: 0,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         attribute float aSpan;
         attribute vec2 aFlap;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // both wings rotate about the body axis, so the sign of x is the
         // only thing that differs between them; the slow term is the glide,
         // where the beat all but stops and the bird coasts
         float amp = 0.3 + 0.7 * smoothstep(-0.35, 0.5, sin(uTime * 0.27 + aFlap.x * 1.7));
         // a resting dihedral under the beat: a bird gliding with dead flat
         // wings edge-on to the camera vanishes, and a shallow V does not
         float ang = (0.16 + sin(uTime * aFlap.y + aFlap.x) * 0.72 * amp)
                     * aSpan * sign(position.x);
         float ca = cos(ang);
         float sa = sin(ang);
         transformed.x = position.x * ca - position.y * sa;
         transformed.y = position.x * sa + position.y * ca;`,
      )
  }
  mat.customProgramCacheKey = () => 'sky-birds'
  trackDisposable(mat)

  const mesh = new THREE.InstancedMesh(geo, mat, total)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // instances move far from the mesh's own origin and the mesh never moves,
  // so neither the frozen matrix nor the bounding sphere can be trusted
  mesh.frustumCulled = false
  mesh.userData.dynamic = true
  mesh.visible = false
  parent.add(mesh)
  trackDisposable(mesh)

  const DAY = new THREE.Color('#3a4049')
  const DUSK = new THREE.Color('#4a3b34')
  const dummy = new THREE.Object3D()
  let t = 0
  let anchored = false

  /** cut a flock in somewhere at the edge of visibility around the camera */
  const recut = (f: Flock, camPos: THREE.Vector3, firstCut: boolean) => {
    const az = rand() * Math.PI * 2
    const d = firstCut ? 40 + rand() * 90 : RECUT_NEAR + rand() * RECUT_SPAN
    f.cx = camPos.x + Math.cos(az) * d
    f.cz = camPos.z + Math.sin(az) * d
    f.radius = 26 + rand() * 46
    f.alt = 20 + rand() * 42
    // a circuit of 20-35 s whatever the radius, which is what keeps a wide
    // ring from crawling and a tight one from spinning like a fairground ride
    f.w = ((rand() < 0.5 ? -1 : 1) * Math.PI * 2) / (20 + rand() * 15)
    f.a = rand() * Math.PI * 2
    f.drift = rand() * Math.PI * 2
    f.turn = (rand() - 0.5) * 0.06
    f.speed = 1.5 + rand() * 3
    f.ground = Math.max(SEA_Y, terrainY(f.cx, f.cz))
  }

  /** the highest ground the ring passes over, so a flock clears the ridge it
      is circling instead of flying into its flank */
  const groundUnder = (f: Flock) => {
    let g = terrainY(f.cx, f.cz)
    g = Math.max(g, terrainY(f.cx + f.radius, f.cz), terrainY(f.cx - f.radius, f.cz))
    g = Math.max(g, terrainY(f.cx, f.cz + f.radius), terrainY(f.cx, f.cz - f.radius))
    return Math.max(SEA_Y, g)
  }

  const update = (camPos: THREE.Vector3, dt: number, day: number, twilight: number) => {
    const alpha = Math.min(1, day * 0.95 + twilight * 0.2)
    if (alpha < 0.02) {
      mesh.visible = false
      return
    }
    if (!anchored) {
      anchored = true
      for (const f of flocks) recut(f, camPos, true)
    }
    mesh.visible = true
    mat.opacity = alpha
    mat.color.copy(DAY).lerp(DUSK, twilight * 0.8)
    t += dt
    uTime.value = t

    for (const f of flocks) {
      f.drift += f.turn * dt
      f.cx += Math.cos(f.drift) * f.speed * dt
      f.cz += Math.sin(f.drift) * f.speed * dt
      const dx = f.cx - camPos.x
      const dz = f.cz - camPos.z
      if (dx * dx + dz * dz > RECUT_FAR * RECUT_FAR) recut(f, camPos, false)
      f.a += f.w * dt
      // ease onto the new ground rather than stepping to it, or a flock
      // crossing a cliff edge teleports its whole ring vertically
      f.ground += (groundUnder(f) - f.ground) * Math.min(1, dt * 0.6)

      // banking: the bird's local +x is its left wing, so rolling by +k*w
      // drops the inside wing into the turn (see the yaw derivation below)
      const roll = THREE.MathUtils.clamp(f.w * 1.7, -0.5, 0.5)
      for (let i = f.first; i < f.first + f.count; i++) {
        const ang = f.a + oa[i]
        const r = Math.max(6, f.radius + or[i])
        const x = f.cx + Math.cos(ang) * r
        const z = f.cz + Math.sin(ang) * r
        const y = f.ground + f.alt + oy[i] + Math.sin(t * ob[i] + oa[i] * 3) * 0.9
        // velocity around the ring is (-sin, cos) * w, and the model faces
        // +z, so this is the heading that puts its nose down the tangent
        const yaw = Math.atan2(-Math.sin(ang) * f.w, Math.cos(ang) * f.w)
        dummy.position.set(x, y, z)
        dummy.rotation.set(0, yaw, roll, 'YXZ')
        dummy.scale.setScalar(os[i])
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  return { update }
}
