import * as THREE from 'three'
import { contraptionOf, type ConstraintType, type Contraption } from '../contraption/contraption'
import { KEY_PAIRS } from '../contraption/parts'
import { creativeOf } from '../creative/creative'
import { PALETTE } from '../creative/tags'
import { held } from '../bindings'
import { historyOf } from '../history'
import { clipboard } from '../blueprint/clipboard'
import { createDuplicator } from '../blueprint/dupe'
import type { Prop, PropId, Sandbox } from '../sandbox'
import type { ToolInput } from './types'
import { TOOL_MODES, type ToolMode } from './toolgunText'

export { TOOL_MODES, MODE_NAMES, toolgunLine, toolgunScreen, toolgunSwatch, type ToolMode } from './toolgunText'

type Msg = { en: string; es: string }

/*
  The tool gun: under the 2 key, next to the physgun, and the way parts become a
  machine. Headless like the physgun: it reads a `ToolInput` and talks to
  the sandbox and its contraption (contraption.ts); the gun you see, its
  little screen, the tracer and the sounds are the belt's business, driven
  off the events this emits.

  Modes, stepped with R (shift+R back), the way Garry's Mod picks a tool:
    weld       click A, click B: a fixed joint. A *part* (thruster,
               hoverball, seat) is first set down on the face B was clicked
               on the way it mounts: a thruster nozzle-out, a seat on its
               floor facing the way you look. A plate or a prop is welded
               where it is
    axis       click a wheel, click the chassis: the wheel is put on that
               face with its axle along the face's normal, and hinged there.
               Its forward key rolls it the way you were looking. Anything
               else turns about the face it was clicked on
    rope       click a point on A, a point on B: a rope that length
    nocollide  click A, click B: the two pass through each other
    keys       click a thruster, wheel or hoverball to step it to its next
               key pair; right click reverses it
    paint      click a prop to paint it in the palette colour (wheel or , .
               and [ ] pick it, shown on the gun's screen); right click clears
    balloon    click a prop: a balloon of that colour is tied above it by a
               rope. Click a balloon then a prop to tie one already there;
               right click cuts a prop's ropes
    remove     click a prop to remove it; right click strips its joints
    copy       click a prop: it and everything joined to it go to the
               clipboard as a blueprint; right click takes that one prop
    paste      the clipboard as a ghost on the crosshair (blueprint/dupe.ts);
               left click places it as one undo entry, the wheel or E turns
               it, right click forgets it
  In the four two-click modes, right click cancels a first click, or with
  none pending takes that mode's joints off whatever it is aimed at.

  Every joint is one undo entry (Z takes the last one back, as it takes the
  last spawn back), and a joint that leaves with its prop takes its entry
  with it (contraption.ts), so Z never spends a press on nothing.
*/

const LABELS: Record<ConstraintType, Msg> = {
  weld: { en: 'weld', es: 'soldadura' },
  axis: { en: 'axle', es: 'eje' },
  rope: { en: 'rope', es: 'cuerda' },
  nocollide: { en: 'no-collide', es: 'sin choque' },
}

/** how far the tool reaches, units */
export const TOOL_RANGE = 120

export type ToolgunEventType = 'select' | 'join' | 'cancel' | 'set' | 'remove' | 'fail' | 'mode' | 'deny'
export interface ToolgunEvent {
  type: ToolgunEventType
  /** where the shot landed (the tracer's end), world */
  point: THREE.Vector3
  normal: THREE.Vector3
  prop: PropId
}

export interface Toolgun {
  readonly mode: ToolMode
  setMode: (m: ToolMode) => void
  cycle: (dir: number) => void
  /** paste mode is showing a ghost, so the wheel turns it and does not
      change tools */
  readonly wantsWheel: boolean
  /** the first prop of a two-click mode, once picked */
  readonly pending: PropId | null
  /** one frame; the gun is out and live */
  update: (input: ToolInput) => void
  /** the gun was put away: a half-made joint is forgotten */
  cancel: () => void
  on: (fn: (e: ToolgunEvent) => void) => () => void
  retarget: (sb: Sandbox) => void
  /** in the keys mode: the pair on the part under the crosshair */
  readonly aimedKeys: string | null
  /** the palette colour paint and balloon use, 0..11 */
  readonly color: number
  /** step the palette, wrapping */
  stepColor: (dir: number) => void
  /** the wheel means the palette in this mode, not the next tool */
  readonly wantsColorWheel: boolean
  /** `mode:step`, which changes exactly when the readout should */
  readonly state: string
  dispose: () => void
}

export function createToolgun(sbIn: Sandbox): Toolgun {
  let sb = sbIn
  let con: Contraption = contraptionOf(sb)
  let mode: ToolMode = 'weld'
  let pending: { id: PropId; local: THREE.Vector3; normal: THREE.Vector3 } | null = null
  let fireWas = false
  let altWas = false
  let modeWas = false
  let aimedKeys: string | null = null
  const dupe = createDuplicator(sb)
  /** where the paste ghost is, this frame */
  let pasteAt: THREE.Vector3 | null = null
  let color = 0
  let colorKeysWas = false
  const creative = () => creativeOf(sb)
  const fns = new Set<(e: ToolgunEvent) => void>()
  const ev: ToolgunEvent = { type: 'fail', point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), prop: -1 }
  const emit = (type: ToolgunEventType, point: THREE.Vector3 | null, normal: THREE.Vector3 | null, prop: PropId) => {
    ev.type = type
    if (point) ev.point.copy(point)
    if (normal) ev.normal.copy(normal)
    ev.prop = prop
    for (const fn of fns) fn(ev)
  }

  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const toWorld = (prop: Prop, local: THREE.Vector3, out: THREE.Vector3) => {
    sb.getTransform(prop.id, p, q)
    return out.copy(local).applyQuaternion(q).add(p)
  }
  const toLocal = (prop: Prop, world: THREE.Vector3, out: THREE.Vector3) => {
    sb.getTransform(prop.id, p, q)
    return out.copy(world).sub(p).applyQuaternion(q.invert())
  }
  const wA = new THREE.Vector3()
  const nA = new THREE.Vector3()

  const join = (A: Prop, B: Prop, hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, view: THREE.Vector3) => {
    const pend = pending!
    const type = mode as ConstraintType
    // the first click's point and face, where A is now
    toWorld(A, pend.local, wA)
    sb.getTransform(A.id, p, q)
    nA.copy(pend.normal).applyQuaternion(q)
    let made = null
    if (type === 'weld') {
      con.snapOnto(A.id, hitPoint, hitNormal, view)
      made = con.add('weld', A.id, B.id)
    } else if (type === 'axis') {
      const wheel = con.part(A.id)?.type === 'wheel'
      if (wheel) {
        con.snapOnto(A.id, hitPoint, hitNormal, view)
        made = con.add('axis', A.id, B.id, { forward: view })
      } else {
        made = con.add('axis', A.id, B.id, { at: wA, axis: nA })
      }
    } else if (type === 'rope') {
      made = con.add('rope', A.id, B.id, { at: wA, atB: hitPoint })
    } else {
      made = con.add('nocollide', A.id, B.id)
    }
    if (!made) return false
    if (!made.entry) {
      const entry = historyOf(sb).record({ label: LABELS[type], undo: () => con.remove(made.id) })
      made.entry = entry
    }
    return true
  }

  /** somebody else's prop, and the scope protects it: the gun buzzes and the
      toast says whose it is (network.denied), and nothing else happens */
  const forbidden = (prop: Prop | null, point: THREE.Vector3, normal: THREE.Vector3 | null) => {
    if (!prop || !sb.network?.may || sb.network.may(prop.id)) return false
    sb.network.denied?.(prop.id)
    emit('deny', point, normal, prop.id)
    return true
  }

  /** paint a prop (0 clears), as one undo entry that puts the old tag back */
  const paintProp = (id: PropId, idx: number, point: THREE.Vector3, normal: THREE.Vector3 | null) => {
    const cr = creative()
    if (idx === 0 && cr.tagOf(id).paint === 0) {
      emit('fail', point, normal, -1)
      return
    }
    const before = cr.paint(id, idx)
    if (before === false) {
      emit('fail', point, normal, -1)
      return
    }
    historyOf(sb).record({
      label: idx ? { en: 'paint', es: 'pintura' } : { en: 'clear paint', es: 'quitar pintura' },
      undo: () => creative().restore(id, before),
    })
    emit('set', point, normal, id)
  }

  /** the balloon mode's left click. With nothing picked, a click on a prop
      ties a new balloon above it and a click on a balloon picks it up; with
      one picked, the click ties it to what was hit */
  const balloonClick = (
    prop: Prop | null, hit: { point: THREE.Vector3 } | null, point: THREE.Vector3, normal: THREE.Vector3 | null,
  ) => {
    const cr = creative()
    const undoRope = (from: PropId, rope: number, label: Msg, props?: PropId) => {
      const entry = historyOf(sb).record({ label, kind: props !== undefined ? 'balloon' : undefined, props, undo: () => con.remove(rope) })
      for (const r of con.constraints(from)) if (r.id === rope) r.entry = entry
    }
    if (pending) {
      const A = sb.get(pending.id)
      pending = null
      const rope = A && prop && hit && prop.id !== A.id ? cr.tieExisting(A.id, prop.id, hit.point) : null
      if (rope === null || !A) {
        emit('fail', point, normal, -1)
        return
      }
      undoRope(A.id, rope, { en: 'rope', es: 'cuerda' })
      emit('join', point, normal, prop!.id)
      return
    }
    if (!prop || !hit) {
      emit('fail', point, normal, -1)
      return
    }
    if (prop.kind.id === 'balloon') {
      pending = { id: prop.id, local: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) }
      emit('select', point, normal, prop.id)
      return
    }
    const made = cr.tie(prop.id, hit.point, color + 1)
    if (!made) {
      emit('fail', point, normal, -1)
      return
    }
    undoRope(made.balloon, made.rope, { en: 'balloon', es: 'globo' }, made.balloon)
    emit('join', point, normal, prop.id)
  }

  const primary = (input: ToolInput) => {
    const hit = sb.raycast(input.aim.eye, input.aim.dir, TOOL_RANGE, { props: true, world: true })
    const point = hit?.point ?? p.copy(input.aim.dir).multiplyScalar(TOOL_RANGE).add(input.aim.eye)
    const prop = hit?.prop ?? null
    const normal = hit?.normal ?? null
    if (forbidden(prop, point, normal)) return
    if (mode === 'keys') {
      if (prop && con.cycleKeys(prop.id, 1) >= 0) emit('set', point, normal, prop.id)
      else emit('fail', point, normal, -1)
      return
    }
    if (mode === 'copy') {
      emit(dupe.copy(prop, false) ? 'select' : 'fail', point, normal, prop?.id ?? -1)
      return
    }
    if (mode === 'paste') {
      const done = pasteAt ? dupe.paste(pasteAt) : false
      emit(done ? 'join' : 'fail', point, normal, -1)
      return
    }
    if (mode === 'remove') {
      if (prop) {
        const id = prop.id
        emit('remove', point, normal, id)
        sb.remove(id)
      } else emit('fail', point, normal, -1)
      return
    }
    if (mode === 'paint') {
      if (prop) paintProp(prop.id, color + 1, point, normal)
      else emit('fail', point, normal, -1)
      return
    }
    if (mode === 'balloon') {
      balloonClick(prop, hit, point, normal)
      return
    }
    if (!pending) {
      if (!prop || !hit) {
        emit('fail', point, normal, -1)
        return
      }
      pending = { id: prop.id, local: toLocal(prop, hit.point, new THREE.Vector3()), normal: hit.normal.clone() }
      // the face's normal in the prop's own frame, so it follows it
      sb.getTransform(prop.id, p, q)
      pending.normal.applyQuaternion(q.invert())
      emit('select', point, normal, prop.id)
      return
    }
    const A = sb.get(pending.id)
    if (!A) {
      pending = null
      emit('fail', point, normal, -1)
      return
    }
    if (!prop || !hit || prop.id === A.id) {
      // the world is not something to join to (freeze it with the physgun
      // instead), and nor is the thing itself
      emit('fail', point, normal, -1)
      return
    }
    const ok = join(A, prop, hit.point, hit.normal, input.aim.dir)
    pending = null
    emit(ok ? 'join' : 'fail', point, normal, prop.id)
  }

  const secondary = (input: ToolInput) => {
    const hit = sb.raycast(input.aim.eye, input.aim.dir, TOOL_RANGE, { props: true, world: true })
    const point = hit?.point ?? p.copy(input.aim.dir).multiplyScalar(TOOL_RANGE).add(input.aim.eye)
    const prop = hit?.prop ?? null
    if (mode === 'paste') {
      const had = !!clipboard.get()
      dupe.clear()
      emit(had ? 'cancel' : 'fail', point, hit?.normal ?? null, -1)
      return
    }
    if (mode === 'copy') {
      emit(dupe.copy(prop, true) ? 'select' : 'fail', point, hit?.normal ?? null, prop?.id ?? -1)
      return
    }
    if (pending) {
      pending = null
      emit('cancel', point, hit?.normal ?? null, -1)
      return
    }
    if (forbidden(prop, point, hit?.normal ?? null)) return
    if (!prop) {
      emit('fail', point, hit?.normal ?? null, -1)
      return
    }
    let n = 0
    if (mode === 'keys') {
      const st = con.part(prop.id)
      if (st && st.type !== 'plate' && st.type !== 'seat') {
        con.flip(prop.id)
        n = 1
      }
    }
    else if (mode === 'remove') n = con.strip(prop.id)
    else if (mode === 'paint') {
      paintProp(prop.id, 0, point, hit?.normal ?? null)
      return
    } else if (mode === 'balloon') n = con.strip(prop.id, 'rope')
    else n = con.strip(prop.id, mode)
    emit(n ? 'set' : 'fail', point, hit?.normal ?? null, n ? prop.id : -1)
  }

  const stepColor = (dir: number) => {
    const n = PALETTE.length
    color = (((color + dir) % n) + n) % n
    emit('mode', null, null, -1)
  }

  const update = (input: ToolInput) => {
    if (pending && !sb.get(pending.id)) pending = null
    const fire = input.fire
    const alt = input.alt
    const modeKey = input.reload
    if (modeKey && !modeWas) {
      const i = TOOL_MODES.indexOf(mode)
      const n = TOOL_MODES.length
      mode = TOOL_MODES[(((i + (input.snap ? -1 : 1)) % n) + n) % n]
      pending = null
      emit('mode', null, null, -1)
    }
    if (fire && !fireWas) primary(input)
    if (alt && !altWas) secondary(input)
    fireWas = fire
    altWas = alt
    modeWas = modeKey
    if (mode === 'paint' || mode === 'balloon') {
      const k = input.keys
      const step = k ? (held(k, 'colorNext') ? 1 : 0) - (held(k, 'colorPrev') ? 1 : 0) : 0
      if (step && !colorKeysWas) stepColor(step)
      colorKeysWas = step !== 0
    } else colorKeysWas = false
    // the keys mode reads the pair off whatever it is pointed at
    if (mode === 'keys') {
      const hit = sb.raycast(input.aim.eye, input.aim.dir, TOOL_RANGE, { props: true, world: false })
      const st = hit?.prop ? con.part(hit.prop.id) : null
      aimedKeys = st && st.keys >= 0 ? `${KEY_PAIRS[st.keys].label}${st.flip ? ' rev' : ''}` : null
    } else aimedKeys = null
    // paste keeps its ghost on whatever the crosshair is on
    if (mode === 'paste') {
      const hit = sb.raycast(input.aim.eye, input.aim.dir, TOOL_RANGE, { props: true, world: true })
      pasteAt = dupe.hover(input, hit)
      aimedKeys = dupe.label
    } else {
      pasteAt = null
      dupe.hide()
    }
  }

  return {
    get mode() {
      return mode
    },
    setMode: (m) => {
      if (m === mode) return
      mode = m
      pending = null
      emit('mode', null, null, -1)
    },
    cycle: (dir) => {
      const i = TOOL_MODES.indexOf(mode)
      const n = TOOL_MODES.length
      mode = TOOL_MODES[(((i + dir) % n) + n) % n]
      pending = null
      emit('mode', null, null, -1)
    },
    get pending() {
      return pending?.id ?? null
    },
    get wantsWheel() {
      return mode === 'paste' && dupe.wantsWheel
    },
    update,
    cancel: () => {
      dupe.hide()
      pending = null
      fireWas = altWas = modeWas = false
    },
    on: (fn) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    retarget: (next) => {
      sb = next
      con = contraptionOf(next)
      pending = null
      dupe.retarget(next)
    },
    get aimedKeys() {
      return aimedKeys
    },
    get color() {
      return color
    },
    stepColor,
    get wantsColorWheel() {
      return mode === 'paint' || mode === 'balloon'
    },
    get state() {
      return `${mode}:${pending || (mode === 'paste' && clipboard.get()) ? 1 : 0}${mode === 'paint' || mode === 'balloon' ? `:${color}` : ''}`
    },
    dispose: () => {
      fns.clear()
      dupe.dispose()
    },
  }
}
