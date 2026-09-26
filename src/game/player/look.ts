/*
  What a player looks like, as four colours, and the only file that decides
  what "customising your character" is allowed to mean.

  The body in `playerBody.ts` is one skinned mesh whose every vertex names
  the paint it wears (`bodyShape.ts`), and only four of those paints are
  anybody's business: the work suit (body, sleeves, legs), the trim (gloves,
  boots, belt, straps, the backpack's lid and the lamp's housing), the accent
  (the beanie, its pom-pom and the backpack), and the glow of the headlamp.
  The face is not on the list: skin, ink eyes, blush and the glint in the eye
  are fixed, because a face that can be painted green reads as a bug rather
  than as a choice, and because the face is what makes every one of these
  the same friendly person in a different outfit.

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
  /** the work suit: the body, the sleeves and the legs. The biggest block of
      colour on the body, and the one a player is recognised by */
  shell: string
  /** gloves, boots, belt, backpack straps and lid, the lamp's housing */
  trim: string
  /** the beanie, its pom-pom and the backpack */
  accent: string
  /** the headlamp, and the glint it puts in a dark street */
  glow: string
}

/** a safety-orange work suit, a teal beanie, charcoal boots and gloves and a
    warm lamp: the Lethal-ish employee the character was drawn as */
export const DEFAULT_LOOK: PlayerLook = {
  shell: '#e2893f',
  trim: '#3a3f47',
  accent: '#3f8f86',
  glow: '#ffd98a',
}

/** suits are painted saturated and mid-light on purpose: the game is moving
    to a low-resolution, posterized picture, and a colour block has to
    survive being eight pixels wide and quantized. Pastels there turn to
    grey and darks turn to the outline. Every entry was checked against the
    world's ACES grade at noon and at dusk (`npm run shoot -- body:lineup`) */
export const SHELL_SWATCHES = [
  '#e2893f', '#e8c24a', '#cf5a4a', '#4f86c6',
  '#6aa35a', '#8a6cc0', '#e9e2d0', '#9aa3ad',
] as const

export const TRIM_SWATCHES = [
  '#3a3f47', '#2a2522', '#2b3a55', '#6b4a33',
  '#4c5536', '#5a2e3a', '#5d6670', '#d9d6cf',
] as const

export const ACCENT_SWATCHES = [
  '#3f8f86', '#c9493f', '#e6b43c', '#3d6fb5',
  '#e07aa0', '#5f9b4c', '#7d5bb0', '#eeeae0',
] as const

export const GLOW_SWATCHES = [
  '#ffd98a', '#f4f1dc', '#7fe8e8', '#9af0a0',
  '#ff9ec0', '#ffae5c', '#9cc8ff', '#ff7a66',
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
