/*
  What a player looks like, as four colours, and the only file that decides
  what "customising your character" is allowed to mean.

  The body in `playerBody.ts` is one skinned mesh whose every vertex names
  the paint it wears (`bodyShape.ts`), and four of those paints are the
  player's: the jelly itself (the pear, the stub legs, the arms, the fists), a
  paler belly patch, the headband, and the pupils of the two big eyes. That is
  the whole of the costume on purpose: a jelly brawler is its colours, and two
  of them in the same body colour are still told apart by belly and band.

  The four field names are older than this body (they were a robot's shell,
  trim, accent joints and eye glow) and they stay, because they are the wire
  format: renaming them would change what every client sends.

  Two constraints shaped the rest. It has to travel: a look rides in the
  roster beside the name, so it is packed into 24 hex characters with no
  separators: the server validates it with one regex and never learns what
  any of it means, which is the same deal the wire has with every other piece
  of world state. And it has to be picked from a palette rather than typed:
  free colour wells produce fluorescent green people standing in a stylised
  world that spent a lot of effort on its own tone map, whereas twelve
  swatches drawn from that same tone map cannot look wrong. The palettes are
  the customisation.

  Colours are applied as material uniforms, never as material *configuration*,
  so a change is a `Color.set()` and never a shader relink, the rule the root
  CLAUDE.md's boot-cost section exists for. Changing your look mid-walk costs
  nothing.
*/

export interface PlayerLook {
  /** the jelly: the bean, the arms and the fists. The biggest block of
      colour on the body, and the one a player is recognised by */
  shell: string
  /** the belly: a paler patch of a second gummy on the front of the pear */
  trim: string
  /** the headband and its tails */
  accent: string
  /** the eyes. Dark by default; a pale pair reads as a different mood */
  glow: string
}

/** a gummy blue with dark shorts and a white band: a brawler, not a mascot.
    Not red: a warm jelly under the grade reads as bare skin */
export const DEFAULT_LOOK: PlayerLook = {
  shell: '#4f86c6',
  trim: '#cfe3f0',
  accent: '#eeeae0',
  glow: '#1c1a22',
}

/** jellies are painted saturated and mid-light on purpose: the game is
    rendered at a low resolution through a posterize, and a colour block has
    to survive being eight pixels wide and quantized. Pastels there turn to
    grey and darks turn to the outline. Every entry was checked against the
    look at noon and at dusk (`npm run shoot -- body:lineup`) */
export const SHELL_SWATCHES = [
  '#d9503f', '#e8b83a', '#4f86c6', '#5fa35a',
  '#9a6cc8', '#e27aa6', '#3fa79a', '#e8e2d2',
] as const

/** belly patches are pale: a lighter gummy under a darker one is what reads
    as a belly rather than a hole cut in the body */
export const TRIM_SWATCHES = [
  '#cfe3f0', '#f3ead8', '#f6d3de', '#fbe9a8',
  '#d6f0cf', '#e4d8f3', '#f7d2b3', '#ffffff',
] as const

export const ACCENT_SWATCHES = [
  '#eeeae0', '#c9493f', '#e6b43c', '#3d6fb5',
  '#1c1c22', '#5f9b4c', '#e07aa0', '#7d5bb0',
] as const

export const GLOW_SWATCHES = [
  '#1c1a22', '#2b3a55', '#4a2e22', '#1f4a3a',
  '#5a1e2e', '#3a2a5a', '#f4f1e6', '#6a6f76',
] as const

/** the field order the pack format freezes; changing it changes the wire */
const FIELDS = ['shell', 'trim', 'accent', 'glow'] as const

const HEX6 = /^#?([0-9a-f]{6})$/i

/** the packed form, exactly as it travels and exactly as the server checks it */
export const LOOK_RE = /^[0-9a-f]{24}$/

const hex6 = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const m = HEX6.exec(value.trim())
  return m ? m[1].toLowerCase() : null
}

/** 24 hex characters, no separators and no leading hash: four colours is a
    small enough payload that spending bytes on punctuation would be silly */
export function packLook(look: PlayerLook): string {
  return FIELDS.map((f) => hex6(look[f]) ?? hex6(DEFAULT_LOOK[f])!).join('')
}

/** the inverse, total: anything that is not a well-formed pack (an old
    client, a truncated field, somebody poking the socket) is the default
    look rather than an error, because a missing look must never be a reason
    for a body not to be drawn */
export function unpackLook(packed: unknown): PlayerLook {
  if (typeof packed !== 'string' || !LOOK_RE.test(packed)) return { ...DEFAULT_LOOK }
  const out = {} as PlayerLook
  FIELDS.forEach((f, i) => {
    out[f] = `#${packed.slice(i * 6, i * 6 + 6)}`
  })
  return out
}

/** clamp an arbitrary object (localStorage, mostly) back onto the shape */
export function sanitizeLook(raw: unknown): PlayerLook {
  const src = (raw ?? {}) as Partial<Record<keyof PlayerLook, unknown>>
  const out = {} as PlayerLook
  for (const f of FIELDS) {
    const hex = hex6(src[f])
    out[f] = hex ? `#${hex}` : DEFAULT_LOOK[f]
  }
  return out
}

export function looksEqual(a: PlayerLook, b: PlayerLook): boolean {
  return FIELDS.every((f) => a[f].toLowerCase() === b[f].toLowerCase())
}

/** one from each row. The "surprise me" button, and the reason the palettes
    are curated: every combination this can produce is somebody you would be
    happy to meet in the street */
export function randomLook(rnd: () => number = Math.random): PlayerLook {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length) % list.length]
  return {
    shell: pick(SHELL_SWATCHES),
    trim: pick(TRIM_SWATCHES),
    accent: pick(ACCENT_SWATCHES),
    glow: pick(GLOW_SWATCHES),
  }
}
