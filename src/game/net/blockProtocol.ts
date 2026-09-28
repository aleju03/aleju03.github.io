/*
 * Shared blocks (Cubeland), as plain numbers. The world is gen.ts's pure
 * function of block coordinates on every client, so all that travels is
 * what somebody changed: a flat list of (x, y, z, id) quadruples in block
 * coordinates. The server keeps the last word per block for each level and
 * never interprets an id beyond its range; a late arrival gets the whole
 * list in one `world-blockmap`.
 *
 * `blast` marks the edits a blast made, so a peer throws some of what it
 * took out as loose blocks of its own (the explosion itself travels as a
 * prop blast, propProtocol.ts, and is not carved twice).
 */
export type BlockClientMessage = {
  type: 'world-blocks'
  level: string
  /** x, y, z, id, repeated */
  edits: number[]
  blast: boolean
}
export type BlockServerMessage =
  | { type: 'world-blocks'; level: string; from: number; edits: number[]; blast: boolean }
  | { type: 'world-blockmap'; level: string; edits: number[] }
  /** edits refused inside somebody's claim: x, y, z and the value the server
      holds there (-1: the generated terrain), so the sender puts it back */
  | { type: 'world-block-refused'; level: string; edits: number[]; owner: string }
