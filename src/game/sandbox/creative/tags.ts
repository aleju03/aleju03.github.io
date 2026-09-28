/*
  The creative props' shared record: what a prop can carry that the physics
  does not know about, as plain numbers, so it can ride the prop protocol
  (net/propProtocol.ts, `tag`) and survive a handoff, an undo and a late join.

  A tag is `[paint, flags, ...chars]`:
    paint  0 for none, else 1..12, an index into PALETTE (the tool gun's paint
           mode; a balloon's colour is the same field)
    flags  bit 0: a lamp switched off (a fresh lamp has no tag and is on)
    chars  a sign's text, one code point per number, at most SIGN_MAX

  A prop with nothing to say has no tag at all (`null`), which is what every
  ordinary prop and every freshly spawned lamp carries, so the wire and the
  server pay nothing until somebody paints, switches or writes.

  Import-free on purpose: the tool gun's words (toolgunText.ts, read by the
  eager scene chunk), the server's mirror of the rules (server/src/props.js
  cannot import this, so its list of allowed characters is written out there
  as well; keep the two in step) and the console all read the palette and the
  text filter from here.
*/

export interface PaintColor {
  hex: string
  name: { en: string; es: string }
}

/** twelve paints, spread round the hue wheel plus white and black, each
    bright enough to survive multiplying the atlas's darker browns */
export const PALETTE: readonly PaintColor[] = [
  { hex: '#e2483c', name: { en: 'red', es: 'rojo' } },
  { hex: '#f08a2c', name: { en: 'orange', es: 'naranja' } },
  { hex: '#f2cf3a', name: { en: 'yellow', es: 'amarillo' } },
  { hex: '#8fcf3f', name: { en: 'lime', es: 'lima' } },
  { hex: '#2fa860', name: { en: 'green', es: 'verde' } },
  { hex: '#2fb8b0', name: { en: 'teal', es: 'turquesa' } },
  { hex: '#3b8fe0', name: { en: 'blue', es: 'azul' } },
  { hex: '#5a4fd0', name: { en: 'indigo', es: 'añil' } },
  { hex: '#b458d6', name: { en: 'purple', es: 'morado' } },
  { hex: '#ee6fa8', name: { en: 'pink', es: 'rosa' } },
  { hex: '#f1ede4', name: { en: 'white', es: 'blanco' } },
  { hex: '#3a3a42', name: { en: 'black', es: 'negro' } },
]

export const SIGN_MAX = 40
export const SIGN_LINE = 20

/** the flag bits */
export const LAMP_OFF = 1

/** characters a sign may carry beyond printable ASCII: the Spanish set */
const EXTRA = 'ñÑ¡¿áéíóúÁÉÍÓÚüÜ'
const allowed = (code: number) =>
  (code >= 32 && code <= 126) || (code > 126 && EXTRA.includes(String.fromCharCode(code)))

/** the text as a sign will carry it: control characters and anything outside
    the font dropped, runs of blanks squeezed, trimmed, cut to SIGN_MAX */
export const cleanSign = (raw: string): string => {
  let out = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0)!
    if (c === 9 || c === 10 || c === 13) out += ' '
    else if (allowed(c)) out += ch
  }
  return out.replace(/ {2,}/g, ' ').trim().slice(0, SIGN_MAX).trim()
}

export interface Tag {
  paint: number
  off: boolean
  text: string
}

export const decodeTag = (raw: readonly number[] | null | undefined): Tag => {
  if (!raw || raw.length < 2) return { paint: 0, off: false, text: '' }
  const paint = Number.isInteger(raw[0]) && raw[0] >= 0 && raw[0] <= PALETTE.length ? raw[0] : 0
  let text = ''
  for (let i = 2; i < raw.length && i < 2 + SIGN_MAX; i++) {
    const c = raw[i]
    if (Number.isInteger(c) && allowed(c)) text += String.fromCharCode(c)
  }
  return { paint, off: ((raw[1] | 0) & LAMP_OFF) !== 0, text: cleanSign(text) }
}

/** null when the tag says nothing a fresh prop does not */
export const encodeTag = (t: Tag): number[] | null => {
  const text = cleanSign(t.text)
  if (!t.paint && !t.off && !text) return null
  return [t.paint, t.off ? LAMP_OFF : 0, ...[...text].map((c) => c.charCodeAt(0))]
}

export const tagKey = (raw: readonly number[] | null | undefined): string => (raw ? raw.join(',') : '')

/** the sign's text broken onto at most two lines of SIGN_LINE, at a space
    where it can be */
export const signLines = (text: string): [string, string] => {
  if (text.length <= SIGN_LINE) return [text, '']
  let cut = text.lastIndexOf(' ', SIGN_LINE)
  if (cut < SIGN_LINE / 2) cut = SIGN_LINE
  return [text.slice(0, cut).trim(), text.slice(cut).trim().slice(0, SIGN_LINE)]
}
