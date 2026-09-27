import type { PropId, Sandbox } from './sandbox'

/*
  Who made what, and how to take it back: the undo stack and the cleanup.

  Garry's Mod keeps one undo list per player and Z pops the newest entry,
  whatever it was: a spawn of ten crates is one entry and goes in one press,
  a weld is one entry, a balloon is one entry. This is that. An entry is a
  label, the props it brought into the world, and optionally a function that
  reverses anything else it did (a constraint, a frozen state), and it
  belongs to one player. Undo only ever pops your own; cleanup takes every
  prop you own, or everyone's when the caller says so.

  Anything that creates props records them here: the console's `spawn`, the
  spawn menu, the physgun's duplicator if it gets one, destruction's debris if
  it wants debris to be undoable. The record is `historyOf(sb).record(...)`,
  keyed by the sandbox so a headless scenario with its own sandbox gets its
  own history and nothing is a module-level singleton.

  It stays honest about props that leave by other means. A crate that breaks
  into gibs, a prop that falls out of the world and is rescued away, or one
  cleaned up by somebody else is dropped from every entry through the
  sandbox's `onRemove`, and an entry with nothing left to undo is dropped
  too, so Z never spends a press on something already gone. `adopt` is how
  the gibs stay yours: every `onBreak` hands the pieces to the entry of the
  thing that broke (put back on the stack if the break had emptied it), and
  one Z then clears the whole mess.

  Owners are numbers: the network's player id, or `LOCAL` (0) offline. The
  scene sets `me` when the server says who we are.
*/

/** the owner offline, and the owner of anything recorded before a welcome */
export const LOCAL = 0

/** what an entry is called: one string, or the same thing in both languages
    (the shape `commands.ts` calls a Msg), since the undo line and the spawn
    menu's order slip print it in whichever the visitor reads */
export type Label = string | { en: string; es: string }
export const labelIn = (l: Label, lang: 'en' | 'es') => (typeof l === 'string' ? l : l[lang])

export interface HistoryEntry {
  /** increasing, never reused */
  readonly seq: number
  readonly owner: number
  /** what the undo line says: "wooden crate", "10 wooden crates", "weld" */
  label: Label
  /** the kind, when the entry is a spawn; the spawn menu draws its thumbnail */
  kind?: string
  /** props this entry brought into the world, still in it */
  readonly props: Set<PropId>
  /** reverses whatever else the entry did; runs before its props go */
  undo?: () => void
  /** performance.now() when recorded */
  readonly at: number
}

export interface RecordOpts {
  owner?: number
  label: Label
  kind?: string
  props?: Iterable<PropId> | PropId
  undo?: () => void
}

export interface History {
  /** whose presses count as ours: set from the network's welcome */
  me: number
  /** push an entry; returns it so the caller can add props to it later */
  record: (o: RecordOpts) => HistoryEntry
  /** pop and reverse the newest entry `owner` has (default: me) */
  undo: (owner?: number) => HistoryEntry | null
  /** remove every prop `owner` made (default: me), or everyone's with
      'all'; returns how many props went */
  cleanup: (owner?: number | 'all') => number
  /** give `children` the same entry (and owner) as `parent`: gibs, debris */
  adopt: (parent: PropId, children: Iterable<PropId>) => void
  /** add props to an entry recorded earlier (a demolition's rubble arrives
      over seconds, after the entry that undoes it was made) */
  attach: (entry: HistoryEntry, ids: Iterable<PropId>) => void
  /** forget an entry without reversing it: what it would undo is already
      gone (a weld whose prop was removed), so Z must not spend a press on it */
  discard: (entry: HistoryEntry) => void
  /** the owner of a prop, or null for one nobody recorded (a scenario's,
      a world prop) */
  ownerOf: (id: PropId) => number | null
  /** newest first, optionally one owner's */
  entries: (owner?: number) => HistoryEntry[]
  /** every prop an owner has in the world */
  propsOf: (owner?: number) => PropId[]
  /** fires after any change; returns the unsubscribe */
  onChange: (fn: () => void) => () => void
  dispose: () => void
}

const histories = new WeakMap<Sandbox, History>()

/** the history of one sandbox, created the first time anybody asks */
export const historyOf = (sb: Sandbox): History => {
  let h = histories.get(sb)
  if (!h) {
    h = createHistory(sb)
    histories.set(sb, h)
  }
  return h
}

/** how many entries each owner keeps. Garry's Mod keeps them all; a browser
    tab left open for an evening should not, and a press of Z reaching back
    two hundred spawns is not a feature anybody uses */
const KEEP = 200

export const createHistory = (sb: Sandbox): History => {
  let seq = 1
  const stack: HistoryEntry[] = []
  /** prop -> the entry holding it */
  const byProp = new Map<PropId, HistoryEntry>()
  const listeners = new Set<() => void>()
  /** set while this module removes props itself, so onRemove does not
      re-enter and edit the entry being undone */
  let removing = false

  const changed = () => {
    for (const fn of listeners) fn()
  }
  const drop = (e: HistoryEntry) => {
    const i = stack.indexOf(e)
    if (i >= 0) stack.splice(i, 1)
    for (const id of e.props) byProp.delete(id)
  }

  /** where a prop removed by other means lived, for a moment: a crate that
      breaks is removed before its gibs are announced, and the gibs must
      still find the entry to join (see `adopt`) */
  const gone = new Map<PropId, HistoryEntry>()
  const off = sb.onRemove((p) => {
    if (removing) return
    const e = byProp.get(p.id)
    if (!e) return
    byProp.delete(p.id)
    e.props.delete(p.id)
    gone.set(p.id, e)
    if (gone.size > 64) gone.delete(gone.keys().next().value!)
    // an entry that was only props, all gone, has nothing left to undo
    if (e.props.size === 0 && !e.undo) drop(e)
    changed()
  })

  const removeAll = (ids: Iterable<PropId>) => {
    let n = 0
    removing = true
    try {
      for (const id of ids) if (sb.remove(id)) n++
    } finally {
      removing = false
    }
    return n
  }

  // the props piece's breakables: gibs join the entry of what broke, so one
  // Z takes back the crate and the splinters it left
  const offBreak = sb.onBreak((b) => h.adopt(b.id, b.gibs))

  const h: History = {
    me: LOCAL,
    record: (o) => {
      const e: HistoryEntry = {
        seq: seq++,
        owner: o.owner ?? h.me,
        label: o.label,
        kind: o.kind,
        props: new Set(),
        undo: o.undo,
        at: performance.now(),
      }
      const ids = o.props === undefined ? [] : typeof o.props === 'number' ? [o.props] : o.props
      for (const id of ids) {
        e.props.add(id)
        byProp.set(id, e)
      }
      stack.push(e)
      // trim the owner's oldest past KEEP; the props stay in the world, they
      // simply stop being undoable, which is what running out of undo means
      let mine = 0
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].owner !== e.owner) continue
        if (++mine > KEEP) {
          for (const id of stack[i].props) byProp.delete(id)
          stack.splice(i, 1)
        }
      }
      changed()
      return e
    },
    undo: (owner = h.me) => {
      for (let i = stack.length - 1; i >= 0; i--) {
        const e = stack[i]
        if (e.owner !== owner) continue
        drop(e)
        e.undo?.()
        removeAll([...e.props])
        changed()
        return e
      }
      return null
    },
    cleanup: (owner = h.me) => {
      const all = owner === 'all'
      const ids: PropId[] = []
      if (all) {
        // everyone's includes props nobody recorded: a scenario's, a world
        // prop's. "Clean up the map" means the map
        sb.forEach((p) => ids.push(p.id))
      } else {
        for (const e of stack) if (e.owner === owner) ids.push(...e.props)
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        const e = stack[i]
        if (!all && e.owner !== owner) continue
        drop(e)
        e.undo?.()
      }
      const n = removeAll(ids)
      changed()
      return n
    },
    adopt: (parent, children) => {
      const e = byProp.get(parent) ?? gone.get(parent)
      if (!e) return
      gone.delete(parent)
      // an entry emptied by the break is put back where it was in the stack
      if (!stack.includes(e)) {
        let i = stack.length
        while (i > 0 && stack[i - 1].seq > e.seq) i--
        stack.splice(i, 0, e)
      }
      for (const id of children) {
        e.props.add(id)
        byProp.set(id, e)
      }
      changed()
    },
    attach: (e, ids) => {
      if (!stack.includes(e)) return
      for (const id of ids) {
        e.props.add(id)
        byProp.set(id, e)
      }
      changed()
    },
    discard: (e) => {
      if (!stack.includes(e)) return
      drop(e)
      changed()
    },
    ownerOf: (id) => byProp.get(id)?.owner ?? null,
    entries: (owner) => {
      const out: HistoryEntry[] = []
      for (let i = stack.length - 1; i >= 0; i--) {
        if (owner === undefined || stack[i].owner === owner) out.push(stack[i])
      }
      return out
    },
    propsOf: (owner = h.me) => {
      const out: PropId[] = []
      for (const e of stack) if (e.owner === owner) out.push(...e.props)
      return out
    },
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose: () => {
      off()
      offBreak()
      stack.length = 0
      byProp.clear()
      listeners.clear()
    },
  }
  return h
}
