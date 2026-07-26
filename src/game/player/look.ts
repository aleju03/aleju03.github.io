/*
  What a player looks like, as four colours — and the only file that decides
  what "customising your character" is allowed to mean.

  The body in `playerBody.ts` is ~30 meshes over six materials, and only four
  of them are anybody's business: the cream shell (torso, skull, hands, toe
  caps), the dark plastic everything plugs into, the rust accent on the
  shoulder and knee balls, and the light behind the eyes and the antenna tip.
  The visor stays near-black because it is a screen, and a tintable screen
  reads as a bug rather than as a choice.

  Two constraints shaped the rest. It has to travel: a look rides in the
  roster beside the name, so it is packed into 24 hex characters with no
  separators — the server validates it with one regex and never learns what
  any of it means, which is the same deal the wire has with every other piece
  of world state. And it has to be picked from a palette rather than typed:
  free colour wells produce fluorescent green robots standing in a stylised
  world that spent a lot of effort on its own tone map, whereas twelve
  swatches drawn from that same tone map cannot look wrong. The palettes are
  the customisation.

  Colours are applied as material uniforms, never as material *configuration*,
  so a change is a `Color.set()` and never a shader relink — the rule the root
  CLAUDE.md's boot-cost section exists for. Changing your look mid-walk costs
  nothing.
*/

export interface PlayerLook {
  /** the big cream panels: torso, skull, hands, toe caps */
  shell: string
  /** the dark plastic: pelvis, limb segments, ears, antenna stalk */
  trim: string
  /** the ball joints at the shoulders and knees */
  accent: string
  /** the emissive behind the eyes and on the antenna tip */
  glow: string
}

/** the robot as it was drawn: keycap cream, dark plastic, one rust accent */
export const DEFAULT_LOOK: PlayerLook = {
  shell: '#d9d4c9',
  trim: '#2f3236',
  accent: '#9d5542',
  glow: '#a9d7ff',
}

/** desk-peripheral neutrals plus a few painted plastics. Every entry was
    picked against the world's ACES tone map at midday and at dusk — nothing
    here blows out under the sun or vanishes into the night grass */
export const SHELL_SWATCHES = [
  '#d9d4c9', '#eae6dd', '#b9b2a4', '#8e9aa6',
  '#c9a97e', '#a8bfa6', '#c79a9a', '#7d8794',
] as const

export const TRIM_SWATCHES = [
  '#2f3236', '#1b1d20', '#3f3a34', '#4a4f57',
  '#2b3a44', '#3a2f3c', '#48412c', '#6a6f76',
] as const

export const ACCENT_SWATCHES = [
  '#9d5542', '#c0705c', '#7b8f5a', '#4f7f96',
  '#b8913f', '#8a6ca8', '#3f8a76', '#b0b4ba',
] as const

export const GLOW_SWATCHES = [
  '#a9d7ff', '#ffb869', '#8fe6b4', '#ff8fa8',
  '#d3a9ff', '#f2f0d6', '#6cf0e6', '#ff6b5a',
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

/** the inverse, total: anything that is not a well-formed pack — an old
    client, a truncated field, somebody poking the socket — is the default
    robot rather than an error, because a missing look must never be a reason
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
    are curated: every combination this can produce is a robot you would be
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
