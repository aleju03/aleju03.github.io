import {
  FRAME_LEN, JOINT_TYPES, MAX_JOINTS, MAX_PROPS, isKnownKind, legalKeys,
  type Blueprint, type BpJoint, type BpProp,
} from './blueprint'

/*
  The share code: a blueprint as one paste-able string.

      BP1.<base64url of zlib-deflated JSON>

  The version prefix is checked before anything is inflated, so a future
  format is refused by name rather than misread. The JSON is columnar rows
  (`{v, n, p: [[kind, scale, mass, frozen, x, y, z, qx, qy, qz, qw, keys,
  flip], ...], j: [[type, a, b, f0..f16], ...]}`), which deflates to a few
  bytes a prop; 'deflate' is zlib framing, so the server can inflate it with
  node:zlib to check a published build without knowing anything about
  kinds.

  Importing is the one place untrusted text becomes state, so it is strict
  and bounded twice over: the code and the inflated JSON have length caps
  (the inflate is read chunk by chunk and abandoned at the cap, so a
  decompression bomb costs a megabyte, not the tab), and every field is
  checked, not merely typed. Unknown kinds are rejected, not skipped (a
  build with a missing wheel is a different build); numbers are clamped into
  the ranges the server itself clamps to; quaternions must be nonzero and are
  normalised; joints must name two different props and carry seventeen finite
  numbers. Anything wrong throws a `BlueprintError` whose `code` the UI words
  in both languages.

  Uses only CompressionStream and btoa/atob, which browsers and Node both
  ship, so the round trip is testable headless.
*/

export const CODE_PREFIX = 'BP1.'
/** longest code accepted, characters (a 300-prop build deflates to ~8 KB) */
export const MAX_CODE_CHARS = 96 * 1024
/** most JSON we inflate, bytes */
const MAX_JSON_BYTES = 1024 * 1024

export type BlueprintErrorCode =
  | 'empty' | 'prefix' | 'toolong' | 'base64' | 'inflate' | 'toobig' | 'json' | 'shape'
  | 'version' | 'kind' | 'props' | 'joints' | 'number'
export class BlueprintError extends Error {
  readonly code: BlueprintErrorCode
  constructor(code: BlueprintErrorCode, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

/* ------------------------------------------------------------ base64url -- */

const toB64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64 = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new BlueprintError('base64')
  const pad = text.replace(/-/g, '+').replace(/_/g, '/')
  let bin: string
  try {
    bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  } catch {
    throw new BlueprintError('base64')
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------- deflate -- */

const pump = async (stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      void reader.cancel().catch(() => {})
      throw new BlueprintError('toobig')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
const through = async (bytes: Uint8Array, t: CompressionStream | DecompressionStream, cap: number) => {
  const w = t.writable.getWriter()
  // the write is not awaited before reading: both ends are back-pressured
  const wrote = w.write(bytes as BufferSource).then(() => w.close())
  wrote.catch(() => {})
  try {
    return await pump(t.readable as ReadableStream<Uint8Array>, cap)
  } finally {
    await wrote.catch(() => {})
  }
}

/* ------------------------------------------------------------ encoding -- */

export const toJson = (bp: Blueprint) => ({
  v: 1,
  n: bp.name,
  p: bp.props.map((p) => [
    p.kind, p.scale, p.mass, p.frozen ? 1 : 0, ...p.pos, ...p.quat, p.keys, p.flip ? 1 : 0,
  ]),
  j: bp.joints.map((j) => [JOINT_TYPES.indexOf(j.type), j.a, j.b, ...j.frames]),
})

export async function encodeBlueprint(bp: Blueprint): Promise<string> {
  const text = new TextEncoder().encode(JSON.stringify(toJson(bp)))
  const packed = await through(text, new CompressionStream('deflate'), MAX_JSON_BYTES)
  return CODE_PREFIX + toB64(packed)
}

/* ------------------------------------------------------------ decoding -- */

const num = (v: unknown, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BlueprintError('number')
  return Math.min(hi, Math.max(lo, v))
}
const int = (v: unknown, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new BlueprintError('number')
  return v
}
const round4 = (n: number) => Math.round(n * 10000) / 10000

/** a name fit to show and store: no control characters, one line, 40 long */
export const cleanName = (raw: unknown): string =>
  typeof raw === 'string'
    // eslint-disable-next-line no-control-regex
    ? raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    : ''

/** the structural half of import: a parsed JSON value to a Blueprint, or a
    `BlueprintError`. `known` decides which kinds are allowed */
export function fromJson(raw: unknown, known: (kind: string) => boolean = isKnownKind): Blueprint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BlueprintError('shape')
  const o = raw as Record<string, unknown>
  if (o.v !== 1) throw new BlueprintError('version')
  if (!Array.isArray(o.p) || !Array.isArray(o.j)) throw new BlueprintError('shape')
  if (o.p.length < 1 || o.p.length > MAX_PROPS) throw new BlueprintError('props')
  if (o.j.length > MAX_JOINTS) throw new BlueprintError('joints')
  const props: BpProp[] = o.p.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 13) throw new BlueprintError('shape')
    const kind = row[0]
    if (typeof kind !== 'string' || kind.length > 32 || !known(kind)) throw new BlueprintError('kind', String(kind).slice(0, 32))
    const m = num(row[2], 0, 20000)
    const q = [num(row[7], -1, 1), num(row[8], -1, 1), num(row[9], -1, 1), num(row[10], -1, 1)]
    const len = Math.hypot(...q)
    if (len < 0.5) throw new BlueprintError('number')
    return {
      kind,
      scale: num(row[1], 0.2, 4),
      mass: m > 0 ? Math.max(0.05, m) : 0,
      frozen: row[3] === 1,
      pos: [num(row[4], -400, 400), num(row[5], -400, 400), num(row[6], -400, 400)],
      quat: [round4(q[0] / len), round4(q[1] / len), round4(q[2] / len), round4(q[3] / len)],
      keys: row[11] === -1 ? -1 : legalKeys(row[11]),
      flip: row[12] === 1,
    }
  })
  const joints: BpJoint[] = o.j.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 3 + FRAME_LEN) throw new BlueprintError('shape')
    const t = int(row[0], 0, JOINT_TYPES.length - 1)
    const a = int(row[1], 0, props.length - 1)
    const b = int(row[2], 0, props.length - 1)
    if (a === b) throw new BlueprintError('joints')
    const f = row.slice(3).map((v, i) => {
      // the last number is a rope's length (a no-collide carries 1e6 there)
      if (i === 16) return num(v, 0, 1e6)
      return num(v, -1000, 1000)
    })
    // frameB is a rotation: renormalise it, or reject one that is not
    const qb = f.slice(6, 10)
    const len = Math.hypot(...qb)
    if (len < 0.5) throw new BlueprintError('number')
    for (let i = 0; i < 4; i++) f[6 + i] = round4(qb[i] / len)
    for (const [s] of [[10], [13]]) {
      const l = Math.hypot(f[s], f[s + 1], f[s + 2])
      if (l < 0.5) throw new BlueprintError('number')
      for (let i = 0; i < 3; i++) f[s + i] = round4(f[s + i] / l)
    }
    return { type: JOINT_TYPES[t], a, b, frames: f }
  })
  return { name: cleanName(o.n), props, joints }
}

export async function decodeBlueprint(code: string, known?: (kind: string) => boolean): Promise<Blueprint> {
  const text = typeof code === 'string' ? code.trim().replace(/\s+/g, '') : ''
  if (!text) throw new BlueprintError('empty')
  if (text.length > MAX_CODE_CHARS) throw new BlueprintError('toolong')
  if (!text.startsWith(CODE_PREFIX)) throw new BlueprintError('prefix')
  const bytes = fromB64(text.slice(CODE_PREFIX.length))
  let inflated: Uint8Array
  try {
    inflated = await through(bytes, new DecompressionStream('deflate'), MAX_JSON_BYTES)
  } catch (e) {
    if (e instanceof BlueprintError) throw e
    throw new BlueprintError('inflate')
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(inflated))
  } catch {
    throw new BlueprintError('json')
  }
  return fromJson(json, known)
}
