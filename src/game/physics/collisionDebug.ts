import * as THREE from 'three'
import type { CollisionSet, Hull, Solid } from './collision'

/*
  Draw the collision set.

  Collision in here is invisible by construction: a Box3 list with no meshes
  behind it, standing in for geometry that is drawn separately and never has to
  agree with it. That is cheap and it is why a solid can be a *lie* — a box a
  metre proud of the fence it wraps, a stale one left behind by a chunk that
  unloaded, a vehicle's own footprint parked across a pavement — and the only
  symptom the player gets is walking into nothing. Every one of those costs an
  afternoon of reading code to find and one glance to find with a wireframe.

  So: F9 outlines every solid the live level is testing against, in the same
  frame the walk is testing against it. Green is an ordinary box. Amber is
  `noStand` — a box whose top is thin air, which is most walls and every fence
  rail. Red is a hull, drawn as its real profile (the footprint ring at the
  bottom, the station tops above it, a rung at each station) rather than its
  bounds, because the bounds are exactly the thing a hull exists to stop being
  taken seriously.

  It rebuilds from scratch each frame it is visible. That is a few hundred
  boxes' worth of Float32Array writes and no allocation past the first growth,
  which is nothing next to being able to see the answer; and while it is off it
  costs one boolean per frame. Nothing here is drawn into the depth buffer, so
  a box inside a wall still reads.
*/

/** 12 edges of a box, as index pairs into the 8 corners */
const EDGES = [
  0, 1, 1, 3, 3, 2, 2, 0,
  4, 5, 5, 7, 7, 6, 6, 4,
  0, 4, 1, 5, 2, 6, 3, 7,
]

const PLAIN = new THREE.Color('#3ef08a')
const NOSTAND = new THREE.Color('#ffb020')
const HULLED = new THREE.Color('#ff3b6b')
const CULPRIT = new THREE.Color('#ffffff')

/** where the body is, so the box it is standing inside can be called out */
export interface DebugProbe {
  x: number
  z: number
  footY: number
  headY: number
}

export interface CollisionDebug {
  readonly on: boolean
  toggle: () => boolean
  /** rebuild the outlines from whatever the level is currently testing. Any
      solid the probe is inside comes out white and is named on the console */
  update: (set: CollisionSet, probe?: DebugProbe) => void
  dispose: () => void
}

export function createCollisionDebug(parent: THREE.Object3D): CollisionDebug {
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    transparent: true,
    opacity: 0.85,
  })
  const geo = new THREE.BufferGeometry()
  let pos = new Float32Array(0)
  let col = new Float32Array(0)
  const lines = new THREE.LineSegments(geo, mat)
  // it has to survive the scene-wide freeze and draw over everything
  lines.userData.dynamic = true
  lines.frustumCulled = false
  lines.renderOrder = 999
  lines.visible = false
  parent.add(lines)

  let on = false
  let n = 0

  const grow = (need: number) => {
    if (pos.length >= need * 3) return
    pos = new Float32Array(need * 3 * 2)
    col = new Float32Array(need * 3 * 2)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  }

  const vert = (x: number, y: number, z: number, c: THREE.Color) => {
    const i = n * 3
    pos[i] = x
    pos[i + 1] = y
    pos[i + 2] = z
    col[i] = c.r
    col[i + 1] = c.g
    col[i + 2] = c.b
    n++
  }

  const seg = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    c: THREE.Color,
  ) => {
    vert(ax, ay, az, c)
    vert(bx, by, bz, c)
  }

  /** a station's flank point in world space */
  const flank = (h: Hull, k: -1 | 1, i: number, out: THREE.Vector3) => {
    const s = h.st[i]
    const lx = k * s.hw
    out.set(
      h.x + lx * h.cos + s.z * h.sin,
      h.y + s.top,
      h.z - lx * h.sin + s.z * h.cos,
    )
  }

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()

  /* ------------------------------------------------------ the culprit -- */

  /** the same overlap `resolveXZ` pushes out of, asked without the step
      allowance: a box you are *standing in* is the one that is stopping you */
  const inside = (s: Solid, p: DebugProbe) =>
    s.max.y > p.footY && s.min.y < p.headY &&
    p.x > s.min.x && p.x < s.max.x && p.z > s.min.z && p.z < s.max.z

  const hits: Solid[] = []
  let said = ''
  /** name what the body is in, on change only — this runs every frame */
  const report = () => {
    const key = hits.map((s) => `${s.min.x},${s.min.z},${s.max.x},${s.max.z}`).join('|')
    if (key === said) return
    said = key
    if (!hits.length) {
      console.info('[collision] clear')
      return
    }
    for (const s of hits) {
      const f = (v: number) => v.toFixed(2)
      console.info(
        `[collision] blocked by ${s.noStand ? 'noStand ' : ''}box` +
          `  x ${f(s.min.x)}..${f(s.max.x)}` +
          `  y ${f(s.min.y)}..${f(s.max.y)}` +
          `  z ${f(s.min.z)}..${f(s.max.z)}` +
          `  (${f(s.max.x - s.min.x)} x ${f(s.max.y - s.min.y)} x ${f(s.max.z - s.min.z)})`,
      )
    }
  }

  const drawHull = (h: Hull, floor: number) => {
    const last = h.st.length - 1
    for (let i = 0; i <= last; i++) {
      for (const k of [-1, 1] as const) {
        flank(h, k, i, a)
        // the rung: floor to deck at this station, so the profile reads as a
        // solid rather than as two unrelated rings
        seg(a.x, floor, a.z, a.x, a.y, a.z, HULLED)
        if (i < last) {
          flank(h, k, i + 1, b)
          seg(a.x, floor, a.z, b.x, floor, b.z, HULLED)
          seg(a.x, a.y, a.z, b.x, b.y, b.z, HULLED)
        }
      }
      // close the ends across the beam
      if (i === 0 || i === last) {
        flank(h, -1, i, a)
        flank(h, 1, i, b)
        seg(a.x, floor, a.z, b.x, floor, b.z, HULLED)
        seg(a.x, a.y, a.z, b.x, b.y, b.z, HULLED)
      }
    }
  }

  const drawBox = (s: Solid, c: THREE.Color) => {
    const x = [s.min.x, s.max.x]
    const y = [s.min.y, s.max.y]
    const z = [s.min.z, s.max.z]
    for (let e = 0; e < EDGES.length; e += 2) {
      const p = EDGES[e]
      const q = EDGES[e + 1]
      seg(
        x[p & 1], y[(p >> 1) & 1], z[(p >> 2) & 1],
        x[q & 1], y[(q >> 1) & 1], z[(q >> 2) & 1],
        c,
      )
    }
  }

  return {
    get on() {
      return on
    },
    toggle: () => {
      on = !on
      lines.visible = on
      return on
    },
    update: (set, probe) => {
      if (!on) return
      // a hull draws more segments than a box, so budget for the worst case
      grow(set.boxes.length * 24 + 512)
      n = 0
      hits.length = 0
      for (const s of set.boxes) {
        // an emptied box is a live solid that is deliberately switched off
        // (the driven vehicle, a door swung open) — drawing it would show a
        // wall at infinity, which is worse than showing nothing
        if (s.max.x < s.min.x) continue
        const caught = probe ? inside(s, probe) : false
        if (caught) hits.push(s)
        if (s.hull) drawHull(s.hull, s.min.y)
        else drawBox(s, caught ? CULPRIT : s.noStand ? NOSTAND : PLAIN)
      }
      report()
      geo.setDrawRange(0, n)
      const p = geo.getAttribute('position') as THREE.BufferAttribute
      const c = geo.getAttribute('color') as THREE.BufferAttribute
      p.needsUpdate = true
      c.needsUpdate = true
      geo.computeBoundingSphere()
    },
    dispose: () => {
      parent.remove(lines)
      geo.dispose()
      mat.dispose()
    },
  }
}
