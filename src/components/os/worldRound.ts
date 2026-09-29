import { useSyncExternalStore } from 'react'
import type { RoundState } from '../../game/net/remoteRounds'
import type { RoundClientMessage } from '../../game/net/roundProtocol'

/*
  The rounds, as the menus see them: a tiny subscribable bridge between the
  round store CrtScene owns (game/net/remoteRounds.ts) and the React that
  draws the play page, the strip on the map sheet, the HUD and the results.

  The store is the truth and lives inside the scene; the pause sheet and the
  map sheet are mounted where the scene's closures are not reachable, so the
  scene binds its store here while a socket is live and unbinds when it goes
  (the same family as worldRoom.ts). `useWorldRound()` re-renders on every
  change of the store and hands back the store itself with the two things a
  menu needs beside it: how to send a command and how to name a player.
*/

export interface RoundBridge {
  state: RoundState
  send: (m: RoundClientMessage) => void
  nameOf: (id: number) => string
  /** everyone in the room right now (roster size + us), for "N here" */
  headcount: () => number
  /** we are allowed to use the solo-test flag (admin) */
  isAdmin: () => boolean
}

let bridge: RoundBridge | null = null
let rev = 0
let unsub: (() => void) | null = null
const listeners = new Set<() => void>()
const emit = () => {
  rev++
  for (const l of listeners) l()
}

/** the scene: a live socket's store. Returns the undo */
export function bindRound(b: RoundBridge): () => void {
  unsub?.()
  bridge = b
  unsub = b.state.subscribe(emit)
  emit()
  return () => {
    if (bridge !== b) return
    unsub?.()
    unsub = null
    bridge = null
    emit()
  }
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useWorldRound(): { bridge: RoundBridge | null; rev: number } {
  const r = useSyncExternalStore(subscribe, () => rev, () => 0)
  return { bridge, rev: r }
}

/** send a command if a store is bound (the console's `round` verbs use this) */
export function roundCmd(m: RoundClientMessage): boolean {
  if (!bridge) return false
  bridge.send(m)
  return true
}

export function roundBridge(): RoundBridge | null {
  return bridge
}
