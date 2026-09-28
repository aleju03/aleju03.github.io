import * as THREE from 'three'
import type { Prop, Sandbox } from '../sandbox'
import type { ToolInput } from '../tools/types'
import { capture, connectedTo, place, roomFor, type Blueprint, type CaptureFail, type PlaceFail } from './blueprint'
import { buildNotices, clipboard } from './clipboard'
import { createGhost, type Ghost } from './ghost'

/*
  The duplicator: the tool gun's copy and paste modes, as one object.

  Copy takes the prop under the crosshair and everything joined to it (welds,
  axles, ropes, no-collides: the whole connected graph, seats and parts
  included) into the clipboard as a blueprint; right click takes that one
  prop alone. Paste holds the clipboard as a ghost on whatever the crosshair
  is on, turns it with the wheel (fifteen degrees a notch, forty-five with
  shift) or E (a quarter turn), and a left click places it through the
  ordinary spawn path as a single undo entry (blueprint.ts's `place`).

  The wheel is the belt's tool switcher when nothing is held, so a paste that
  is showing a ghost says it `wantsWheel` and the belt lets it through.
  Sending the ghost's colour red when the paste would not fit under the
  prop cap costs one comparison per frame, and is how the player learns
  before the click rather than after it.

  Headless: the ghost is null, everything else is the same.
*/

const REASON_TEXT: Record<CaptureFail | PlaceFail, { en: string; es: string }> = {
  empty: { en: 'nothing to copy there', es: 'no hay nada que copiar ahí' },
  toobig: { en: 'that build is too big (300 props at most)', es: 'esa construcción es demasiado grande (300 objetos como máximo)' },
  limit: { en: 'not enough room for that under your prop limit', es: 'no cabe dentro de tu límite de objetos' },
  notready: { en: 'the world is still loading', es: 'el mundo aún está cargando' },
  kind: { en: 'that build uses a prop this version does not have', es: 'esa construcción usa un objeto que esta versión no tiene' },
}
export const reasonText = (r: CaptureFail | PlaceFail) => REASON_TEXT[r]

export interface Duplicator {
  /** copy what `prop` is joined to (or just it) into the clipboard */
  copy: (prop: Prop | null, single: boolean) => boolean
  /** paste mode, one frame: move the ghost, take the wheel and E. Returns
      where a click would land, or null with nothing to aim at */
  hover: (input: ToolInput, hit: { point: THREE.Vector3 } | null) => THREE.Vector3 | null
  /** place the clipboard at `at` */
  paste: (at: THREE.Vector3) => boolean
  /** drop the clipboard */
  clear: () => void
  /** the ghost goes away (mode changed, tool put away) */
  hide: () => void
  /** whether a ghost is up and so the wheel is ours */
  readonly wantsWheel: boolean
  /** a readout for the gun's little screen */
  readonly label: string | null
  retarget: (sb: Sandbox) => void
  dispose: () => void
}

const STEP = Math.PI / 12
const EDGE = 4 * STEP

export function createDuplicator(sbIn: Sandbox): Duplicator {
  let sb = sbIn
  let yaw = 0
  let ghost: Ghost | null = null
  let ghostFor: Blueprint | null = null
  let eWas = false
  const at = new THREE.Vector3()

  const drop = () => {
    ghost?.dispose()
    ghost = null
    ghostFor = null
  }
  const offClip = clipboard.subscribe(drop)

  return {
    copy: (prop, single) => {
      if (!prop) {
        buildNotices.emit({ tone: 'err', ...REASON_TEXT.empty })
        return false
      }
      const r = capture(sb, single ? [prop.id] : connectedTo(sb, prop.id))
      if (!r.ok) {
        buildNotices.emit({ tone: 'err', ...REASON_TEXT[r.reason] })
        return false
      }
      clipboard.set(r.bp)
      yaw = 0
      const n = r.bp.props.length
      buildNotices.emit({
        tone: 'ok',
        en: `copied ${n} prop${n === 1 ? '' : 's'}: switch the tool gun to paste (r)`,
        es: `copiado${n === 1 ? '' : 's'} ${n} objeto${n === 1 ? '' : 's'}: pasa la pistola a pegar (r)`,
      })
      return true
    },
    hover: (input, hit) => {
      const bp = clipboard.get()
      if (!bp) {
        ghost?.hide()
        return null
      }
      if (input.wheel) {
        yaw += Math.sign(input.wheel) * (input.snap ? 3 * STEP : STEP)
        input.wheel = 0
      }
      if (input.rotate && !eWas) yaw += EDGE
      eWas = input.rotate
      if (ghostFor !== bp) {
        ghost?.dispose()
        ghost = createGhost(sb, bp)
        ghostFor = bp
      }
      if (!hit) {
        ghost?.hide()
        return null
      }
      at.copy(hit.point)
      ghost?.place(at, yaw, bp.props.length <= roomFor(sb), performance.now() / 1000)
      return at
    },
    paste: (where) => {
      const bp = clipboard.get()
      if (!bp) return false
      const r = place(sb, bp, { at: where, yaw })
      if (!r.ok) {
        const t = REASON_TEXT[r.reason]
        buildNotices.emit({
          tone: 'err',
          en: r.reason === 'limit' ? `${t.en} (room for ${r.room ?? 0})` : t.en,
          es: r.reason === 'limit' ? `${t.es} (caben ${r.room ?? 0})` : t.es,
        })
        return false
      }
      return true
    },
    clear: () => {
      clipboard.set(null)
      yaw = 0
    },
    hide: () => {
      ghost?.hide()
      eWas = false
    },
    get wantsWheel() {
      return !!clipboard.get()
    },
    get label() {
      const bp = clipboard.get()
      return bp ? `${bp.props.length} props` : null
    },
    retarget: (next) => {
      drop()
      sb = next
    },
    dispose: () => {
      drop()
      offClip()
    },
  }
}
