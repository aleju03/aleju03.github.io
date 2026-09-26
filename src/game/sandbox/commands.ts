import * as THREE from 'three'
import type { History } from './history'
import type { PropKind } from './kinds'
import type { WorldRules } from './rules'
import type { PropId, Sandbox } from './sandbox'

/*
  The console's commands: a registry, a parser, a completer, and the commands
  a sandbox deserves.

  A command is a name, its arguments (each typed, so the parser can refuse
  "spawn crate lots" before the handler sees it and the completer knows that
  the second word of `spawn` is a kind), help in both languages, and a
  handler. `registerCommand` adds one from anywhere, and a second registration
  under the same name replaces the first: that is how the props piece's real
  explosion takes over from the plain impulse `explode` below, and how a tool
  can add `give` targets, without either module editing this one.

  The handlers never touch the scene. Everything they do goes through a
  `SandboxHost` the scene hands to `createConsole`: the sandbox and its
  history, the walker (teleport, noclip, the flop), the sky (time, fog), the
  roster, the shared rules. A host method that is missing is a capability the
  scene does not have yet, and the command says so rather than failing, which
  is also what makes the whole thing runnable headless: `measure -- console`
  drives it with a host made of a bare sandbox and a few stubs.

  Output is data, not text on a screen. A handler prints lines (an echo, a
  result, an item with a count in the right-hand column like a receipt, an
  error), each in both languages, and whoever is listening draws them: the
  receipt printer in `components/os/SandboxConsole.tsx`, or the promise
  `run()` returns to a script (`window.__sandbox.run('spawn crate 10')`).

  Who a command touches decides where it runs (see `rules.ts`): most of them
  are the typist's own business and act at once; gravity, timescale and a
  cleanup of everyone's props are the world's, and go through the rules seam
  so the network can make them everybody's.
*/

/* ------------------------------------------------------------- messages -- */

export type Lang = 'en' | 'es'
/** a line in both languages, or one string that reads the same in both
    (a number, a kind id, a coordinate) */
export type Msg = string | { en: string; es: string }
export const msg = (en: string, es: string): Msg => ({ en, es })
export const say = (m: Msg, lang: Lang) => (typeof m === 'string' ? m : m[lang])

/** what a printed line is, which is how the receipt inks it */
export type Tone =
  /** the command as typed */
  | 'echo'
  /** a plain result */
  | 'out'
  /** something happened: a spawn, an undo */
  | 'ok'
  /** an item line: text on the left, `right` in the quantity column */
  | 'item'
  /** refused, or broken */
  | 'err'
  /** help: usage and explanation */
  | 'help'

export interface ConsoleLine {
  tone: Tone
  text: Msg
  /** the right-hand column of an item line */
  right?: Msg
}

/* ------------------------------------------------------------ the host -- */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface PlayerInfo {
  id: number
  name: string
  x: number
  y: number
  z: number
}

/**
 * Everything a command can reach. The scene implements it (CrtScene, over its
 * walker, sky and network); a headless run implements whatever it needs. Every
 * method past the first three is optional, and a command whose capability is
 * absent says so instead of failing.
 */
export interface SandboxHost {
  /** null until the world (and Rapier) have arrived */
  sandbox: () => Sandbox | null
  history: () => History | null
  rules: WorldRules
  /** connected to the shared world */
  online?: () => boolean
  /** the head and where it is looking, unit length */
  aim?: () => { origin: Vec3; dir: Vec3 }
  /** feet position and compass heading */
  here?: () => { x: number; y: number; z: number; yaw: number }
  /** put the feet at x/z (and y, else on whatever is there), facing yaw */
  teleport?: (x: number, z: number, y?: number, yaw?: number) => void
  /** the authored spawn */
  home?: () => { x: number; z: number; yaw?: number }
  noclip?: (on?: boolean) => boolean
  god?: (on?: boolean) => boolean
  thirdPerson?: (on?: boolean) => boolean
  /** throw the body with this velocity (units/s); the flop */
  fling?: (vx: number, vy: number, vz: number) => boolean
  /** sit on whatever seat is in front of you */
  sit?: () => boolean
  /** pin the clock (0..1, 0.5 noon), or release it with null */
  time?: (tod: number | null) => void
  /** multiply the fog's thickness (1 normal) */
  fog?: (k: number) => void
  /** everyone else in the world */
  players?: () => PlayerInfo[]
  /** say something on the shared chat; false offline */
  chat?: (text: string) => boolean
  /** tools the tool slots offer, and handing one over (the physgun piece) */
  tools?: () => string[]
  give?: (tool: string) => boolean
  /** the console's own knob for what it is printed on */
  clear?: () => void
}

/* ---------------------------------------------------------- the registry -- */

export type ArgType =
  /** a whole number */
  | 'int'
  /** any number */
  | 'number'
  /** one word from `choices` */
  | 'choice'
  /** a prop kind */
  | 'kind'
  /** a place name or a player */
  | 'place'
  /** one word, anything */
  | 'word'
  /** the rest of the line */
  | 'text'

export interface ArgSpec {
  name: string
  type: ArgType
  optional?: boolean
  /** for 'choice' (and extra completions for 'word'/'place') */
  choices?: readonly string[] | ((host: SandboxHost) => readonly string[])
}

export interface CommandCtx {
  /** parsed arguments, as typed (numbers are validated, not converted) */
  args: string[]
  host: SandboxHost
  print: (line: ConsoleLine) => void
  out: (text: Msg) => void
  ok: (text: Msg) => void
  item: (text: Msg, right: Msg) => void
  /** print an error and stop; returns never so a handler can `return ctx.fail()` */
  fail: (text: Msg) => never
  /** the sandbox, or a printed explanation and a stop */
  needSandbox: () => Sandbox
}

export interface Command {
  name: string
  aliases?: string[]
  args?: ArgSpec[]
  help: Msg
  run: (ctx: CommandCtx) => void | Promise<void>
}

const REGISTRY = new Map<string, Command>()
const ALIASES = new Map<string, string>()

/** add a command, or replace the one already under that name */
export const registerCommand = (c: Command) => {
  const old = REGISTRY.get(c.name)
  if (old) for (const a of old.aliases ?? []) ALIASES.delete(a)
  REGISTRY.set(c.name, c)
  for (const a of c.aliases ?? []) ALIASES.set(a, c.name)
}
export const unregisterCommand = (name: string) => {
  const c = REGISTRY.get(name)
  if (!c) return
  for (const a of c.aliases ?? []) ALIASES.delete(a)
  REGISTRY.delete(name)
}
export const commandList = (): Command[] =>
  [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name))
export const findCommand = (name: string): Command | undefined =>
  REGISTRY.get(name) ?? REGISTRY.get(ALIASES.get(name) ?? '')

/** `spawn <kind> [n]` */
export const usage = (c: Command) =>
  [c.name, ...(c.args ?? []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`))].join(' ')

/* ------------------------------------------------------------ the kinds -- */

// The kind table lives in the sandbox's lazily loaded chunk (it builds
// geometry at import), so the console reaches it the same way: loaded on
// first need, cached for the completer, which has to answer synchronously
type KindsModule = typeof import('./kinds')
let kindsMod: KindsModule | null = null
let kindsLoading: Promise<KindsModule> | null = null
const loadKinds = () => {
  kindsLoading ??= import('./kinds').then((m) => (kindsMod = m))
  return kindsLoading
}
/** kind ids, for completion; empty until the kind table has loaded */
const kindIds = () => (kindsMod ? Object.keys(kindsMod.KINDS) : [])

/* ------------------------------------------------------------ parsing -- */

/** split a line into words, keeping "quoted phrases" whole */
export const tokenize = (line: string): string[] => {
  const out: string[] = []
  const re = /"([^"]*)"?|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2])
  return out
}

const isNum = (s: string) => s.trim() !== '' && Number.isFinite(Number(s))

/** plain edit distance, for "did you mean" */
const distance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
const nearest = (word: string, options: readonly string[]) => {
  let best: string | null = null
  let bestD = Infinity
  for (const o of options) {
    const d = distance(word, o)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : null
}

/* ---------------------------------------------------------- completion -- */

export interface Suggestion {
  /** the whole line after accepting it */
  line: string
  /** what the list shows */
  label: string
  /** the grey note beside it */
  detail?: Msg
}

export interface Completion {
  /** the command being typed, once its name is known */
  command: Command | null
  /** which argument the cursor is in (-1: the name itself) */
  argIndex: number
  suggestions: Suggestion[]
}

const choicesFor = (a: ArgSpec, host: SandboxHost): readonly string[] => {
  const extra = typeof a.choices === 'function' ? a.choices(host) : (a.choices ?? [])
  if (a.type === 'kind') return [...kindIds(), ...extra]
  return extra
}

/**
 * What the line being typed could become. The name first (every command and
 * alias starting with what is there), then, once a space has been typed after
 * a known name, the current argument's choices.
 */
export const complete = (raw: string, host: SandboxHost): Completion => {
  const line = raw.replace(/^\//, '')
  const slash = raw.startsWith('/') ? '/' : ''
  const words = tokenize(line)
  const trailing = /\s$/.test(line)
  if (words.length === 0 || (words.length === 1 && !trailing)) {
    const stem = (words[0] ?? '').toLowerCase()
    const names = commandList().filter((c) => c.name.startsWith(stem))
    // an alias match lists the command it stands for
    for (const [alias, name] of ALIASES) {
      const c = REGISTRY.get(name)
      if (alias.startsWith(stem) && c && !names.includes(c)) names.push(c)
    }
    return {
      command: findCommand(stem) ?? null,
      argIndex: -1,
      suggestions: names.slice(0, 8).map((c) => ({
        line: `${slash}${c.name}${c.args?.length ? ' ' : ''}`,
        label: usage(c),
        detail: c.help,
      })),
    }
  }
  const cmd = findCommand(words[0].toLowerCase()) ?? null
  if (!cmd) return { command: null, argIndex: -1, suggestions: [] }
  const argIndex = trailing ? words.length - 1 : words.length - 2
  const spec = cmd.args?.[argIndex]
  if (!spec) return { command: cmd, argIndex, suggestions: [] }
  const stem = trailing ? '' : words[words.length - 1].toLowerCase()
  const head = trailing ? words : words.slice(0, -1)
  const options = choicesFor(spec, host).filter((o) => o.toLowerCase().startsWith(stem))
  return {
    command: cmd,
    argIndex,
    suggestions: options.slice(0, 8).map((o) => ({
      line: `${slash}${[...head, /\s/.test(o) ? `"${o}"` : o].join(' ')} `,
      label: o,
    })),
  }
}

/* ------------------------------------------------------------ running -- */

class Stop extends Error {}

export interface Console {
  /** run one line; resolves with every line it printed */
  run: (line: string, opts?: { quiet?: boolean }) => Promise<ConsoleLine[]>
  complete: (line: string) => Completion
  /** every printed line, from any run (and from `print`) */
  onPrint: (fn: (line: ConsoleLine) => void) => () => void
  /** print from outside a command: a chat line, an undo from the Z key */
  print: (line: ConsoleLine) => void
  /** the lines a script typed, most recent last, for up/down recall */
  readonly recall: readonly string[]
  readonly host: SandboxHost
}

export const createConsole = (host: SandboxHost): Console => {
  const listeners = new Set<(l: ConsoleLine) => void>()
  const recall: string[] = []
  void loadKinds()
  const emit = (l: ConsoleLine) => {
    for (const fn of listeners) fn(l)
  }

  const run = async (raw: string, opts: { quiet?: boolean } = {}) => {
    const printed: ConsoleLine[] = []
    const print = (l: ConsoleLine) => {
      printed.push(l)
      emit(l)
    }
    const line = raw.trim().replace(/^\//, '')
    if (!line) return printed
    if (!opts.quiet) {
      if (recall[recall.length - 1] !== raw.trim()) recall.push(raw.trim())
      if (recall.length > 60) recall.shift()
      print({ tone: 'echo', text: `/${line}` })
    }
    const words = tokenize(line)
    const name = words[0].toLowerCase()
    const cmd = findCommand(name)
    const ctx: CommandCtx = {
      args: words.slice(1),
      host,
      print,
      out: (text) => print({ tone: 'out', text }),
      ok: (text) => print({ tone: 'ok', text }),
      item: (text, right) => print({ tone: 'item', text, right }),
      fail: (text) => {
        print({ tone: 'err', text })
        throw new Stop()
      },
      needSandbox: () => {
        const sb = host.sandbox()
        if (!sb) {
          return ctx.fail(msg(
            'props come with the world. step outside first',
            'los objetos llegan con el mundo. sal de la casa primero',
          ))
        }
        return sb
      },
    }
    try {
      if (!cmd) {
        const guess = nearest(name, [...REGISTRY.keys(), ...ALIASES.keys()])
        ctx.fail(guess
          ? msg(`no command "${name}". did you mean ${guess}?`, `no existe "${name}". ¿quisiste decir ${guess}?`)
          : msg(`no command "${name}". try help`, `no existe "${name}". prueba help`))
        return printed
      }
      // the arguments, checked against their types before the handler runs
      const specs = cmd.args ?? []
      const need = specs.filter((a) => !a.optional).length
      const textTail = specs[specs.length - 1]?.type === 'text'
      if (ctx.args.length < need) {
        ctx.fail(msg(`usage: ${usage(cmd)}`, `uso: ${usage(cmd)}`))
      }
      if (!textTail && ctx.args.length > specs.length) {
        ctx.fail(msg(`too many words. usage: ${usage(cmd)}`, `sobran palabras. uso: ${usage(cmd)}`))
      }
      if (textTail && ctx.args.length > specs.length) {
        const k = specs.length - 1
        ctx.args = [...ctx.args.slice(0, k), ctx.args.slice(k).join(' ')]
      }
      for (let i = 0; i < ctx.args.length && i < specs.length; i++) {
        const a = specs[i]
        const v = ctx.args[i]
        if ((a.type === 'int' || a.type === 'number') && !isNum(v)) {
          ctx.fail(msg(`${a.name} has to be a number, not "${v}"`, `${a.name} tiene que ser un número, no "${v}"`))
        }
        if (a.type === 'int' && !Number.isInteger(Number(v))) {
          ctx.fail(msg(`${a.name} has to be a whole number`, `${a.name} tiene que ser un número entero`))
        }
        if (a.type === 'choice') {
          const options = choicesFor(a, host)
          if (!options.includes(v.toLowerCase())) {
            ctx.fail(msg(`${a.name}: one of ${options.join(', ')}`, `${a.name}: uno de ${options.join(', ')}`))
          }
        }
      }
      await cmd.run(ctx)
    } catch (e) {
      if (!(e instanceof Stop)) {
        print({ tone: 'err', text: msg(`that broke: ${(e as Error).message}`, `eso se rompió: ${(e as Error).message}`) })
      }
    }
    return printed
  }

  return {
    run,
    complete: (line) => complete(line, host),
    onPrint: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    print: emit,
    recall,
    host,
  }
}

/* ------------------------------------------------------------ helpers -- */

const MAX_BATCH = 50
const LOTS = 500

const eyeRay = (host: SandboxHost) => {
  const a = host.aim?.()
  if (!a) return null
  return a
}

/** what is under the crosshair, within reach: a prop, the world, or nothing */
const aimedHit = (host: SandboxHost, sb: Sandbox, reach = 80) => {
  const a = eyeRay(host)
  if (!a) return null
  return sb.raycast(a.origin, a.dir, reach)
}

const aimedProp = (ctx: CommandCtx, sb: Sandbox) => {
  const hit = aimedHit(ctx.host, sb, 120)
  if (!hit?.prop) ctx.fail(msg('look at a prop first', 'apunta a un objeto primero'))
  return hit!.prop!
}

/** the owner filter for bulk commands: yours online, everything offline */
const mineOrAll = (host: SandboxHost, sb: Sandbox) => {
  const h = host.history()
  const online = host.online?.() ?? false
  const ids: PropId[] = []
  sb.forEach((p) => {
    if (!online || !h || h.ownerOf(p.id) === h.me) ids.push(p.id)
  })
  return ids
}

const plural = (n: number, label: string) => (n === 1 ? label : `${label}s`)
const pluralEs = (n: number, label: string) =>
  n === 1 ? label : /[aeiouáéó]$/.test(label) ? `${label}s` : `${label}es`

/** a kind's name in the language asked for, via the spawnlist fallback */
const kindLabel = (k: PropKind, lang: Lang) =>
  lang === 'es' ? ((k as PropKind & { labelEs?: string }).labelEs ?? ES_KIND[k.id] ?? k.label) : k.label
const ES_KIND: Record<string, string> = {
  crate: 'caja de madera', barrel: 'barril de aceite', plank: 'tablón',
  block: 'bloque de concreto', cone: 'cono', ball: 'bola',
}

/**
 * Where a batch of `n` props goes, around what the crosshair is on. One prop
 * lands on the spot; more are laid out in a tidy square pile, up to four a
 * side, layer on layer, facing the player, the way a stack of crates arrives
 * off a lorry, so ten of anything is something to knock over rather than an
 * explosion of overlapping bodies.
 */
const placeBatch = (
  host: SandboxHost, sb: Sandbox, k: PropKind, n: number, ext: THREE.Vector3,
): { at: Vec3[]; yaw: number } => {
  const a = eyeRay(host)
  const yaw = host.here?.().yaw ?? 0
  const origin = a?.origin ?? sb.focus
  const dir = a?.dir ?? { x: 0, y: 0, z: -1 }
  const hit = sb.raycast(origin, dir, 60)
  const r = Math.max(ext.x, ext.z)
  let bx: number
  let bz: number
  let by: number
  if (hit) {
    // back off the surface: straight up off a floor, out of a wall along its
    // normal, so nothing is born inside what it was aimed at
    bx = hit.point.x + hit.normal.x * (hit.normal.y > 0.6 ? 0 : r + 0.1)
    bz = hit.point.z + hit.normal.z * (hit.normal.y > 0.6 ? 0 : r + 0.1)
    by = hit.normal.y > 0.6 ? hit.point.y + ext.y + 0.04 : hit.point.y
  } else {
    bx = origin.x + dir.x * 14
    bz = origin.z + dir.z * 14
    by = origin.y + dir.y * 14
  }
  by = Math.max(by, sb.restY(k.id, bx, bz))
  const side = Math.min(4, Math.ceil(Math.sqrt(n)))
  const perLayer = side * side
  const gap = 2 * r + 0.08
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  const at: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const layer = Math.floor(i / perLayer)
    const j = i % perLayer
    const inLayer = Math.min(perLayer, n - layer * perLayer)
    const s = Math.ceil(Math.sqrt(inLayer))
    const u = (j % s) - (s - 1) / 2
    const v = Math.floor(j / s) - (Math.ceil(inLayer / s) - 1) / 2
    const x = bx + rx * u * gap + fx * v * gap
    const z = bz + rz * u * gap + fz * v * gap
    at.push({ x, y: Math.max(by, sb.restY(k.id, x, z)) + layer * (2 * ext.y + 0.03), z })
  }
  return { at, yaw }
}

const spawnBatch = async (ctx: CommandCtx, kindId: string, n: number, how: 'aim' | 'rain') => {
  const sb = ctx.needSandbox()
  const { KINDS, shapeExtents } = await loadKinds()
  const k = KINDS[kindId]
  if (!k) {
    const guess = nearest(kindId, Object.keys(KINDS))
    ctx.fail(guess
      ? msg(`no prop called "${kindId}". did you mean ${guess}?`, `no hay "${kindId}". ¿quisiste decir ${guess}?`)
      : msg(`no prop called "${kindId}". the spawn menu (q) lists them`, `no hay "${kindId}". el menú (q) los muestra`))
  }
  if (n < 1) ctx.fail(msg('at least one', 'por lo menos uno'))
  const count = Math.min(MAX_BATCH, n)
  const ext = shapeExtents(k.shape)
  const ids: PropId[] = []
  if (how === 'aim') {
    const { at, yaw } = placeBatch(ctx.host, sb, k, count, ext)
    for (const p of at) {
      // a whisker of yaw so a pile looks stacked by hand, not by a machine
      ids.push(sb.spawn(k.id, p, { yaw: yaw + (count > 1 ? (Math.random() - 0.5) * 0.08 : 0) }))
    }
  } else {
    const here = ctx.host.here?.() ?? { x: sb.focus.x, y: sb.focus.y, z: sb.focus.z, yaw: 0 }
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const d = Math.sqrt(Math.random()) * 11
      const x = here.x + Math.cos(a) * d
      const z = here.z + Math.sin(a) * d
      const y = Math.max(here.y, sb.groundY(x, z)) + 24 + i * (2 * ext.y + 0.6)
      ids.push(sb.spawn(k.id, { x, y, z }, {
        quaternion: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)),
        angular: { x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 },
      }))
    }
  }
  const h = ctx.host.history()
  h?.record({
    label: count === 1 ? k.label : `${count} ${plural(count, k.label)}`,
    kind: k.id,
    props: ids,
  })
  ctx.item(
    msg(plural(count, k.label), pluralEs(count, kindLabel(k, 'es'))),
    `x${count}`,
  )
  if (n > MAX_BATCH) ctx.out(msg(`${MAX_BATCH} at a time`, `${MAX_BATCH} a la vez`))
  if (sb.count > LOTS) {
    ctx.out(msg(`${sb.count} props out here. cleanup clears yours`, `${sb.count} objetos por aquí. cleanup limpia los tuyos`))
  }
  return ids
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString()

/** named times of day, on the sky's clock (0.25 sunrise, 0.5 noon) */
const TIMES: Record<string, number> = {
  dawn: 0.255, sunrise: 0.26, morning: 0.36, noon: 0.5, afternoon: 0.6,
  golden: 0.71, sunset: 0.745, dusk: 0.765, evening: 0.8, night: 0.9, midnight: 0,
}
const parseTime = (s: string): number | null => {
  const w = s.toLowerCase()
  if (w in TIMES) return TIMES[w]
  const hm = /^(\d{1,2}):(\d{2})$/.exec(w)
  if (hm) return ((Number(hm[1]) % 24) + Number(hm[2]) / 60) / 24
  if (isNum(w)) {
    const v = Number(w)
    // 0..1 is the sky's own clock; anything past it is an hour
    return v <= 1 ? v : (v % 24) / 24
  }
  return null
}
const clock = (tod: number) => {
  const m = Math.round(((tod % 1) + 1) % 1 * 24 * 60)
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const GRAVITY_WORDS: Record<string, number> = {
  earth: 1, normal: 1, moon: 0.17, mars: 0.38, off: 0, zero: 0, space: 0, jupiter: 2.4, heavy: 2,
}
const FOG_WORDS: Record<string, number> = { normal: 1, clear: 1, light: 1.4, thick: 2.6, soup: 4.5 }

const DISTRICTS = ['downtown', 'midrise', 'suburb']
const LANDMARKS = ['lighthouse', 'windmill', 'farm', 'mast', 'ruins', 'watertower', 'stones', 'cabin', 'wreck']
const BIOME_IDS = ['beach', 'plains', 'forest', 'taiga', 'tundra', 'snow', 'desert', 'savanna', 'jungle', 'wetland', 'rock', 'ocean']
const PLACES = [
  'home',
  ...DISTRICTS.map((d) => `town:${d}`),
  ...LANDMARKS.map((k) => `landmark:${k}`),
  ...BIOME_IDS.map((b) => `biome:${b}`),
]

/* ---------------------------------------------------------- the commands -- */

registerCommand({
  name: 'help',
  aliases: ['?', 'commands'],
  args: [{ name: 'command', type: 'word', optional: true, choices: () => commandList().map((c) => c.name) }],
  help: msg('what every command does', 'qué hace cada comando'),
  run: (ctx) => {
    const name = ctx.args[0]?.toLowerCase()
    if (name) {
      const c = findCommand(name)
      if (!c) ctx.fail(msg(`no command "${name}"`, `no existe "${name}"`))
      ctx.print({ tone: 'help', text: `/${usage(c!)}` })
      ctx.print({ tone: 'out', text: c!.help })
      if (c!.aliases?.length) ctx.out(msg(`also: ${c!.aliases.join(', ')}`, `también: ${c!.aliases.join(', ')}`))
      return
    }
    for (const c of commandList()) ctx.print({ tone: 'help', text: `/${usage(c)}`, right: c.help })
    ctx.out(msg(
      'tab completes, up and down go back through what you typed',
      'tab completa, arriba y abajo repiten lo que escribiste',
    ))
  },
})

registerCommand({
  name: 'clear',
  aliases: ['cls'],
  help: msg('tear off the receipt', 'arranca el recibo'),
  run: (ctx) => {
    ctx.host.clear?.()
  },
})

registerCommand({
  name: 'spawn',
  aliases: ['s', 'give_prop'],
  args: [
    { name: 'prop', type: 'kind' },
    { name: 'n', type: 'int', optional: true },
  ],
  help: msg(
    'drop a prop where you are looking. with n, a stack of them',
    'suelta un objeto donde estás mirando. con n, una pila',
  ),
  run: async (ctx) => {
    await spawnBatch(ctx, ctx.args[0].toLowerCase(), ctx.args[1] ? Number(ctx.args[1]) : 1, 'aim')
  },
})

registerCommand({
  name: 'rain',
  args: [
    { name: 'prop', type: 'kind' },
    { name: 'n', type: 'int', optional: true },
  ],
  help: msg('drop props on your own head', 'deja caer objetos sobre tu cabeza'),
  run: async (ctx) => {
    await spawnBatch(ctx, ctx.args[0].toLowerCase(), ctx.args[1] ? Number(ctx.args[1]) : 12, 'rain')
  },
})

registerCommand({
  name: 'undo',
  aliases: ['u'],
  help: msg('take back the last thing you spawned (z does it too)', 'deshace lo último que sacaste (también con z)'),
  run: (ctx) => {
    ctx.needSandbox()
    const e = ctx.host.history()?.undo()
    if (!e) ctx.fail(msg('nothing left to undo', 'no queda nada que deshacer'))
    ctx.ok(msg(`undone: ${e!.label}`, `deshecho: ${e!.label}`))
  },
})

registerCommand({
  name: 'cleanup',
  args: [{ name: 'whose', type: 'choice', optional: true, choices: ['mine', 'all'] }],
  help: msg(
    'remove every prop you made, or everyone\'s with "all"',
    'quita todo lo que sacaste, o lo de todos con "all"',
  ),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const h = ctx.host.history()
    const all = ctx.args[0]?.toLowerCase() === 'all'
    const online = ctx.host.online?.() ?? false
    if (all || !online) {
      let n = 0
      const how = ctx.host.rules.act('cleanup-all', () => {
        n = h ? h.cleanup('all') : sb.count
        if (!h) sb.clear()
      })
      if (how === 'sent') ctx.out(msg('asked the server to clean up', 'se le pidió al servidor que limpie'))
      else ctx.ok(msg(`cleaned up ${n} ${plural(n, 'prop')}`, `se limpiaron ${n} ${pluralEs(n, 'objeto')}`))
      return
    }
    const n = h?.cleanup() ?? 0
    ctx.ok(msg(`cleaned up ${n} of yours`, `se limpiaron ${n} tuyos`))
  },
})

registerCommand({
  name: 'remove',
  aliases: ['delete', 'rm'],
  help: msg('remove the prop you are looking at', 'quita el objeto que estás mirando'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const p = aimedProp(ctx, sb)
    sb.remove(p.id)
    ctx.ok(msg(`removed: ${p.kind.label}`, `quitado: ${kindLabel(p.kind, 'es')}`))
  },
})

registerCommand({
  name: 'freeze',
  help: msg('pin the prop you are looking at where it is', 'fija en su lugar el objeto que estás mirando'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const p = aimedProp(ctx, sb)
    sb.freeze(p.id)
    ctx.ok(msg(`frozen: ${p.kind.label}`, `congelado: ${kindLabel(p.kind, 'es')}`))
  },
})

registerCommand({
  name: 'unfreeze',
  help: msg('let go of the prop you are looking at', 'suelta el objeto que estás mirando'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const p = aimedProp(ctx, sb)
    sb.unfreeze(p.id)
    sb.wake(p.id)
    ctx.ok(msg(`unfrozen: ${p.kind.label}`, `descongelado: ${kindLabel(p.kind, 'es')}`))
  },
})

registerCommand({
  name: 'freezeall',
  help: msg('pin every prop of yours where it is', 'fija todos tus objetos donde están'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const ids = mineOrAll(ctx.host, sb).filter((id) => sb.get(id)?.mode === 'dynamic')
    for (const id of ids) sb.freeze(id)
    ctx.ok(msg(`froze ${ids.length}`, `se congelaron ${ids.length}`))
  },
})

registerCommand({
  name: 'unfreezeall',
  help: msg('let every prop of yours fall again', 'deja caer de nuevo todos tus objetos'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const ids = mineOrAll(ctx.host, sb).filter((id) => sb.get(id)?.mode === 'frozen')
    for (const id of ids) {
      sb.unfreeze(id)
      sb.wake(id)
    }
    ctx.ok(msg(`let go of ${ids.length}`, `se soltaron ${ids.length}`))
  },
})

/*
  The plain explosion: an impulse away from the point on every prop in the
  radius, falling off with distance, and a fling for the player if they are
  standing in it. No flash and no sound; the props piece owns those and
  replaces this command wholesale with `registerCommand` when it lands.
*/
registerCommand({
  name: 'explode',
  aliases: ['boom'],
  args: [{ name: 'power', type: 'number', optional: true }],
  help: msg('blow up whatever you are looking at', 'hace explotar lo que estás mirando'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const hit = aimedHit(ctx.host, sb, 150)
    if (!hit) ctx.fail(msg('look at something first', 'apunta a algo primero'))
    const power = Math.max(0.1, Math.min(10, ctx.args[0] ? Number(ctx.args[0]) : 1))
    const radius = 9 * Math.sqrt(power)
    const c = hit!.point.clone().addScaledVector(hit!.normal, 0.5)
    let n = 0
    const pos = new THREE.Vector3()
    sb.queryBall(c, radius, (p) => {
      if (p.mode === 'frozen') return
      sb.getTransform(p.id, pos)
      const d = pos.distanceTo(c)
      const fall = 1 - d / radius
      if (fall <= 0) return
      const dir = pos.sub(c).normalize()
      dir.y += 0.5 // explosions throw things up, not just out
      dir.normalize()
      const speed = 34 * power * fall
      sb.wake(p.id)
      sb.applyImpulse(p.id, dir.multiplyScalar(speed * p.mass))
      n++
    })
    const me = ctx.host.here?.()
    if (me && !ctx.host.god?.()) {
      const d = Math.hypot(me.x - c.x, me.y + 2 - c.y, me.z - c.z)
      if (d < radius) {
        const k = (1 - d / radius) * 30 * power
        const dx = (me.x - c.x) / (d || 1)
        const dz = (me.z - c.z) / (d || 1)
        ctx.host.fling?.(dx * k, 8 + k * 0.6, dz * k)
      }
    }
    ctx.ok(msg(`boom (${n} ${plural(n, 'prop')} thrown)`, `bum (${n} ${pluralEs(n, 'objeto')} volando)`))
  },
})

registerCommand({
  name: 'tp',
  aliases: ['teleport', 'goto'],
  args: [
    {
      name: 'where', type: 'place',
      choices: (host) => [...PLACES, ...(host.players?.().map((p) => p.name) ?? [])],
    },
    { name: 'z', type: 'number', optional: true },
  ],
  help: msg(
    'go somewhere: x z, a player, home, town:downtown, landmark:lighthouse, biome:snow',
    've a algún lado: x z, un jugador, home, town:downtown, landmark:lighthouse, biome:snow',
  ),
  run: async (ctx) => {
    const host = ctx.host
    if (!host.teleport || !host.here) ctx.fail(msg('nowhere to go from here', 'no hay a dónde ir desde aquí'))
    const [a, b] = ctx.args
    const here = host.here!()
    if (isNum(a)) {
      if (b === undefined || !isNum(b)) ctx.fail(msg('usage: tp <x> <z>', 'uso: tp <x> <z>'))
      host.teleport!(Number(a), Number(b))
      ctx.ok(msg(`went to ${fmt(Number(a))}, ${fmt(Number(b))}`, `fuiste a ${fmt(Number(a))}, ${fmt(Number(b))}`))
      return
    }
    const want = a.toLowerCase()
    if (want === 'home' || want === 'spawn') {
      const h = host.home?.()
      if (!h) ctx.fail(msg('no home here', 'aquí no hay casa'))
      host.teleport!(h!.x, h!.z, undefined, h!.yaw)
      ctx.ok(msg('home', 'a casa'))
      return
    }
    const who = host.players?.().find((p) => p.name.toLowerCase() === want) ??
      host.players?.().find((p) => p.name.toLowerCase().startsWith(want))
    if (who) {
      // beside them, not inside them
      host.teleport!(who.x + 2.5, who.z + 2.5, who.y)
      ctx.ok(msg(`went to ${who.name}`, `fuiste donde ${who.name}`))
      return
    }
    const { findPlace } = await import('./places')
    const found = findPlace(want, here.x, here.z)
    if (!found) {
      const guess = nearest(want, PLACES)
      ctx.fail(guess
        ? msg(`don't know "${want}". did you mean ${guess}?`, `no conozco "${want}". ¿quisiste decir ${guess}?`)
        : msg(`don't know "${want}"`, `no conozco "${want}"`))
    }
    host.teleport!(found!.x, found!.z, undefined, found!.yaw)
    const d = Math.round(Math.hypot(found!.x - here.x, found!.z - here.z))
    ctx.item(found!.label, `${d} u`)
  },
})

registerCommand({
  name: 'where',
  aliases: ['pos', 'getpos'],
  help: msg('where you are standing', 'dónde estás parado'),
  run: (ctx) => {
    const h = ctx.host.here?.()
    if (!h) ctx.fail(msg('nowhere, apparently', 'en ningún lado, parece'))
    ctx.out(`x ${fmt(h!.x)}  y ${fmt(h!.y)}  z ${fmt(h!.z)}`)
  },
})

const toggle = (ctx: CommandCtx, f: ((on?: boolean) => boolean) | undefined, name: Msg) => {
  if (!f) ctx.fail(msg('not here', 'aquí no'))
  const on = f!(!f!())
  ctx.ok(on
    ? msg(`${say(name, 'en')} on`, `${say(name, 'es')} activado`)
    : msg(`${say(name, 'en')} off`, `${say(name, 'es')} desactivado`))
}

registerCommand({
  name: 'noclip',
  aliases: ['fly'],
  help: msg('fly through anything (v does it too)', 'vuela a través de todo (también con v)'),
  run: (ctx) => toggle(ctx, ctx.host.noclip, msg('noclip', 'noclip')),
})

registerCommand({
  name: 'god',
  aliases: ['buddha'],
  help: msg('nothing can knock you over', 'nada te puede tumbar'),
  run: (ctx) => toggle(ctx, ctx.host.god, msg('god mode', 'modo dios')),
})

registerCommand({
  name: 'thirdperson',
  aliases: ['camera', 'tp3'],
  help: msg('see yourself from behind (f5 does it too)', 'mírate desde atrás (también con f5)'),
  run: (ctx) => toggle(ctx, ctx.host.thirdPerson, msg('third person', 'tercera persona')),
})

registerCommand({
  name: 'kill',
  aliases: ['suicide'],
  help: msg('fall over in a heap', 'cae hecho un bulto'),
  run: (ctx) => {
    const a = ctx.host.here?.()
    const yaw = a?.yaw ?? 0
    // backwards and a little sideways, with a hop so it always tumbles
    const s = Math.random() < 0.5 ? -1 : 1
    const vx = Math.sin(yaw) * 6 + Math.cos(yaw) * 3 * s
    const vz = Math.cos(yaw) * 6 - Math.sin(yaw) * 3 * s
    if (!ctx.host.fling?.(vx, 7, vz)) ctx.fail(msg('you are fine where you are', 'así estás bien'))
    ctx.out(msg('down you go. x or wasd to get up', 'al suelo. x o wasd para levantarte'))
  },
})

registerCommand({
  name: 'ragdoll',
  aliases: ['flop'],
  help: msg('go limp (x does it too)', 'suéltate (también con x)'),
  run: (ctx) => {
    if (!ctx.host.fling?.(0, 1.6, 0)) ctx.fail(msg('not now', 'ahora no'))
  },
})

registerCommand({
  name: 'launch',
  aliases: ['yeet'],
  args: [{ name: 'power', type: 'number', optional: true }],
  help: msg('throw yourself the way you are looking', 'lánzate hacia donde estás mirando'),
  run: (ctx) => {
    const a = ctx.host.aim?.()
    const k = 28 * Math.max(0.2, Math.min(4, ctx.args[0] ? Number(ctx.args[0]) : 1))
    if (!a || !ctx.host.fling?.(a.dir.x * k, a.dir.y * k + 10, a.dir.z * k)) {
      ctx.fail(msg('not now', 'ahora no'))
    }
  },
})

registerCommand({
  name: 'sit',
  help: msg('sit on the seat in front of you', 'siéntate en el asiento de enfrente'),
  run: (ctx) => {
    if (!ctx.host.sit?.()) ctx.fail(msg('nothing to sit on here', 'aquí no hay dónde sentarse'))
  },
})

registerCommand({
  name: 'gravity',
  aliases: ['sv_gravity'],
  args: [{ name: 'g', type: 'word', choices: Object.keys(GRAVITY_WORDS) }],
  help: msg(
    'how hard things fall: 1 is normal, 0 floats, moon, mars, jupiter',
    'qué tan fuerte cae todo: 1 es normal, 0 flota, moon, mars, jupiter',
  ),
  run: (ctx) => {
    const w = ctx.args[0].toLowerCase()
    let g = w in GRAVITY_WORDS ? GRAVITY_WORDS[w] : isNum(w) ? Number(w) : NaN
    if (!Number.isFinite(g)) ctx.fail(msg('a number, or moon, mars, earth, off', 'un número, o moon, mars, earth, off'))
    // Garry's Mod people type sv_gravity 600; meet them where they are
    if (Math.abs(g) > 20) g /= 600
    if (ctx.host.rules.propose('gravity', g) === 'sent') {
      ctx.out(msg('asked the server for that gravity', 'se le pidió esa gravedad al servidor'))
    } else {
      ctx.ok(msg(`gravity x${fmt(ctx.host.rules.gravity)}`, `gravedad x${fmt(ctx.host.rules.gravity)}`))
    }
  },
})

registerCommand({
  name: 'timescale',
  aliases: ['host_timescale', 'slowmo'],
  args: [{ name: 's', type: 'number' }],
  help: msg('how fast the props\' clock runs: 1 normal, 0.2 slow motion', 'qué tan rápido corre el tiempo de los objetos: 1 normal, 0.2 cámara lenta'),
  run: (ctx) => {
    const s = Number(ctx.args[0])
    if (ctx.host.rules.propose('timescale', s) === 'sent') {
      ctx.out(msg('asked the server for that timescale', 'se le pidió esa velocidad al servidor'))
    } else {
      ctx.ok(msg(`timescale x${fmt(ctx.host.rules.timescale)}`, `velocidad x${fmt(ctx.host.rules.timescale)}`))
    }
  },
})

registerCommand({
  name: 'time',
  args: [{ name: 'when', type: 'word', optional: true, choices: [...Object.keys(TIMES), 'run'] }],
  help: msg(
    'pin the time of day (noon, dusk, night, 18:30, 0.75); alone, lets it run',
    'fija la hora (noon, dusk, night, 18:30, 0.75); sin nada, la suelta',
  ),
  run: (ctx) => {
    if (!ctx.host.time) ctx.fail(msg('no sky here', 'aquí no hay cielo'))
    const w = ctx.args[0]
    if (!w || w === 'run' || w === 'live') {
      ctx.host.time!(null)
      ctx.ok(msg('the clock runs again', 'el reloj vuelve a correr'))
      return
    }
    const tod = parseTime(w)
    if (tod === null) ctx.fail(msg('a time like noon, dusk or 18:30', 'una hora como noon, dusk o 18:30'))
    ctx.host.time!(tod)
    ctx.ok(msg(`it is ${clock(tod!)} now`, `ahora son las ${clock(tod!)}`))
  },
})

registerCommand({
  name: 'fog',
  aliases: ['weather'],
  args: [{ name: 'thickness', type: 'word', optional: true, choices: Object.keys(FOG_WORDS) }],
  help: msg('how thick the fog is: 1 normal up to 6, or thick, soup', 'qué tan espesa es la neblina: 1 normal hasta 6, o thick, soup'),
  run: (ctx) => {
    if (!ctx.host.fog) ctx.fail(msg('no weather here', 'aquí no hay clima'))
    const w = (ctx.args[0] ?? 'normal').toLowerCase()
    const k = w in FOG_WORDS ? FOG_WORDS[w] : isNum(w) ? Number(w) : NaN
    if (!Number.isFinite(k)) ctx.fail(msg('a number from 1 to 6', 'un número del 1 al 6'))
    const v = Math.max(1, Math.min(6, k))
    ctx.host.fog!(v)
    ctx.ok(v === 1 ? msg('the fog is back to normal', 'la neblina volvió a la normalidad') : msg(`fog x${fmt(v)}`, `neblina x${fmt(v)}`))
  },
})

registerCommand({
  name: 'give',
  args: [{ name: 'tool', type: 'word', choices: (host) => host.tools?.() ?? [] }],
  help: msg('put a tool in your hands', 'ponte una herramienta en las manos'),
  run: (ctx) => {
    if (!ctx.host.give) ctx.fail(msg('no tools yet', 'todavía no hay herramientas'))
    const t = ctx.args[0].toLowerCase()
    if (!ctx.host.give!(t)) {
      const all = ctx.host.tools?.() ?? []
      ctx.fail(msg(`no tool "${t}". there is ${all.join(', ') || 'nothing'}`, `no hay "${t}". hay ${all.join(', ') || 'nada'}`))
    }
    ctx.ok(msg(`you have the ${t}`, `tienes: ${t}`))
  },
})

registerCommand({
  name: 'props',
  aliases: ['count'],
  help: msg('how many props are out here, and how many are yours', 'cuántos objetos hay, y cuántos son tuyos'),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const h = ctx.host.history()
    const mine = h?.propsOf().length ?? 0
    ctx.item(msg('props out here', 'objetos por aquí'), String(sb.count))
    ctx.item(msg('yours', 'tuyos'), String(mine))
    ctx.item(msg('moving', 'moviéndose'), String(sb.stats.awake))
  },
})

registerCommand({
  name: 'say',
  args: [{ name: 'text', type: 'text' }],
  help: msg('say something to everyone out here', 'dile algo a todos los que están aquí'),
  run: (ctx) => {
    if (!ctx.host.chat?.(ctx.args[0])) ctx.fail(msg('nobody out here to hear it', 'no hay nadie que lo escuche'))
  },
})
