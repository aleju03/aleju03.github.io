/*
  What a player looks like, as four colours, and the only file that decides
  what "customising your character" is allowed to mean.

  The body in `playerBody.ts` is one skinned mesh whose every vertex names
  the paint it wears (`bodyShape.ts`), and four of those paints are the
  player's: the jelly itself (body, legs, arms, fists), the headgear, the
  headgear's detail (its stripes, laces, band or trim), and the pupils. Plus
  one choice that is not a colour: which headgear, out of eight (a sweatband,
  a wrestler's mask, a bucket hat, a party hat, a hard hat, a bandana,
  nothing, or a hood). The body's outline also varies, between three builds
  hashed from the whole look (see playerBody's persona), which is why it
  needs no field of its own. That is the whole of the costume on purpose: a jelly brawler is
  its colours and its hat.

  **The hat rides in the colours.** The wire carries 24 hex characters and
  the server checks them with one regex, so a fifth field would break every
  server and every old client at once. Instead the hat is the low three bits
  of the headgear colour's blue byte: every headgear swatch has those bits
  clear, `packLook` writes the hat into them and `unpackLook` takes it back
  out and clears them again, so the round trip is exact. An old client
  reading a new pack sees a headgear colour off by at most 7/255 in blue,
  which nobody can see; a new client reading an old pack gets a hat derived
  deterministically from whatever the colour's low bits were, so everyone
  still agrees on what everyone is wearing.

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
  /** the jelly: body, legs, arms and fists. The biggest block of colour on
      the body, and the one a player is recognised by */
  shell: string
  /** the headgear's detail: a mask's stripe and eye rims, a hat's band, a
      party hat's rings, a hard hat's ridge */
  trim: string
  /** the headgear itself */
  accent: string
  /** the pupils */
  glow: string
  /** which headgear, an index into HATS */
  hat: number
}

/** the headgear, in wire order (see the header: the index rides in the low
    bits of `accent`). No beanies */
export const HATS = ['band', 'mask', 'bucket', 'party', 'hardhat', 'bandana', 'none', 'hood'] as const
export type HatKind = (typeof HATS)[number]

/** a saturated blue brawler in a red sweatband. (It was green in a red
    wrestler's mask, which read as the Android logo in a luchador cap) */
export const DEFAULT_LOOK: PlayerLook = {
  shell: '#2f6fcf',
  trim: '#f2eee0',
  accent: '#c84028',
  glow: '#1c1a22',
  hat: 0,
}

/** jellies are painted saturated on purpose: the game is rendered at a low
    resolution through a posterize, and a colour block has to survive being
    eight pixels wide and quantized. Pastels there turn to grey, and a pastel
    jelly reads as a plush toy rather than a brawler. Every entry was checked
    against the look at noon and at dusk (`npm run shoot -- body:lineup`) */
export const SHELL_SWATCHES = [
  '#3f9a38', '#d2452f', '#e0a21a', '#2f6fcf',
  '#8a4fc8', '#d9508f', '#1f9a8a', '#e8e2d2',
] as const

export const TRIM_SWATCHES = [
  '#f2eee0', '#1c1c22', '#e0a21a', '#d2452f',
  '#2f6fcf', '#3f9a38', '#8a4fc8', '#e06a1a',
] as const

/** every headgear colour has the low three bits of its blue byte clear: that
    is where the hat index goes (see the header) */
export const ACCENT_SWATCHES = [
  '#c84028', '#e8b818', '#2860c8', '#f0e8e0',
  '#1c1c20', '#38a038', '#e86810', '#9048c8',
] as const

export const GLOW_SWATCHES = [
  '#1c1a22', '#2b3a55', '#4a2e22', '#1f4a3a',
  '#5a1e2e', '#3a2a5a', '#f4f1e6', '#6a6f76',
] as const

/** the colour field order the pack format freezes; changing it changes the wire */
const FIELDS = ['shell', 'trim', 'accent', 'glow'] as const

const HEX6 = /^#?([0-9a-f]{6})$/i

/** the packed form, exactly as it travels and exactly as the server checks it */
export const LOOK_RE = /^[0-9a-f]{24}$/

const hex6 = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const m = HEX6.exec(value.trim())
  return m ? m[1].toLowerCase() : null
}
const clampHat = (h: unknown) =>
  typeof h === 'number' && Number.isFinite(h) ? Math.max(0, Math.min(HATS.length - 1, Math.floor(h))) : null
/** a colour with the low three bits of its blue byte replaced */
const withLowBlue = (hex: string, bits: number) => {
  const b = (parseInt(hex.slice(4, 6), 16) & ~7) | (bits & 7)
  return hex.slice(0, 4) + b.toString(16).padStart(2, '0')
}

/** 24 hex characters, no separators and no leading hash: four colours, with
    the hat folded into the headgear colour's blue low bits */
export function packLook(look: PlayerLook): string {
  const hat = clampHat(look.hat) ?? DEFAULT_LOOK.hat
  return FIELDS.map((f) => {
    const hex = hex6(look[f]) ?? hex6(DEFAULT_LOOK[f])!
    return f === 'accent' ? withLowBlue(hex, hat) : hex
  }).join('')
}

/** the inverse, total: anything that is not a well-formed pack (a truncated
    field, somebody poking the socket) is the default look rather than an
    error, because a missing look must never be a reason for a body not to be
    drawn. An old client's pack decodes to some hat or other, deterministically */
export function unpackLook(packed: unknown): PlayerLook {
  if (typeof packed !== 'string' || !LOOK_RE.test(packed)) return { ...DEFAULT_LOOK }
  const out = {} as PlayerLook
  FIELDS.forEach((f, i) => {
    out[f] = `#${packed.slice(i * 6, i * 6 + 6)}`
  })
  const bits = parseInt(out.accent.slice(5, 7), 16) & 7
  out.hat = Math.min(bits, HATS.length - 1)
  out.accent = `#${withLowBlue(out.accent.slice(1), 0)}`
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
  out.accent = `#${withLowBlue(out.accent.slice(1), 0)}`
  out.hat = clampHat(src.hat) ?? DEFAULT_LOOK.hat
  return out
}

export function looksEqual(a: PlayerLook, b: PlayerLook): boolean {
  return FIELDS.every((f) => a[f].toLowerCase() === b[f].toLowerCase()) && a.hat === b.hat
}

/** one from each row, and a hat. The "surprise me" button, and the reason the
    palettes are curated: every combination this can produce is somebody you
    would be happy to meet in the street */
export function randomLook(rnd: () => number = Math.random): PlayerLook {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length) % list.length]
  return {
    shell: pick(SHELL_SWATCHES),
    trim: pick(TRIM_SWATCHES),
    accent: pick(ACCENT_SWATCHES),
    glow: pick(GLOW_SWATCHES),
    hat: Math.floor(rnd() * HATS.length) % HATS.length,
  }
}
