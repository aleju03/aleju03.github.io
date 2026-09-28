/*
 * Shared world damage, as plain records. Nothing here is geometry: the planet
 * is a pure function of coordinates on every client, so a building is its
 * position-stable id (world/chunk.ts's `cx,cz:Bhx,hz`) and a lost piece is
 * its fracture key (cell and facing, the same on every tier); a felled tree,
 * cactus or lamp post is its Smashable id. The server keeps a union of both
 * per level and never parses an id beyond its shape.
 *
 * A `DamageWire` is one blow a peer is watching replayed (sandbox/
 * destruction.ts's DamageRecord minus its local sequence and clock). Blasts
 * never travel this way: the explosion itself does (propProtocol.ts).
 */
export interface DamageWire {
  b: string
  how: 'impact' | 'vehicle' | 'command' | 'collapse'
  /** where it landed (a collapse: the side it leans from) */
  at: number[]
  power: number
  radius: number
  /** what `hurt` threw along, and how hard */
  dir: number[]
  k: number
  ram: boolean
  seed: number
}
export type DamageClientMessage = { level: string } & (
  | ({ type: 'world-damage' } & DamageWire)
  | { type: 'world-ruin'; b: string; keys: number[] }
  | { type: 'world-fell'; id: string; dir: number[]; speed: number }
)
export type DamageServerMessage = { level: string } & (
  | ({ type: 'world-damage'; from: number } & DamageWire)
  | { type: 'world-ruin'; b: string; keys: number[] }
  | { type: 'world-fell'; id: string; dir: number[]; speed: number }
  | { type: 'world-ruins'; ruins: Array<[string, number[]]>; felled: string[] }
)
