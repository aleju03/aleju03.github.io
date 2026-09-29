import * as THREE from 'three'
import type { RoundState, RoundEvent } from '../net/remoteRounds'
import type { RoundModeId } from '../net/roundProtocol'
import { KINDS, shapeBottom, shapeExtents } from '../sandbox/kinds'
import { announce, MODE_DEFS, LEVEL_NAMES } from './defs'
import { createDeathmatch } from './deathmatch'
import { createPropHunt } from './propHunt'
import { createHideSeek } from './hideSeek'
import { createRace } from './race'
import { createBuild } from './build'
import type { ModeClient, ModeCtx, ModeHost, ModeInput, WalkerPose } from './types'

/*
  The round director: the one thing the scene talks to.

  It listens to the round store (net/remoteRounds.ts) and to nothing else.
  When the player has a place in a round it builds that mode's client module
  (deathmatch.ts ... build.ts), enters it, ticks it and lets it go when the
  round ends or the player leaves it. What the scene asks it, every frame or
  when it matters, is a handful of plain questions: is the walker held
  (`frozen`), are the tools put away (`locked`), is the screen covered
  (`blind`), where does a death stand you up (`respawnSpot`), what do the
  disguised look like and how big are they to a bullet. It answers the
  server's stage directions for every mode alike: `go` is the level cut,
  `tp` is a teleport, `ev` is a line in the chat rail.

  **Disguises.** A prop-hunt disguise is another player's body replaced by a
  catalogue prop. It is drawn as a `BatchProxy` (sandbox/batch.ts) parented to
  the live sandbox root, the same thing every prop is, so it is one more
  instance in a batch that already exists and links no program; if a kind's
  mesh is not a proxy it is not drawn rather than drawn as a plain mesh that
  would. The body is hidden by the avatars (`hidden`), and for a ray the body
  is the kind's own shape (`hitbox`: a cylinder that covers its extents),
  which is what the weapons test.

  Everything here keeps to the runtime's rule: no React, no DOM, and it runs
  headless (a probe can feed a store and read the answers).
*/

export interface RoundDirector {
  tick: (input: ModeInput) => void
  frozen: () => boolean
  locked: () => boolean
  blind: () => boolean
  respawnSpot: () => WalkerPose | null
  objective: () => { en: string; es: string } | null
  /** we are wearing a disguise: a shot does not knock a prop over */
  disguisedSelf: () => boolean
  /** an avatar's body should not be drawn (it is a prop) */
  hidden: (id: number) => boolean
  /** a bullet's cylinder for this player, when it is not a body's */
  hitbox: (id: number) => { r: number; h: number } | null
  /** place the disguises (each frame, with the others' poses) */
  syncDisguises: (root: THREE.Object3D | null, others: Iterable<{ id: number; x: number; y: number; z: number; yaw: number }>) => void
  /** the mode the player is playing right now, if any */
  readonly active: RoundModeId | null
  dispose: () => void
}

const FACTORIES: Record<RoundModeId, (c: ModeCtx) => ModeClient> = {
  deathmatch: createDeathmatch,
  prophunt: createPropHunt,
  hide: createHideSeek,
  race: createRace,
  build: createBuild,
}

interface Disguise {
  kind: string
  proxy: THREE.Object3D
  lift: number
}

export function createRoundDirector(store: RoundState, host: ModeHost): RoundDirector {
  let mode: ModeClient | null = null
  let modeId: RoundModeId | null = null
  const ctx: ModeCtx = { store, host }

  const sync = () => {
    const want = store.inRound ? store.mode : null
    if (want === modeId) return
    mode?.leave?.()
    mode = null
    modeId = want
    if (want) {
      mode = FACTORIES[want](ctx)
      mode.enter?.()
      if (store.phase === 'playing') mode.playing?.()
    }
  }

  const offStore = store.subscribe(sync)
  const offEvents = store.on((e: RoundEvent) => {
    switch (e.type) {
      case 'phase':
        sync()
        if (e.to === 'playing') mode?.playing?.()
        break
      case 'go': {
        const nm = LEVEL_NAMES[e.level]?.[host.lang()] ?? e.level
        if (e.here) break
        const r = host.goLevel(e.level)
        host.say(host.lang() === 'es' ? `Rumbo a ${nm}` : `Heading to ${nm}`, r === 'busy' ? 'err' : 'system')
        break
      }
      case 'tp':
        if (host.levelId() === store.level && store.inRound) {
          host.teleport(e.x, e.z, undefined, e.yaw)
          mode?.teleported?.()
        }
        break
      case 'ev': {
        const text = announce(e.code, e.data, { nameOf: host.nameOf, you: store.you, lang: host.lang() })
        if (text) host.say(text, e.code === 'slow' ? 'err' : 'system')
        break
      }
      case 'no': {
        // refusals are worded by the menu that asked; the console prints them here
        break
      }
    }
  })

  /* ---- disguises ---- */
  const disguises = new Map<number, Disguise>()
  const kindInfo = new Map<string, { lift: number; r: number; h: number }>()
  const infoOf = (kind: string) => {
    let i = kindInfo.get(kind)
    if (!i) {
      const k = KINDS[kind]
      if (!k) return null
      const ex = shapeExtents(k.shape)
      i = { lift: shapeBottom(k.shape), r: Math.max(ex.x, ex.z), h: ex.y * 2 }
      kindInfo.set(kind, i)
    }
    return i
  }
  const dropDisguise = (id: number) => {
    const d = disguises.get(id)
    if (!d) return
    d.proxy.removeFromParent()
    disguises.delete(id)
  }

  return {
    get active() { return modeId },
    tick(input) {
      mode?.tick?.(input)
    },
    frozen: () => !!mode?.frozen?.(),
    locked: () => !!mode?.locked?.(),
    blind: () => !!mode?.blind?.(),
    respawnSpot: () => (store.phase === 'playing' ? mode?.respawnSpot?.() ?? null : null),
    objective: () => mode?.objective?.() ?? null,
    disguisedSelf: () => store.inRound && store.disguises.has(store.you),
    hidden: (id) => store.disguises.has(id) && infoOf(store.disguises.get(id)!) !== null,
    hitbox(id) {
      const kind = store.disguises.get(id)
      const i = kind ? infoOf(kind) : null
      return i ? { r: i.r, h: i.h } : null
    },
    syncDisguises(root, others) {
      if (!root) {
        for (const id of [...disguises.keys()]) dropDisguise(id)
        return
      }
      const seen = new Set<number>()
      for (const o of others) {
        const kind = store.disguises.get(o.id)
        if (!kind) continue
        let d = disguises.get(o.id)
        if (d && d.kind !== kind) {
          dropDisguise(o.id)
          d = undefined
        }
        if (!d) {
          const info = infoOf(kind)
          const proxy = info ? KINDS[kind].mesh?.() : null
          // only a batch proxy draws with a program that already exists
          if (!info || !proxy || !(proxy as { isBatchProxy?: boolean }).isBatchProxy) continue
          root.add(proxy)
          d = { kind, proxy, lift: info.lift }
          disguises.set(o.id, d)
        }
        if (d.proxy.parent !== root) root.add(d.proxy)
        d.proxy.position.set(o.x, o.y + d.lift, o.z)
        d.proxy.rotation.set(0, o.yaw, 0)
        d.proxy.updateMatrix()
        seen.add(o.id)
      }
      for (const id of [...disguises.keys()]) if (!seen.has(id)) dropDisguise(id)
    },
    dispose() {
      offStore()
      offEvents()
      mode?.leave?.()
      for (const id of [...disguises.keys()]) dropDisguise(id)
    },
  }
}

export { MODE_DEFS }
