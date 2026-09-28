/*
 * The weapons' wire records (sandbox/tools/weapons.ts), kept apart from
 * presence like the prop and effect records so the headless sim can speak
 * them. Nothing here is state the server keeps beyond who is holding what:
 * a shot is a ray (origin, unit direction, and for the pistol how far it
 * went), and a hit is where the shooter decided it landed and what it did
 * there, so every client draws the same tracer, the same rocket and the
 * same bolt stuck in the same place. `w` indexes WIRE_WEAPONS; numbers are
 * rounded to centimetres by the sender and re-rounded by the server.
 */
export const WIRE_WEAPONS = ['pistol', 'crossbow', 'rocket'] as const
export type WireWeapon = (typeof WIRE_WEAPONS)[number]

export type WeaponClientMessage =
  | { type: 'world-shot'; level: string; w: number; seq: number; o: number[]; d: number[]; len?: number }
  | {
    type: 'world-shot-hit'; level: string; w: number; seq: number; at: number[]
    /** the bolt's heading where it stuck */
    d?: number[]
    /** the shared prop it went into, and the bolt's frame in that prop's
        space (position and quaternion, seven numbers) */
    prop?: number
    fr?: number[]
    /** an impulse for whoever simulates that prop */
    imp?: number[]
    /** a player it struck, and the velocity their own client takes */
    player?: number
    v?: number[]
  }
  /** what is in my hands: an index into WIRE_WEAPONS, or -1 for anything else */
  | { type: 'world-wield'; w: number }

export type WeaponServerMessage =
  | { type: 'world-shot'; level: string; id: number; w: number; seq: number; o: number[]; d: number[]; len?: number }
  | {
    type: 'world-shot-hit'; level: string; id: number; w: number; seq: number; at: number[]
    d?: number[]; prop?: number; fr?: number[]; imp?: number[]; player?: number; v?: number[]
  }
  | { type: 'world-wield'; level: string; id: number; w: number }
  /** everyone in a level holding a weapon, for a late arrival: [id, w] pairs */
  | { type: 'world-wields'; level: string; wields: number[][] }
