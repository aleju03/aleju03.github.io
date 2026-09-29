import * as THREE from 'three'
import { BatchProxy } from '../batch'
import type { Prop, PropId, Sandbox, Vec3Like } from '../sandbox'
import { contraptionOf } from '../contraption/contraption'
import './kinds'
import { CDIMS, lampGeometryOf } from './models'
import { fuseTick, lampClick, paintSpray, signWrite, tieSqueak } from './sfx'
import { acquireTile, releaseTile, signGeometry } from './signs'
import { PALETTE, cleanSign, decodeTag, encodeTag, tagKey, type Tag } from './tags'

/*
  The creative props' behaviour: what a paint pot, a balloon, a lamp, a sign
  and a stick of dynamite do that a crate does not. One controller per
  sandbox (`creativeOf(sb)`), subscribed to the sandbox's spawn, removal and
  slice hooks, headless like the rest of the sim.

  Everything a peer must agree on lives in one place, the prop's `data.tag`
  (tags.ts: paint, lamp switch, sign text), and everything drawn is derived
  from it by `apply`, so a tag that arrives over the wire, an undo that
  restores an old one and a local edit all take the same road. The network
  (net/remoteProps.ts) sends `data.tag` whenever it changes and hands a
  received one to `receive`; nothing in here knows about sockets.

  What each prop is:
  - **paint** is the batch proxy's per-instance `tint` (batch.ts already
    multiplies it into the atlas), scaled up a little for anything that is
    not white to begin with so a paint survives a brown crate.
  - **balloons** lift through `addForce` once per slice, on the simulator that
    owns them: a fixed pull that fades as the balloon reaches `TERMINAL` (a
    drag, so more balloons are faster and one never leaves at the speed of a
    rocket), fades out toward `CEILING` and pops above `POP_ALTITUDE`. They
    are tied with the contraption's own rope, so a bunch lifts a crate for the
    reason a bunch of thrusters lift a beam. They break at a blow (the kind's
    `breaks`), which is what a pistol shot or a fall is.
  - **lamps** are a light for the look's fake pools (`lampPools`), never a
    scene light, which would relink every lit program. On or off is the tag's
    flag; the off lamp draws a different geometry (a dead bulb), which costs
    nothing because batches are keyed by geometry.
  - **signs** borrow a text tile of the atlas (signs.ts) and draw the
    geometry that shows it.
  - **dynamite** is a barrel with a five-second fuse (the kind's `explodes.fuse`,
    breakables.ts does the burning); here it only blinks faster as it burns
    down and ticks once a second.
*/

/** the lift of one balloon, kg*u/s^2: three lift a big crate, one a small */
export const LIFT = 520
/** the speed a balloon stops gaining at, u/s */
const TERMINAL = 22
/** the lift fades to nothing between these heights */
const CEILING = [230, 300] as const
/** and a balloon that gets here pops (the air is thin, the latex is not) */
const POP_ALTITUDE = 330
/** balloons alive at once in one sandbox: the tool refuses past this */
export const MAX_BALLOONS = 40
/** the rope from a tied balloon to what it lifts, units */
export const ROPE = 3
/** how far a lamp's light is heard from: pools within this of the lens */
const LAMP_RANGE = 90
/** a lamp's pool radius, units */
export const LAMP_RADIUS = 10

export type UseResult = 'lamp' | 'fuse' | 'sign' | null

export interface Creative {
  /** a prop's tag, decoded */
  tagOf: (id: PropId) => Tag
  /** the raw tag (what the wire carries) */
  rawTag: (id: PropId) => number[] | null
  /** set part of a prop's tag; false when there is no such prop. Returns the
      raw tag it had, so a caller can put it back (`restore`) */
  edit: (id: PropId, patch: Partial<Tag>) => number[] | null | false
  /** put a raw tag back (an undo), or set one received from the wire */
  restore: (id: PropId, raw: number[] | null) => void
  /** the wire delivered this tag for this prop */
  receive: (p: Prop, raw: number[] | null) => void
  /** re-derive the drawn state from the tag */
  apply: (p: Prop) => void
  /** paint a prop with palette colour `idx` (1..12, 0 clears) */
  paint: (id: PropId, idx: number) => number[] | null | false
  /** write text on a sign; the text as filtered, or null when not a sign */
  write: (id: PropId, text: string) => string | null
  /** what E does to the prop under the crosshair */
  use: (id: PropId) => UseResult
  /** the prompt E shows, in a language; null when E does nothing here */
  verb: (id: PropId, lang: 'en' | 'es') => string | null
  /** tie a new balloon of palette colour `idx` to `target` at `point`; the
      new balloon's id and the rope's, or null (too many, or it will not go) */
  tie: (target: PropId, point: Vec3Like, idx: number) => { balloon: PropId; rope: number } | null
  /** rope an existing balloon to a prop at a point on it */
  tieExisting: (balloon: PropId, target: PropId, point: Vec3Like) => number | null
  /** the nearest lit lamps to (x, z) for the look's pools: xyz into `xyz`,
      the radius into `radii`, up to `max`; returns how many */
  lampPools: (x: number, z: number, xyz: Float32Array, radii: Float32Array, max: number) => number
  readonly balloons: number
  readonly lamps: number
  /** bumps whenever a lamp appears, goes or is switched, so the scene can
      re-ask for its pools at once instead of at its next scheduled look */
  readonly lampVersion: number
  /** a sign is being edited: the one E last picked */
  signTarget: PropId | null
}

const creatives = new WeakMap<Sandbox, Creative>()

export const creativeOf = (sb: Sandbox): Creative => {
  let c = creatives.get(sb)
  if (!c) {
    c = createCreative(sb)
    creatives.set(sb, c)
  }
  return c
}

const WHITE_BASED = new Set(['balloon'])
const tints = new Map<string, THREE.Color>()
const tintFor = (kind: string, idx: number) => {
  const key = `${WHITE_BASED.has(kind) ? 1 : 0}:${idx}`
  let t = tints.get(key)
  if (!t) {
    t = new THREE.Color(PALETTE[idx - 1].hex)
    if (!WHITE_BASED.has(kind)) t.multiplyScalar(1.7)
    tints.set(key, t)
  }
  return t
}
const HOT = new THREE.Color(2.4, 1.5, 0.7)
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function createCreative(sb: Sandbox): Creative {
  const balloons = new Set<PropId>()
  const lamps = new Set<PropId>()
  const dynamites = new Set<PropId>()
  const tmp = new THREE.Vector3()
  const q = new THREE.Quaternion()
  let clock = 0
  let lampVersion = 0
  const me: Creative = {
    signTarget: null,
  } as Creative

  const rawOf = (p: Prop) => (p.data.tag as number[] | null | undefined) ?? null
  const proxyOf = (p: Prop): BatchProxy | null => {
    const m = p.mesh as BatchProxy | null
    return m && m.isBatchProxy ? m : null
  }

  /** the tile a sign is showing and the text that tile was acquired for */
  const setSignText = (p: Prop, text: string) => {
    const held = p.data.signText as string | undefined
    if (held === text && p.data.signTile !== undefined) return
    if (typeof p.data.signTile === 'number') releaseTile(p.data.signTile)
    const tile = acquireTile(text)
    p.data.signTile = tile
    p.data.signText = text
    const px = proxyOf(p)
    if (px) px.geo = signGeometry(tile)
  }

  const apply = (p: Prop) => {
    const t = decodeTag(rawOf(p))
    const px = proxyOf(p)
    const id = p.kind.id
    if (px) px.tint = t.paint ? tintFor(id, t.paint) : null
    if (id === 'lamp') {
      if (px) px.geo = lampGeometryOf(!t.off)
      if (p.data.lampOn !== !t.off) lampVersion++
      p.data.lampOn = !t.off
    } else if (id === 'sign') setSignText(p, t.text)
  }

  const edit = (id: PropId, patch: Partial<Tag>) => {
    const p = sb.get(id)
    if (!p) return false
    // protection: somebody else's protected prop keeps its paint, its lamp
    // switch and its words (the server refuses the same edit); the gun buzzes
    if (sb.network?.may && !sb.network.may(id)) {
      sb.network.denied?.(id)
      return false
    }
    const before = rawOf(p)
    const next = encodeTag({ ...decodeTag(before), ...patch })
    p.data.tag = next
    apply(p)
    return before
  }

  /* ---------------------------------------------------------- spawns -- */

  sb.onSpawn((p) => {
    switch (p.kind.id) {
      case 'balloon':
        balloons.add(p.id)
        // a balloon nobody chose a colour for is any colour
        if (!p.data.tag && !p.data.net) p.data.tag = encodeTag({ paint: 1 + Math.floor(Math.random() * PALETTE.length), off: false, text: '' })
        break
      case 'lamp':
        lamps.add(p.id)
        lampVersion++
        break
      case 'dynamite':
        dynamites.add(p.id)
        break
      case 'sign':
        break
    }
    if (p.data.tag || p.kind.id === 'lamp' || p.kind.id === 'sign') apply(p)
  })
  sb.onRemove((p) => {
    balloons.delete(p.id)
    if (lamps.delete(p.id)) lampVersion++
    dynamites.delete(p.id)
    if (typeof p.data.signTile === 'number') {
      releaseTile(p.data.signTile)
      p.data.signTile = undefined
    }
    if (me.signTarget === p.id) me.signTarget = null
  })

  /* --------------------------------------------------------- balloons -- */

  sb.onBeforeSlice((h) => {
    clock += h
    if (!balloons.size) return
    for (const id of balloons) {
      const p = sb.get(id)
      if (!p || p.parked || !sb.isAuthority(id)) continue
      const t = p.body.translation()
      if (t.y > POP_ALTITUDE) {
        sb.damage(id, 999)
        continue
      }
      const v = p.body.linvel()
      const gain = Math.max(0, 1 - v.y / TERMINAL) * (1 - smooth(CEILING[0], CEILING[1], t.y))
      // a lazy sway, so a bunch of them does not rise like a rod
      const sway = Math.sin(clock * 0.9 + id * 1.7) * 0.06
      const cross = Math.cos(clock * 0.7 + id * 2.3) * 0.06
      sb.addForce(id, { x: LIFT * gain * sway, y: LIFT * gain, z: LIFT * gain * cross })
    }
  })

  const rope = (balloon: PropId, target: PropId, point: Vec3Like) => {
    const b = sb.get(balloon)
    if (!b) return null
    const bt = b.body.translation()
    const made = contraptionOf(sb).add('rope', target, balloon, {
      at: point,
      atB: { x: bt.x, y: bt.y - CDIMS.balloon.ry, z: bt.z },
    })
    return made ? made.id : null
  }

  me.tieExisting = (balloon, target, point) => {
    if (balloon === target) return null
    const id = rope(balloon, target, point)
    if (id !== null) {
      const b = sb.get(balloon)
      if (b) {
        const t = b.body.translation()
        tieSqueak(t.x, t.y, t.z)
      }
    }
    return id
  }

  me.tie = (target, point, idx) => {
    if (balloons.size >= MAX_BALLOONS || !sb.get(target)) return null
    const at = { x: point.x, y: point.y + ROPE + CDIMS.balloon.ry, z: point.z }
    const tag = encodeTag({ paint: Math.max(0, Math.min(PALETTE.length, idx)), off: false, text: '' })
    const balloon = sb.spawn('balloon', at, { data: { tag } })
    const ropeId = rope(balloon, target, point)
    if (ropeId === null) {
      sb.remove(balloon)
      return null
    }
    tieSqueak(point.x, point.y, point.z)
    return { balloon, rope: ropeId }
  }

  /* ------------------------------------------------------------- lamps -- */

  const bulb = new THREE.Vector3()
  const dist = new Float32Array(16)
  me.lampPools = (x, z, xyz, radii, max) => {
    let n = 0
    const cap = Math.min(max, dist.length)
    if (cap <= 0) return 0
    for (const id of lamps) {
      const p = sb.get(id)
      if (!p || p.parked || !p.data.lampOn) continue
      const t = p.body.translation()
      const d = (t.x - x) ** 2 + (t.z - z) ** 2
      if (d > LAMP_RANGE * LAMP_RANGE) continue
      if (n === cap && d >= dist[n - 1]) continue
      const r = p.body.rotation()
      q.set(r.x, r.y, r.z, r.w)
      bulb.set(0, CDIMS.lamp.bulbY, 0).applyQuaternion(q)
      let j = n < cap ? n++ : n - 1
      while (j > 0 && dist[j - 1] > d) {
        dist[j] = dist[j - 1]
        xyz.copyWithin(j * 3, (j - 1) * 3, j * 3)
        radii[j] = radii[j - 1]
        j--
      }
      dist[j] = d
      xyz[j * 3] = t.x + bulb.x
      xyz[j * 3 + 1] = t.y + bulb.y
      xyz[j * 3 + 2] = t.z + bulb.z
      radii[j] = LAMP_RADIUS
    }
    return n
  }

  /* ------------------------------------------------------- dynamite -- */

  sb.onAfterSlice((h) => {
    if (!dynamites.size) return
    for (const id of dynamites) {
      const p = sb.get(id)
      if (!p) continue
      const life = p.data.life as { fuse: number; lit: number; boom: number } | undefined
      const px = proxyOf(p)
      if (!life || life.fuse < 0) {
        if (p.data.blinking && px) {
          p.data.blinking = false
          apply(p)
        }
        p.data.tickSec = undefined
        continue
      }
      // a lit fuse: the bundle flashes hot, faster as it burns down, and
      // ticks on each whole second
      const left = Math.max(0, life.fuse)
      const total = Math.max(0.5, life.lit)
      const burnt = 1 - left / total
      p.data.phase = ((p.data.phase as number | undefined) ?? 0) + h * (5 + 20 * burnt * burnt)
      if (px) {
        px.tint = Math.sin((p.data.phase as number) * Math.PI * 2) > 0 ? HOT : (decodeTag(rawOf(p)).paint ? tintFor('dynamite', decodeTag(rawOf(p)).paint) : null)
        p.data.blinking = true
      }
      const sec = Math.ceil(left)
      if (sec !== p.data.tickSec) {
        p.data.tickSec = sec
        if (sec > 0 && sb.getTransform(id, tmp)) fuseTick(tmp.x, tmp.y, tmp.z, burnt)
      }
    }
  })

  /* ------------------------------------------------------------- tags -- */

  me.tagOf = (id) => decodeTag(sb.get(id) ? rawOf(sb.get(id)!) : null)
  me.rawTag = (id) => (sb.get(id) ? rawOf(sb.get(id)!) : null)
  me.edit = edit
  me.restore = (id, raw) => {
    const p = sb.get(id)
    if (!p) return
    p.data.tag = raw
    apply(p)
  }
  me.receive = (p, raw) => {
    if (tagKey(rawOf(p)) === tagKey(raw)) return
    p.data.tag = raw
    apply(p)
  }
  me.apply = apply

  me.paint = (id, idx) => {
    const p = sb.get(id)
    if (!p) return false
    const before = edit(id, { paint: Math.max(0, Math.min(PALETTE.length, idx)) })
    if (before !== false && sb.getTransform(id, tmp)) paintSpray(tmp.x, tmp.y, tmp.z)
    return before
  }

  me.write = (id, raw) => {
    const p = sb.get(id)
    if (!p || p.kind.id !== 'sign') return null
    const text = cleanSign(raw)
    if (edit(id, { text }) === false) return null
    if (sb.getTransform(id, tmp)) signWrite(tmp.x, tmp.y, tmp.z)
    return text
  }

  /* ----------------------------------------------------------- use -- */

  me.use = (id) => {
    const p = sb.get(id)
    if (!p) return null
    switch (p.kind.id) {
      case 'lamp': {
        const t = decodeTag(rawOf(p))
        if (edit(id, { off: !t.off }) === false) return null
        if (sb.getTransform(id, tmp)) lampClick(tmp.x, tmp.y + CDIMS.lamp.bulbY, tmp.z, t.off)
        return 'lamp'
      }
      case 'dynamite': {
        const life = p.data.life as { fuse: number; boom: number } | undefined
        if (life && (life.fuse >= 0 || life.boom >= 0)) return null
        sb.ignite(id)
        return 'fuse'
      }
      case 'sign':
        me.signTarget = id
        return 'sign'
      default:
        return null
    }
  }

  me.verb = (id, lang) => {
    const p = sb.get(id)
    if (!p) return null
    const es = lang === 'es'
    switch (p.kind.id) {
      case 'lamp':
        return decodeTag(rawOf(p)).off ? (es ? 'encender la lámpara' : 'switch the lamp on') : (es ? 'apagar la lámpara' : 'switch the lamp off')
      case 'dynamite': {
        const life = p.data.life as { fuse: number; boom: number } | undefined
        if (life && (life.fuse >= 0 || life.boom >= 0)) return null
        return es ? 'encender la mecha' : 'light the fuse'
      }
      case 'sign':
        return es ? 'escribir en el letrero' : 'write on the sign'
      default:
        return null
    }
  }

  Object.defineProperty(me, 'balloons', { get: () => balloons.size })
  Object.defineProperty(me, 'lamps', { get: () => lamps.size })
  Object.defineProperty(me, 'lampVersion', { get: () => lampVersion })
  return me
}
