/*
  What a player looks like, as four colours, and the only file that decides
  what "customising your character" is allowed to mean.

  The body in `playerBody.ts` is one skinned surface, a bean, whose every
  vertex names the paint it wears (`bodyShape.ts`), and four of those paints
  are the player's: the body itself, the headgear, the detail (the outfit's
  pattern and the headgear's trim), and the eyes. Plus the choices that are
  not colours: which headgear out of nine (a knotted headband, a cap, a
  bucket hat, a party hat, a hard hat, a printed bandana, nothing, a hood, or
  a space helmet with its life-support pack), which of five builds (bean,
  chubby, slim, tall, stubby), which outfit (none, spots, stripes,
  overalls, a spacesuit, a beaver onesie in one of three furs), the outfits
  being printed on the one surface by the material rather than modelled (the
  beaver's tail, ears, snout and teeth are the exception), and whether a
  pair of headphones is worn over whatever is on the head. The expression is hashed
  from the whole look (see playerBody's persona), which is why it needs no
  field of its own.

  **The hat, the outfit and the shape ride in the colours.** The wire carries 24 hex characters and
  the server checks them with one regex, so a fifth field would break every
  server and every old client at once. Instead the hat is the low three bits
  of the headgear colour's blue byte: every headgear swatch has those bits
  clear, `packLook` writes the hat into them and `unpackLook` takes it back
  out and clears them again, so the round trip is exact. An old client
  reading a new pack sees a headgear colour off by at most 7/255 in blue,
  which nobody can see; a new client reading an old pack gets a hat derived
  deterministically from whatever the colour's low bits were, so everyone
  still agrees on what everyone is wearing. The outfit is the low two bits of
  the detail colour (`trim`) and the build the low three bits of the eye
  colour (`glow`), by exactly the same trick. The bean kept this format
  exactly: the indices mean new things (a mask became a cap, a cape spots),
  but every pack an old client sends still decodes to some bean.

  **The astronaut overflowed that, and rides in two more spare bits.** Eight
  hats fill three bits and four outfits two, so the ninth hat (the helmet)
  and the fifth outfit (the spacesuit) each carry one extension bit in the
  low two bits of the headgear colour's *green* byte: bit 0 adds eight to
  the hat, bit 1 adds four to the outfit. Every headgear swatch has those
  two bits clear, so every pack sent before the astronaut decodes exactly as
  it did, and a client that predates it reads an astronaut as a headband and
  a plain bean, a green channel off by at most 3/255.

  **The beaver and the headphones fit in bits nobody was using.** The
  outfit already had three bits (two in `trim`, one extension in `accent`)
  and only five values, so the beaver costume takes the three left over:
  wire values 5, 6 and 7 are all the beaver, in each of its three furs
  (`fur`, FUR_SWATCHES). An old client clamps those to the spacesuit. The
  headphones are not a hat, they are worn *over* one, so they need their
  own field: the low two bits of the headgear colour's *red* byte, clear in
  every headgear swatch, carry 0 for none and 1 to 3 for which colour their
  metal and rings take (PHONES: red, the detail colour, the hat colour). So
  the whole map of spare bits is now:

    accent  red   bits 0-1  headphones (0 none, 1..3 their accent)
            green bit 0     hat + 8 (the helmet)
            green bit 1     outfit + 4 (spacesuit, and the beaver's 5..7)
            blue  bits 0-2  hat & 7
    trim    blue  bits 0-1  outfit & 3
    glow    blue  bits 0-2  build

  Every pack sent before the beaver has a clear red pair and an outfit of
  at most four, so it decodes exactly as it did, with `fur` and `phones` 0.

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
  /** the bean: body, legs, arms and mittens. The biggest block of colour
      on the body, and the one a player is recognised by */
  shell: string
  /** the detail: the outfit's spots, stripes or overalls, and the
      headgear's trim (a cap's button, a hat's band, a party hat's rings, a
      hard hat's ridge, a bandana's print) */
  trim: string
  /** the headgear itself */
  accent: string
  /** the eyes (the face panel turns dark when they are light) */
  glow: string
  /** which headgear, an index into HATS */
  hat: number
  /** which outfit, an index into COSTUMES */
  costume: number
  /** which body shape, an index into BUILDS */
  build: number
  /** the beaver's fur, an index into FUR_SWATCHES; only worn with the beaver */
  fur: number
  /** the headphones, worn over any headgear: 0 none, else an index into
      PHONES for the colour of their metal and rings */
  phones: number
}

/** the headgear, in wire order (see the header: the index rides in the low
    bits of `accent`, the helmet in an extension bit). No beanies */
export const HATS = ['band', 'cap', 'bucket', 'party', 'hardhat', 'bandana', 'none', 'hood', 'helmet'] as const
export type HatKind = (typeof HATS)[number]
/** the outfits, in wire order: they ride in the low two bits of `trim`, the
    spacesuit in an extension bit of `accent` */
export const COSTUMES = ['none', 'spots', 'stripes', 'overalls', 'spacesuit', 'beaver'] as const
/** the astronaut, both halves: what "suit up" puts on */
export const HELMET_HAT = 8
export const SPACESUIT = 4
/** the beaver onesie: the fur is printed, the tail, ears, snout and teeth
    are modelled (see bodyShape's beaverPieces) */
export const BEAVER = 5
/** the beaver's three furs: a chestnut, a dark wet brown and a sandy one.
    Warm and fairly saturated for the same reason the body swatches are: a
    dull brown goes to grey through the posterize */
export const FUR_SWATCHES = ['#8a5230', '#5a3620', '#b07838'] as const
/** what the headphones' metal forks, sliders and cup rings are painted in,
    by `phones` value: none, the gaming-headset red, the detail colour, the
    hat colour */
export const PHONES = ['none', 'red', 'detail', 'hat'] as const
/** the red of the default headset */
export const PHONES_RED = '#c8262a'
/** the body shapes, in wire order: they ride in the low three bits of `glow` */
export const BUILDS = ['bean', 'chubby', 'slim', 'tall', 'stubby'] as const

/** a saturated blue bean in a red knotted headband, the one the owner
    kept. (It was once green in a red wrestler's mask, which read as the
    Android logo in a luchador cap) */
export const DEFAULT_LOOK: PlayerLook = {
  shell: '#2f6fcf',
  trim: '#f2eee0',
  accent: '#c84028',
  glow: '#1c1a20',
  hat: 0,
  costume: 0,
  build: 0,
  fur: 0,
  phones: 0,
}

/** beans are painted saturated on purpose: the game is rendered at a low
    resolution through a posterize, and a colour block has to survive being
    eight pixels wide and quantized. Pastels there turn to grey, and a pastel
    bean reads as a plush toy rather than a character. Every entry was checked
    against the look at noon and at dusk (`npm run shoot -- body:lineup`) */
export const SHELL_SWATCHES = [
  '#3f9a38', '#d2452f', '#e0a21a', '#2f6fcf',
  '#8a4fc8', '#d9508f', '#1f9a8a', '#e8e2d2',
] as const

/** every outfit colour has the low two bits of its blue byte clear: that is
    where the outfit index goes */
export const TRIM_SWATCHES = [
  '#f2eee0', '#1c1c20', '#e0a218', '#d2452c',
  '#2f6fcc', '#3f9a38', '#8a4fc8', '#e06a18',
] as const

/** every headgear colour has the low three bits of its blue byte clear (that
    is where the hat index goes), the low two of its green byte (the
    extension bits) and the low two of its red byte (the headphones: see the
    header) */
export const ACCENT_SWATCHES = [
  '#c84028', '#e8b818', '#2860c8', '#f0e8e0',
  '#1c1c20', '#38a038', '#e86810', '#9048c8',
] as const

/** every pupil colour has the low three bits of its blue byte clear: that
    is where the body shape goes */
export const GLOW_SWATCHES = [
  '#1c1a20', '#2b3a50', '#4a2e20', '#1f4a38',
  '#5a1e28', '#3a2a58', '#f4f1e0', '#6a6f70',
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
const withLowBlue = (hex: string, bits: number, width = 3) => {
  const mask = (1 << width) - 1
  const b = (parseInt(hex.slice(4, 6), 16) & ~mask) | (bits & mask)
  return hex.slice(0, 4) + b.toString(16).padStart(2, '0')
}
const lowBlue = (hex: string, width: number) => parseInt(hex.slice(-2), 16) & ((1 << width) - 1)
/** the same two tricks on the green byte, for the extension bits */
const withLowGreen = (hex: string, bits: number) => {
  const g = (parseInt(hex.slice(2, 4), 16) & ~3) | (bits & 3)
  return hex.slice(0, 2) + g.toString(16).padStart(2, '0') + hex.slice(4)
}
const lowGreen = (hex: string) => parseInt(hex.slice(2, 4), 16) & 3
/** and on the red byte, for the headphones */
const withLowRed = (hex: string, bits: number) => {
  const r = (parseInt(hex.slice(0, 2), 16) & ~3) | (bits & 3)
  return r.toString(16).padStart(2, '0') + hex.slice(2)
}
const lowRed = (hex: string) => parseInt(hex.slice(0, 2), 16) & 3
/** a headgear colour with every bit that carries something cleared */
const bareAccent = (hex: string) => withLowRed(withLowGreen(withLowBlue(hex, 0), 0), 0)
const clampIdx = (v: unknown, n: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(n - 1, Math.floor(v))) : null

/** 24 hex characters, no separators and no leading hash: four colours, with
    the hat folded into the headgear colour's blue low bits */
export function packLook(look: PlayerLook): string {
  const hat = clampHat(look.hat) ?? DEFAULT_LOOK.hat
  const costume = clampIdx(look.costume, COSTUMES.length) ?? 0
  const build = clampIdx(look.build, BUILDS.length) ?? 0
  const phones = clampIdx(look.phones, PHONES.length) ?? 0
  // the outfit's wire value: the beaver is 5, 6 or 7 by its fur
  const wear = costume === BEAVER ? BEAVER + (clampIdx(look.fur, FUR_SWATCHES.length) ?? 0) : costume
  return FIELDS.map((f) => {
    const hex = hex6(look[f]) ?? hex6(DEFAULT_LOOK[f])!
    if (f === 'accent') {
      return withLowRed(withLowGreen(withLowBlue(hex, hat & 7), (hat >> 3) | ((wear >> 2) << 1)), phones)
    }
    if (f === 'trim') return withLowBlue(hex, wear & 3, 2)
    if (f === 'glow') return withLowBlue(hex, build)
    return hex
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
  const ext = lowGreen(out.accent.slice(1))
  out.hat = Math.min(bits + 8 * (ext & 1), HATS.length - 1)
  out.phones = lowRed(out.accent.slice(1))
  out.accent = `#${bareAccent(out.accent.slice(1))}`
  // wire values 5..7 are the beaver in its three furs
  const wear = lowBlue(out.trim, 2) + 4 * (ext >> 1)
  out.costume = Math.min(wear, BEAVER)
  out.fur = Math.max(0, wear - BEAVER)
  out.trim = `#${withLowBlue(out.trim.slice(1), 0, 2)}`
  out.build = lowBlue(out.glow, 3) % BUILDS.length
  out.glow = `#${withLowBlue(out.glow.slice(1), 0)}`
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
  out.accent = `#${bareAccent(out.accent.slice(1))}`
  out.trim = `#${withLowBlue(out.trim.slice(1), 0, 2)}`
  out.glow = `#${withLowBlue(out.glow.slice(1), 0)}`
  out.hat = clampHat(src.hat) ?? DEFAULT_LOOK.hat
  out.costume = clampIdx(src.costume, COSTUMES.length) ?? 0
  out.build = clampIdx(src.build, BUILDS.length) ?? 0
  out.fur = clampIdx(src.fur, FUR_SWATCHES.length) ?? 0
  out.phones = clampIdx(src.phones, PHONES.length) ?? 0
  return out
}

export function looksEqual(a: PlayerLook, b: PlayerLook): boolean {
  return (
    FIELDS.every((f) => a[f].toLowerCase() === b[f].toLowerCase()) &&
    a.hat === b.hat && a.costume === b.costume && a.build === b.build &&
    a.fur === b.fur && a.phones === b.phones
  )
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
    costume: Math.floor(rnd() * COSTUMES.length) % COSTUMES.length,
    build: Math.floor(rnd() * BUILDS.length) % BUILDS.length,
    fur: Math.floor(rnd() * FUR_SWATCHES.length) % FUR_SWATCHES.length,
    // headphones on about one surprise in three
    phones: rnd() < 0.34 ? 1 + (Math.floor(rnd() * 3) % 3) : 0,
  }
}
