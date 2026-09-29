/*
 * Who may touch whose things, on the wire. The server (protection.js,
 * claims.js) is the authority on every one of these; the browser only asks,
 * and mirrors the answers so it can refuse an action before it makes it
 * (remoteSocial.ts). Notices travel as a code plus parameters, never as
 * text: the browser words them in both languages.
 *
 * Everything is scoped by the level the socket is in, like the rest of the
 * world's protocol, and carries that level so a message in flight across a
 * seam is dropped instead of misapplied.
 */
export type SocialOp = 'friend' | 'unfriend' | 'protect' | 'votekick' | 'vote' | 'kick' | 'mute' | 'unmute' | 'claim' | 'unclaim'

export type SocialClientMessage = { type: 'world-social'; level: string } & (
  | { op: 'friend' | 'unfriend' | 'votekick' | 'kick' | 'unmute'; name: string }
  | { op: 'mute'; name: string; minutes?: number }
  | { op: 'protect'; on: boolean }
  | { op: 'vote'; yes: boolean }
  | { op: 'claim' | 'unclaim'; cx: number; cz: number }
)

/** a request without its envelope (the type and the level are the mirror's to add) */
export type SocialAsk = SocialClientMessage extends infer M ? (M extends unknown ? Omit<M, 'type' | 'level'> : never) : never

/** the states every notice code can be, and what its parameters mean */
export type SocialNoteCode =
  | 'friend-added' | 'friend-granted' | 'friend-removed' | 'friend-none' | 'friend-self' | 'friend-already' | 'friend-full'
  | 'protect-on' | 'protect-off' | 'not-host' | 'not-admin' | 'no-such-player' | 'slow'
  | 'vote-start' | 'vote-pass' | 'vote-fail' | 'vote-busy' | 'vote-cooldown' | 'vote-self' | 'vote-admin' | 'vote-few' | 'vote-none' | 'vote-target' | 'vote-counted'
  | 'kicked' | 'muted' | 'you-muted' | 'unmuted' | 'you-unmuted'
  | 'claimed' | 'unclaimed' | 'claim-none' | 'claim-yours' | 'claim-taken' | 'claim-full'

export type SocialServerMessage = { level: string } & (
  | {
      type: 'world-social'
      /** is the scope's protection switch on */
      protect: boolean
      /** the world id of the scope's first player (who may flip the switch) */
      host: number
      /** the names this player has granted */
      friends: string[]
      /** the world ids here whose owners have granted this player */
      grantedBy: number[]
    }
  | {
      type: 'world-social-note'
      code: SocialNoteCode
      name?: string
      by?: string
      n?: number
      max?: number
      yes?: number
      no?: number
      need?: number
      secs?: number
      cx?: number
      cz?: number
    }
  /** every claim in the scope: chunk x, chunk z, owner name, may-I-edit, is-it-mine */
  | { type: 'world-claims'; claims: Array<[number, number, string, 0 | 1, 0 | 1]> }
  /** removed from the scope for `until` (ms since the epoch) */
  | { type: 'world-kicked'; until: number; by: number }
)
