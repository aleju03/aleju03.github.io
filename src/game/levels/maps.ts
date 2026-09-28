/*
  The maps: the places you pick to play on, as opposed to the levels you
  walk between.

  A level is anywhere the level system can cut to (levels/types.ts). A map
  is a set of them you choose from the pause sheet or the console's `map`,
  and arrive in at one level of it. 'home' is the house and the planet, and
  the backrooms and the Moon are part of it because you reach them from it
  on foot; every other map is a place of its own that nobody pays for until
  they pick it: its module is imported, built and warmed under the cut's
  card the first time (CrtScene's `goMap`), and it stays for the session.

  This table is the one place that says which level belongs to which map,
  so nothing downstream asks for a level by id to find out where it is.
  Pure data and no imports, so the room tier and the console can hold it.
*/

export type MapId = 'home' | 'nuketown' | 'cubeland'

export interface MapDef {
  id: MapId
  /** the level you arrive in when you pick it */
  level: string
  /** every level that is part of it */
  levels: readonly string[]
}

export const MAPS: readonly MapDef[] = [
  { id: 'home', level: 'overworld', levels: ['overworld', 'backrooms', 'moon'] },
  { id: 'nuketown', level: 'nuketown', levels: ['nuketown'] },
  { id: 'cubeland', level: 'cubeland', levels: ['cubeland'] },
]

/** the map a level belongs to; anything unlisted is home's */
export const mapOf = (levelId: string): MapId =>
  MAPS.find((m) => m.levels.includes(levelId))?.id ?? 'home'

export const findMap = (id: string): MapDef | undefined =>
  MAPS.find((m) => m.id === id.toLowerCase())
