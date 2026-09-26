import { CATALOGUE, CATEGORIES } from './catalogue'
import { KINDS, type PropKind } from './kinds'
import { renderThumbnails } from './thumbnails'

/*
  The spawn menu's reading of the prop catalogue.

  `catalogue.ts` is the one source of truth for what can be spawned: every
  prop's id, category and name in both languages, in its own order, and
  `thumbnails.ts` draws each one's icon off its own model. This module only
  turns that into the shape the menu (`components/os/SpawnMenu.tsx`) reads,
  plus the one thing a catalogue page prints that the catalogue does not
  carry: the small print under each plate, which here is the physics' own
  numbers (how heavy it is, whether it floats, whether it breaks or blows).

  A kind that is registered but not catalogued (a gib, a debris piece, a
  scenario's one-off) is never listed. Imported lazily with the sandbox, so
  none of this sits in the scene's eager chunk.
*/

export interface SpawnEntry {
  /** the kind id `spawn` takes */
  id: string
  category: string
  label: string
  labelEs: string
}

export interface SpawnCategory {
  id: string
  label: string
  labelEs: string
}

/** everything spawnable, in catalogue order */
export const spawnlist = (): SpawnEntry[] =>
  CATALOGUE.filter((e) => KINDS[e.id]).map((e) => ({
    id: e.id, category: e.category, label: e.name.en.toLowerCase(), labelEs: e.name.es.toLowerCase(),
  }))

/** the categories that have something in them, in catalogue order */
export const spawnCategories = (entries: SpawnEntry[]): SpawnCategory[] => {
  const used = new Set(entries.map((e) => e.category))
  return CATEGORIES.filter((c) => used.has(c.id)).map((c) => ({
    id: c.id, label: c.name.en.toLowerCase(), labelEs: c.name.es.toLowerCase(),
  }))
}

/** a plate's small print, from the kind's own numbers */
export const kindNote = (k: PropKind, lang: 'en' | 'es'): string => {
  const kg = k.mass >= 100 ? Math.round(k.mass / 10) * 10 : Math.round(k.mass * 10) / 10
  const bits = [`${kg} kg`]
  if (k.explodes) bits.push(lang === 'es' ? 'explota' : 'explodes')
  else if (k.breaks) bits.push(lang === 'es' ? 'se rompe' : 'breaks')
  else bits.push(k.density < 1 ? (lang === 'es' ? 'flota' : 'floats') : (lang === 'es' ? 'se hunde' : 'sinks'))
  return bits.join(', ')
}

let thumbs: Promise<Map<string, string>> | null = null
/** every icon as an image URL, drawn once per session (thumbnails.ts owns
    the look; this only keeps the result) */
export const spawnThumbs = (): Promise<Map<string, string>> => {
  thumbs ??= renderThumbnails(undefined, 96).then(
    (list) => new Map(list.map((t) => [t.id, t.canvas.toDataURL('image/png')])),
  )
  return thumbs
}
