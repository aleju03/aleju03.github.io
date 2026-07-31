/*
  The flight path: one blue dashed contrail drawn down the whole page by the
  visitor's scroll, from the hero name to the machine at the foot of the site.

  This is the same line the site already draws three other ways (the dashes
  the paper plane inks behind itself, the looping stroke in the contact
  illustration, the ZigzagDoodle beside each heading), promoted to the page's
  spine. It rides BlockName's canvas rather than a second one: that canvas is
  already fixed to the viewport with its world pinned to the DOCUMENT (origin
  at the viewport center at scroll 0, camera slid down by the live scroll
  offset), so a curve laid out in document pixels stays glued to the sections
  for free, and there is no second WebGL context to pay for.

  Two things shape the routing. That canvas paints ABOVE the page content below
  the hero (it is a z-10 fixed layer declared inside the first section), so the
  path must run in the gutters beside the text column and only cross it in the
  whitespace between sections, never over a paragraph and above all never over
  a chapter heading, which is why stations measure where their type ends and
  the lane change is clamped below it. And on narrow viewports there are no
  gutters at all, so the lane collapses to the screen edge and the ink thins
  out with it.

  Drawing is one InstancedMesh of stadium-shaped dashes generated in curve
  order, which makes the scroll reveal `mesh.count = front * total`, no
  per-frame geometry work, one draw call. Only the nib (the lit dash at the
  drawing front) and the waypoint fans move each frame.
*/

import * as THREE from 'three'
import { createPaperDart, type PaperDart } from './paper'
import { stationProgress, type Station, type StationMap } from './stations'

/** BlockName's pixel->world mapping: `wpp` world units per CSS pixel, canvas size */
export interface FlightView {
  wpp: number
  W: number
  H: number
}

export interface FlightPath {
  object: THREE.Object3D
  layout(stations: StationMap, view: FlightView): void
  update(smoothY: number, viewportH: number, dt: number): void
  dispose(): void
}

/** world units of ink per dash, and the repeat length it sits in */
const DASH_ON = 0.62
const DASH_CYCLE = 1.5
const DASH_HALF_W = 0.075
/** behind the letter faces, so the path passes *through* the name, and behind the dart */
const PATH_Z = -1.6

/** which side of the column each stop's lane runs down; the flight weaves */
const LANE: Record<string, number> = {
  hero: 1,
  work: -1,
  more: 1,
  experience: -1,
  about: 1,
  machine: 0,
}

/** the stadium dash, drawn once and instanced: uniform scale, so the caps stay round */
function dashGeometry(): THREE.ShapeGeometry {
  const half = DASH_ON / 2
  const r = DASH_HALF_W
  const shape = new THREE.Shape()
  shape.moveTo(-half, r)
  shape.lineTo(half, r)
  shape.absarc(half, 0, r, Math.PI / 2, -Math.PI / 2, true)
  shape.lineTo(-half, -r)
  shape.absarc(-half, 0, r, -Math.PI / 2, Math.PI / 2, true)
  shape.closePath()
  return new THREE.ShapeGeometry(shape, 6)
}

export function createFlightPath(opts: {
  /** shared with BlockName's accent material so the theme fade applies for free */
  accentColor: THREE.Color
  /** the cream sheet + ink line materials the dart is built from */
  paperMaterial: THREE.Material
  inkMaterial: THREE.Material
  reduce: boolean
  coarse: boolean
}): FlightPath {
  const { accentColor, paperMaterial, inkMaterial, reduce, coarse } = opts

  const object = new THREE.Group()
  object.renderOrder = -1

  const dashMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  })
  dashMat.color = accentColor // shared instance: BlockName lerps it on theme change
  const geo = dashGeometry()

  // generous ceiling: a tall page at a small `wpp` makes a long curve, and the
  // instance buffer has to be allocated before we know either
  const MAX_DASHES = coarse ? 420 : 900
  const dashes = new THREE.InstancedMesh(geo, dashMat, MAX_DASHES)
  dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  dashes.frustumCulled = false // one mesh spanning the document; its bounds are meaningless
  dashes.count = 0
  object.add(dashes)

  // the nib: the lit dash at the drawing front, the only one that moves
  const nib = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }))
  ;(nib.material as THREE.MeshBasicMaterial).color = accentColor
  nib.visible = false
  object.add(nib)

  const marks = new Map<string, { wrap: THREE.Group; dart: PaperDart; station: Station; phase: number }>()

  let curve: THREE.CatmullRomCurve3 | null = null
  let dashCount = 0
  let startDocY = 0
  let endDocY = 1
  let spin = 0

  const scratch = new THREE.Object3D()
  const point = new THREE.Vector3()
  const tangent = new THREE.Vector3()

  /** document px -> the canvas world, the same mapping BlockName pins `holder` with */
  const toWorld = (docX: number, docY: number, view: FlightView) =>
    new THREE.Vector3((docX - view.W / 2) * view.wpp, -(docY - view.H / 2) * view.wpp, PATH_Z)

  function layout(stations: StationMap, view: FlightView) {
    for (const { wrap, dart } of marks.values()) {
      object.remove(wrap)
      dart.dispose()
    }
    marks.clear()
    curve = null
    dashCount = 0
    dashes.count = 0
    nib.visible = false

    if (stations.list.length < 2 || view.wpp === 0 || view.W === 0) return

    // the lane: just outside the max-w-6xl (1152px) text column where the
    // viewport is wide enough to have a gutter, hard against the edge where it
    // isn't. `margin` keeps the ink off the scrollbar either way.
    //
    // The pick is a MIN, and it was a max, which is the same sentence read
    // backwards: taking the larger of "beside the column" and "against the
    // edge" means the wider the display, the further out the lane is flung, so
    // on anything past about 1400px the contrail ran down the extreme edges of
    // the screen with the waypoint darts half-clipped off both sides. The
    // column is a fixed 1152px no matter how wide the window is, so the gutter
    // beside it is the thing that grows, and the lane should stay pinned to
    // the column it is a margin for. The edge case still works out: on a
    // narrow viewport `view.W / 2 - margin` is the smaller number and wins,
    // which is the "no gutter, hug the edge" branch.
    const margin = Math.min(56, view.W * 0.07)
    const columnHalf = Math.min(576, view.W / 2)
    const laneOffset = Math.min(columnHalf + 28, view.W / 2 - margin)
    const laneX = (sign: number) => view.W / 2 + sign * Math.min(laneOffset, view.W / 2 - margin * 0.6)

    const control: THREE.Vector3[] = []
    const push = (docX: number, docY: number) => control.push(toWorld(docX, docY, view))

    for (const station of stations.list) {
      const sign = LANE[station.id] ?? 0
      const x = sign === 0 ? view.W / 2 : laneX(sign)
      if (station.id === 'hero') {
        // the flight starts where the dart is parked, off the name's right shoulder
        push(x, station.top + station.height * 0.58)
      } else if (station.id === 'machine') {
        // and ends on the glass: the machine act pins its stage to the viewport,
        // so the CRT sits a viewport-half into the section's document span
        push(x, station.top + Math.min(station.height * 0.5, view.H * 0.52))
      } else {
        // Run the lane down the section, so crossings land in the gaps between.
        //
        // Where the lane change ENDS is the whole game. The traverse arrives
        // from the far lane on a long diagonal, so the entry point is the last
        // moment the ink is anywhere near the text column, and it used to be a
        // fraction of the section's height: fine for a tall section, wrong for
        // a short one. 18% of the 709px experience section is 128px, its
        // chapter heading starts at 133, and the tail of a traverse that has
        // just crossed the whole page lands across the top of a 6rem letter.
        // Clamping it above the measured heading puts the entire crossing in
        // the seam between the sections, where there is nothing to hit.
        const enter = Math.min(station.height * 0.18, Math.max(24, station.headTop - 45))
        push(x, station.top + enter)
        push(x, station.top + Math.max(enter + 40, station.height * 0.82))
      }
    }
    if (control.length < 2) return

    curve = new THREE.CatmullRomCurve3(control, false, 'catmullrom', 0.4)
    curve.arcLengthDivisions = 600
    startDocY = view.H / 2 - control[0].y / view.wpp
    endDocY = view.H / 2 - control[control.length - 1].y / view.wpp

    const length = curve.getLength()
    dashCount = Math.min(MAX_DASHES, Math.max(2, Math.floor(length / DASH_CYCLE)))
    for (let i = 0; i < dashCount; i++) {
      const t = i / (dashCount - 1)
      curve.getPointAt(t, point)
      curve.getTangentAt(t, tangent)
      scratch.position.copy(point)
      scratch.rotation.set(0, 0, Math.atan2(tangent.y, tangent.x))
      scratch.scale.setScalar(1)
      scratch.updateMatrix()
      dashes.setMatrixAt(i, scratch.matrix)
    }
    dashes.instanceMatrix.needsUpdate = true
    dashes.count = reduce ? dashCount : 0

    // the ink is a graphic element on a wide screen and an intrusion on a
    // narrow one, where the lane is pressed against the text
    dashMat.opacity = view.W < 900 ? 0.42 : 0.9

    // Waypoints only where there is a real gutter to put them in. Below this
    // the lane is pressed against the text column, and a dart parked on it sits
    // on top of a heading, which is how they first shipped, and it looked like
    // debris rather than decoration.
    if (view.W < 1100) return

    // one dart per stop, parked on the curve with its nose along the flight
    for (const station of stations.list) {
      if (station.id === 'hero' || station.id === 'machine') continue
      const anchorDocY = station.top + station.height * 0.5
      const t = THREE.MathUtils.clamp(
        (anchorDocY - startDocY) / Math.max(1, endDocY - startDocY),
        0,
        1,
      )
      curve.getPointAt(t, point)
      curve.getTangentAt(t, tangent)
      const wrap = new THREE.Group()
      wrap.position.copy(point)
      wrap.position.z = PATH_Z - 0.3
      // nose along the direction of travel, banked a little into the turn so it
      // reads as a folded object rather than a flat silhouette
      wrap.rotation.set(0.5, 0, Math.atan2(tangent.y, tangent.x))
      const dart = createPaperDart({
        material: paperMaterial,
        outlineMaterial: inkMaterial,
        size: 2.2,
      })
      dart.setReveal(reduce ? 1 : 0)
      wrap.add(dart.group)
      object.add(wrap)
      marks.set(station.id, { wrap, dart, station, phase: marks.size * 1.7 })
    }
  }

  function update(smoothY: number, viewportH: number, dt: number) {
    if (!curve || dashCount === 0) return

    if (!reduce) {
      // the drawing front sits a little below the viewport middle, so the line
      // is always being laid down just ahead of what you are reading
      const front = THREE.MathUtils.clamp(
        (smoothY + viewportH * 0.55 - startDocY) / Math.max(1, endDocY - startDocY),
        0,
        1,
      )
      const drawn = Math.floor(front * dashCount)
      dashes.count = drawn

      // the clock, advanced unconditionally. It used to live inside the nib
      // branch below, which quietly coupled every waypoint's idle motion to
      // "is the contrail still being drawn": before the line starts and after
      // it finishes, `spin` stopped advancing and all the darts froze solid in
      // mid-bob. A clock that only ticks while something else is on screen is
      // not a clock.
      spin += dt

      if (drawn > 1 && front < 1) {
        curve.getPointAt(front, point)
        curve.getTangentAt(front, tangent)
        nib.position.copy(point)
        nib.position.z = PATH_Z + 0.05
        nib.rotation.z = Math.atan2(tangent.y, tangent.x)
        nib.scale.setScalar(1.25 + Math.sin(spin * 5) * 0.18)
        nib.visible = true
      } else {
        nib.visible = false
      }

      // A slow bob and a shallow roll: enough to look alive, no spin, since
      // spinning them was what made the old markers read as noise instead of
      // objects. But the first pass at "slow" overshot into invisible: 0.18
      // world units is 3.6 CSS px at this scale, spread over a nine-second
      // cycle, which is a peak speed of two and a half pixels per second on a
      // 43px object. That is not subtle motion, it is no motion, and the darts
      // read as stickers. Roughly doubled in travel and taken about half again
      // as fast, which is still well short of the spin that was rejected.
      for (const { wrap, dart, station, phase } of marks.values()) {
        dart.setReveal(stationProgress(station, smoothY, viewportH, 0.95, 0.45))
        wrap.rotation.x = 0.5 + Math.sin(spin * 1.25 + phase) * 0.26
        dart.group.position.y = Math.sin(spin * 1.05 + phase) * 0.42
      }
    }
  }

  function dispose() {
    for (const { dart } of marks.values()) dart.dispose()
    marks.clear()
    geo.dispose()
    dashMat.dispose()
    ;(nib.material as THREE.Material).dispose()
    dashes.dispose()
  }

  return { object, layout, update, dispose }
}
