/*
 * Shared blocks, without sockets or React: what somebody dug out of Cubeland
 * or built on it is there for everyone standing in it. The browser supplies
 * the transport (worldNet's `blocks`), the scene attaches the level's block
 * handle once the map has been loaded (levels/cubeland/cubeland.ts's
 * BlockNet), and the level's own frame drives the outbox.
 *
 * The world is a pure function of block coordinates on every client, so the
 * edits are the whole of it: every local change goes out as it happens (a
 * frame's worth batched), the server keeps the last word per block and
 * relays, and a socket arriving in the level (or coming back to it) gets the
 * whole map and applies it quietly. Whatever this client changed before that
 * (offline, or while the level was forgotten) and the server does not have
 * is reported straight back, so a map heals itself the way the ruins do.
 *
 * Nothing loads the map module for this: edits for a level whose blocks are
 * not attached yet are held and applied on attach.
 *
 * Claims: the level declines edits inside somebody else's claim before it
 * makes them (remoteSocial.ts's mirror), and the server refuses whatever gets
 * through anyway (a stale mirror, a blast that reached over a border). A
 * `world-block-refused` names the cells and what the server holds there, and
 * `revert` puts them back, so no client is left looking at a block that only
 * it can see.
 */
import type { BlockNet, WireEdit } from '../levels/cubeland/cubeland'
import type { BlockClientMessage } from './blockProtocol'
import type { WorldServerMessage } from './protocol'

export interface BlockNetwork {
  attach: (net: BlockNet, level?: string) => void
  receive: (m: WorldServerMessage) => void
  setLevel: (name: string) => void
  offline: () => void
}

const LEVEL = 'cubeland'
/** edits per message; the server takes up to 2048 */
const PER_MESSAGE = 1024

/* (the server answers every arrival in a level with its map, empty or not,
   so the catch-up below always runs after the server's word and never
   writes over somebody else's newer block with an old one of ours) */
const toWire = (flat: readonly number[]): WireEdit[] => {
  const out: WireEdit[] = []
  for (let i = 0; i + 3 < flat.length; i += 4) out.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]])
  return out
}

export function createBlockNetwork(
  send: (m: BlockClientMessage) => void,
  /** an edit of ours was refused inside somebody's claim: whose */
  refused: (owner: string) => void = () => {},
): BlockNetwork {
  let blocks: BlockNet | null = null
  let active = ''
  let joined = false
  /** what arrived before the map existed here */
  const held: Array<{ edits: WireEdit[]; blast: boolean }> = []

  const post = (edits: readonly WireEdit[], blast: boolean) => {
    for (let i = 0; i < edits.length; i += PER_MESSAGE) {
      const flat: number[] = []
      for (const e of edits.slice(i, i + PER_MESSAGE)) flat.push(e[0], e[1], e[2], e[3])
      send({ type: 'world-blocks', level: LEVEL, edits: flat, blast })
    }
  }

  return {
    attach: (net) => {
      blocks = net
      net.onLocal((edits, blast) => {
        if (joined && active === LEVEL) post(edits, blast)
      })
      for (const h of held.splice(0)) net.apply(h.edits, h.blast)
    },
    receive: (m) => {
      if (m.type === 'world-welcome') joined = true
      if (m.type === 'world-block-refused') {
        if (m.level !== LEVEL) return
        blocks?.revert(toWire(m.edits))
        refused(m.owner)
        return
      }
      if (m.type !== 'world-blocks' && m.type !== 'world-blockmap') return
      if (m.level !== LEVEL) return
      const edits = toWire(m.edits)
      if (m.type === 'world-blocks') {
        if (blocks) blocks.apply(edits, m.blast)
        else held.push({ edits, blast: false })
        return
      }
      // the whole map: take it, then hand back what we have that it lacks
      if (!blocks) {
        held.push({ edits, blast: false })
        return
      }
      const theirs = new Map<string, number>()
      for (const e of edits) theirs.set(`${e[0]},${e[1]},${e[2]}`, e[3])
      const ours = blocks.all().filter((e) => theirs.get(`${e[0]},${e[1]},${e[2]}`) === undefined)
      blocks.apply(edits, false)
      if (ours.length) post(ours, false)
    },
    setLevel: (name) => {
      active = name
    },
    offline: () => {
      joined = false
    },
  }
}
