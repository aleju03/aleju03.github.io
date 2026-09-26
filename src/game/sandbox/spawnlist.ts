import { KINDS, type PropKind } from './kinds'

/*
  What the spawn menu lists, and under which heading.

  The kind table (`kinds.ts`) is the physics' view of a prop: a shape, a mass,
  a mesh. The menu needs three more things a kind does not have to carry: a
  category to file it under, a name in each language, and a picture. This is
  the seam between the two, deliberately small because the catalogue proper
  (the art, the categories, the thumbnails) is being built in parallel by the
  props piece and must be able to arrive without touching the menu.

  So there are two ways in, and the menu reads whichever it finds:

  - **A kind can simply say so.** `category`, `labelEs` and `thumb` are read
    off the kind object if present, so a catalogue that registers kinds with
    those fields is listed with no further call.
  - **Or a catalogue registers entries** with `registerSpawnlist`, which wins
    over anything derived: its own order, its own headings, its own pictures.

  Everything else falls back to the placeholder table below, which files the
  six kinds the physics core shipped with. A kind nobody filed goes under
  "odds and ends", so a new kind is never missing from the menu, only
  misfiled. With no `thumb`, the menu draws one itself off the kind's own
  mesh (`components/os/propSketch.ts`).

  React-free and three-free apart from the kind table's types.
*/

export interface SpawnEntry {
  /** the kind id `spawn` takes */
  id: string
  /** a category id; see CATEGORIES for the ones with names */
  category: string
  label: string
  labelEs?: string
  /** a picture: a URL, or a function that draws one (called lazily, once) */
  thumb?: string | (() => string)
  /** the small print under the name ("35 kg, floats"); derived if absent */
  note?: string
  noteEs?: string
}

export interface SpawnCategory {
  id: string
  label: string
  labelEs: string
}

/** the headings, in the order the menu lists them. A category that ends up
    empty is not shown; one that is not here is shown after these, under its
    own id */
export const CATEGORIES: SpawnCategory[] = [
  { id: 'containers', label: 'crates and barrels', labelEs: 'cajas y barriles' },
  { id: 'building', label: 'building stuff', labelEs: 'para construir' },
  { id: 'street', label: 'street', labelEs: 'calle' },
  { id: 'furniture', label: 'furniture', labelEs: 'muebles' },
  { id: 'toys', label: 'toys', labelEs: 'juguetes' },
  { id: 'food', label: 'food', labelEs: 'comida' },
  { id: 'junk', label: 'junk', labelEs: 'chatarra' },
  { id: 'misc', label: 'odds and ends', labelEs: 'de todo un poco' },
]

/** the placeholder kinds' filing, until the catalogue says otherwise */
const FALLBACK: Record<string, { category: string; labelEs: string }> = {
  crate: { category: 'containers', labelEs: 'caja de madera' },
  barrel: { category: 'containers', labelEs: 'barril de aceite' },
  plank: { category: 'building', labelEs: 'tablón' },
  block: { category: 'building', labelEs: 'bloque de concreto' },
  cone: { category: 'street', labelEs: 'cono' },
  ball: { category: 'toys', labelEs: 'bola' },
}

/** the optional fields a kind may carry for the menu; read, never required */
interface KindMenuFields {
  category?: string
  labelEs?: string
  thumb?: string | (() => string)
  /** true keeps a kind out of the menu (debris, gibs, internal shapes) */
  hidden?: boolean
}

let registered: SpawnEntry[] | null = null
const listeners = new Set<() => void>()

/** replace the derived list with a catalogue's own. Call again to update */
export const registerSpawnlist = (entries: SpawnEntry[]) => {
  registered = entries.slice()
  for (const fn of listeners) fn()
}

/** hear about a new registration (the menu re-reads) */
export const onSpawnlist = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** a kind's small print, from its own numbers: what a catalogue would say */
export const kindNote = (k: PropKind, lang: 'en' | 'es'): string => {
  const kg = k.mass >= 100 ? Math.round(k.mass / 10) * 10 : Math.round(k.mass * 10) / 10
  const floats = k.density < 1
  if (lang === 'es') return `${kg} kg, ${floats ? 'flota' : 'se hunde'}`
  return `${kg} kg, ${floats ? 'floats' : 'sinks'}`
}

/** everything spawnable, in menu order */
export const spawnlist = (): SpawnEntry[] => {
  if (registered) return registered.filter((e) => KINDS[e.id])
  const out: SpawnEntry[] = []
  for (const k of Object.values(KINDS)) {
    const extra = k as PropKind & KindMenuFields
    if (extra.hidden || !k.mesh) continue
    const fb = FALLBACK[k.id]
    out.push({
      id: k.id,
      category: extra.category ?? fb?.category ?? 'misc',
      label: k.label,
      labelEs: extra.labelEs ?? fb?.labelEs,
      thumb: extra.thumb,
    })
  }
  return out
}

/** the categories that have something in them, in menu order */
export const spawnCategories = (entries: SpawnEntry[]): SpawnCategory[] => {
  const used = new Set(entries.map((e) => e.category))
  const known = CATEGORIES.filter((c) => used.has(c.id))
  const extra = [...used]
    .filter((id) => !CATEGORIES.some((c) => c.id === id))
    .map((id) => ({ id, label: id, labelEs: id }))
  return [...known, ...extra]
}
