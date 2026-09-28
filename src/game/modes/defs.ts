import type { RoundModeId } from '../net/roundProtocol'

/*
  The presentation side of the mode table. The rules of each mode are the
  server's (server/src/roundModes.js); what lives here is everything a person
  reads or sees: its name and one-line pitch in both languages, how many it
  needs, the maps it may be played on, the colours of its sides, what each
  role is told, and the words of the announcements the server sends by code.
  A sixth mode is an entry in that table, an entry here, and a picture in
  components/os/PlayPanel.tsx; `test/rounds-defs` (server/test/roundsDefs.mjs)
  keeps the two tables from drifting on ids, minimums and levels.

  Bilingual as everything user-facing is: each string is `{ en, es }` and
  `say()` picks one. This file is React-free so a headless run can print a
  round's story in either language.
*/

export type Lang = 'en' | 'es'
export interface Bilingual { en: string; es: string }
export const say = (b: Bilingual, lang: Lang) => b[lang]

export interface SideDef {
  /** the key the server uses on a participant row ('a' or 'b') */
  team: 'a' | 'b'
  color: string
  name: Bilingual
}

export interface RoleDef {
  /** the role string on a participant row */
  role: string
  team: 'a' | 'b'
  name: Bilingual
  /** what the role is told when the round begins */
  brief: Bilingual
}

export interface OptionDef {
  key: string
  label: Bilingual
  kind: 'bool' | 'choice'
  /** for a choice: the values in order and their labels */
  choices?: Array<{ value: number; label: Bilingual }>
}

export interface ModeDef {
  id: RoundModeId
  name: Bilingual
  blurb: Bilingual
  /** how it is played, in a sentence or two, for the lobby sheet */
  rules: Bilingual
  min: number
  max: number
  /** the maps it may run on, first is the default (level ids, MAPS in levels/maps.ts) */
  levels: string[]
  /** the two sides, when it has them */
  sides: SideDef[]
  roles: RoleDef[]
  options: OptionDef[]
  /** the controls it adds, for the HUD's hint line */
  keys: Bilingual
}

export const LEVEL_NAMES: Record<string, Bilingual> = {
  nuketown: { en: 'Nuketown', es: 'Nuketown' },
  overworld: { en: 'Home planet', es: 'Planeta natal' },
  cubeland: { en: 'Cubeland', es: 'Cubeland' },
}

const RED = '#c9503c'
const BLUE = '#3f74c4'
const GREEN = '#5b9a4e'
const AMBER = '#cf8a2e'

export const MODE_DEFS: Record<RoundModeId, ModeDef> = {
  deathmatch: {
    id: 'deathmatch',
    name: { en: 'Deathmatch', es: 'Duelo a muerte' },
    blurb: { en: 'Two teams, one street, first to the kill limit.', es: 'Dos equipos, una calle, gana quien llegue primero al límite de bajas.' },
    rules: {
      en: 'Pistol, crossbow and rocket launcher. Respawn in three seconds. First team to 40 kills wins (20 in free for all), or the most after five minutes.',
      es: 'Pistola, ballesta y lanzacohetes. Reapareces a los tres segundos. Gana el primer equipo con 40 bajas (20 sin equipos), o el que más tenga a los cinco minutos.',
    },
    min: 2, max: 16,
    levels: ['nuketown'],
    sides: [
      { team: 'a', color: RED, name: { en: 'Red', es: 'Rojo' } },
      { team: 'b', color: BLUE, name: { en: 'Blue', es: 'Azul' } },
    ],
    roles: [],
    options: [
      { key: 'teams', kind: 'bool', label: { en: 'Teams', es: 'Equipos' } },
      { key: 'limit', kind: 'choice', label: { en: 'Kill limit', es: 'Límite de bajas' }, choices: [{ value: 0, label: { en: 'auto', es: 'auto' } }, { value: 5, label: { en: '5', es: '5' } }, { value: 10, label: { en: '10', es: '10' } }, { value: 20, label: { en: '20', es: '20' } }, { value: 40, label: { en: '40', es: '40' } }] },
    ],
    keys: { en: 'Tab scores', es: 'Tab marcador' },
  },
  prophunt: {
    id: 'prophunt',
    name: { en: 'Prop hunt', es: 'Escondite de objetos' },
    blurb: { en: 'Props hide as the clutter around them. Hunters shoot the wrong things and pay for it.', es: 'Los objetos se disfrazan de trastos. Los cazadores disparan a lo que no es y lo pagan.' },
    rules: {
      en: 'Hunters wait 30 s while the props pick a disguise (look at a thing and press Y). Then four minutes: every wrong shot at a real prop costs a hunter 5 hp. Props win by surviving.',
      es: 'Los cazadores esperan 30 s mientras los objetos se disfrazan (mira algo y pulsa Y). Luego cuatro minutos: cada disparo a un objeto de verdad cuesta 5 de vida. Los objetos ganan sobreviviendo.',
    },
    min: 2, max: 12,
    levels: ['nuketown'],
    sides: [
      { team: 'a', color: GREEN, name: { en: 'Props', es: 'Objetos' } },
      { team: 'b', color: AMBER, name: { en: 'Hunters', es: 'Cazadores' } },
    ],
    roles: [
      { role: 'prop', team: 'a', name: { en: 'Prop', es: 'Objeto' }, brief: { en: 'Hide among the clutter. Look at a thing and press Y to become it.', es: 'Escóndete entre los trastos. Mira algo y pulsa Y para convertirte.' } },
      { role: 'hunter', team: 'b', name: { en: 'Hunter', es: 'Cazador' }, brief: { en: 'Find the props. Shoot only what does not belong: wrong shots cost 5 hp.', es: 'Encuentra los objetos. Dispara solo a lo que sobra: cada error cuesta 5 de vida.' } },
    ],
    options: [],
    keys: { en: 'Y become the thing you look at (again: yourself)', es: 'Y volverte lo que miras (otra vez: tú)' },
  },
  hide: {
    id: 'hide',
    name: { en: 'Hide and seek', es: 'Escondite' },
    blurb: { en: 'Hide for thirty seconds. Whoever is caught becomes a seeker. Last hider wins.', es: 'Escóndete treinta segundos. A quien atrapan se vuelve buscador. Gana el último escondido.' },
    rules: {
      en: 'Seekers are frozen for the first 30 s. A pistol hit or a punch tags a hider, who joins the seekers. Last hider standing wins; hiders win if the four minutes run out.',
      es: 'Los buscadores están congelados los primeros 30 s. Un disparo de pistola o un golpe atrapa a un escondido, que pasa a buscar. Gana el último escondido; si se acaban los cuatro minutos ganan los escondidos.',
    },
    min: 2, max: 12,
    levels: ['nuketown', 'overworld', 'cubeland'],
    sides: [
      { team: 'a', color: GREEN, name: { en: 'Hiders', es: 'Escondidos' } },
      { team: 'b', color: RED, name: { en: 'Seekers', es: 'Buscadores' } },
    ],
    roles: [
      { role: 'hider', team: 'a', name: { en: 'Hider', es: 'Escondido' }, brief: { en: 'Run and hide. You are unarmed.', es: 'Corre y escóndete. No tienes armas.' } },
      { role: 'seeker', team: 'b', name: { en: 'Seeker', es: 'Buscador' }, brief: { en: 'Wait out the countdown, then tag them: pistol, or a punch (F).', es: 'Espera la cuenta y atrápalos: pistola, o un golpe (F).' } },
    ],
    options: [{ key: 'seekers', kind: 'choice', label: { en: 'Seekers', es: 'Buscadores' }, choices: [{ value: 0, label: { en: 'auto', es: 'auto' } }, { value: 1, label: { en: 'one', es: 'uno' } }, { value: 2, label: { en: 'two', es: 'dos' } }] }],
    keys: { en: 'F punch (seekers)', es: 'F golpe (buscadores)' },
  },
  race: {
    id: 'race',
    name: { en: 'Race', es: 'Carrera' },
    blurb: { en: 'Glowing rings, laps and a clock. Cars on the streets, feet in Cubeland.', es: 'Aros luminosos, vueltas y un reloj. Coches en las calles, a pie en Cubeland.' },
    rules: {
      en: 'Pass every ring in order. On the home planet there is one car, so you take turns against the clock; in Cubeland everyone runs at once. Best time wins.',
      es: 'Cruza todos los aros en orden. En el planeta natal hay un solo coche, así que corren por turnos contra el reloj; en Cubeland corren todos a la vez. Gana el mejor tiempo.',
    },
    min: 2, max: 8,
    levels: ['overworld', 'cubeland'],
    sides: [],
    roles: [],
    options: [{ key: 'laps', kind: 'choice', label: { en: 'Laps', es: 'Vueltas' }, choices: [{ value: 1, label: { en: '1', es: '1' } }, { value: 2, label: { en: '2', es: '2' } }, { value: 3, label: { en: '3', es: '3' } }] }],
    keys: { en: '', es: '' },
  },
  build: {
    id: 'build',
    name: { en: 'Build contest', es: 'Concurso de construcción' },
    blurb: { en: 'A theme, a plot each, five minutes. Then everyone tours the plots and marks them.', es: 'Un tema, una parcela para cada uno, cinco minutos. Luego todos visitan las parcelas y las puntúan.' },
    rules: {
      en: 'Only you can edit your 32x32 plot. After five minutes the gallery visits each plot for 20 s: press 1 to 5 to mark it. Highest total wins.',
      es: 'Solo tú puedes editar tu parcela de 32x32. A los cinco minutos la galería visita cada parcela 20 s: pulsa de 1 a 5 para puntuarla. Gana la mayor suma.',
    },
    min: 2, max: 8,
    levels: ['cubeland'],
    sides: [],
    roles: [],
    options: [],
    keys: { en: '1-5 mark the plot', es: '1-5 puntuar la parcela' },
  },
}

export const MODE_LIST: readonly ModeDef[] = Object.values(MODE_DEFS)

/** the build contest's themes, indexed by the number the server sends */
export const THEMES: Bilingual[] = [
  { en: 'A treehouse', es: 'Una casa en el árbol' },
  { en: 'A castle', es: 'Un castillo' },
  { en: 'A sailing ship', es: 'Un velero' },
  { en: 'A giant statue', es: 'Una estatua gigante' },
  { en: 'A pizza restaurant', es: 'Una pizzería' },
  { en: 'A spaceship', es: 'Una nave espacial' },
  { en: 'A haunted house', es: 'Una casa encantada' },
  { en: 'A tiny village', es: 'Un pueblito' },
  { en: 'A robot', es: 'Un robot' },
  { en: 'A volcano lair', es: 'Una guarida en un volcán' },
]

/** the colour of a side or a role in a mode, for names, bars and the HUD */
export function sideColor(mode: RoundModeId, team: string): string | null {
  return MODE_DEFS[mode].sides.find((s) => s.team === team)?.color ?? null
}

/** what to call a participant's side ("Red", "Hunters"...) */
export function sideName(mode: RoundModeId, team: string, lang: Lang): string {
  const s = MODE_DEFS[mode].sides.find((x) => x.team === team)
  return s ? s.name[lang] : ''
}

export function roleDef(mode: RoundModeId, role: string): RoleDef | null {
  return MODE_DEFS[mode].roles.find((r) => r.role === role) ?? null
}

/** m:ss for a countdown or a finish time */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** a race time to the tenth: 1:23.4 */
export function raceTime(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100)) / 10
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export interface AnnounceCtx {
  nameOf: (id: number) => string
  you: number
  lang: Lang
}

/** the words for an announcement code, or null to say nothing */
export function announce(code: string, d: Record<string, unknown>, c: AnnounceCtx): string | null {
  const l = c.lang
  const who = (id: unknown) => (id === c.you ? (l === 'es' ? 'tú' : 'you') : c.nameOf(Number(id)))
  const pick = (en: string, es: string) => (l === 'es' ? es : en)
  switch (code) {
    case 'countdown':
      return pick('Round starting: heading to the map', 'La ronda empieza: rumbo al mapa')
    case 'start':
      return pick('Go!', '¡Ya!')
    case 'results':
      return null
    case 'aborted':
      return pick('The round was stopped', 'Se detuvo la ronda')
    case 'caught':
      return pick(`${who(d.by)} caught ${who(d.id)}`, `${who(d.by)} atrapó a ${who(d.id)}`)
    case 'found':
      return pick(`${who(d.id)} was found`, `${who(d.id)} fue encontrado`)
    case 'finish':
      return pick(`${who(d.id)} finished in ${raceTime(Number(d.ms) || 0)}`, `${who(d.id)} terminó en ${raceTime(Number(d.ms) || 0)}`)
    case 'turn':
      return pick(`${who(d.id)} is up`, `Le toca a ${who(d.id)}`)
    case 'slow':
      return pick('That ring did not count: too fast to be true', 'Ese aro no cuenta: demasiado rápido para ser cierto')
    case 'gallery':
      return pick(`Gallery: ${who(d.plot)}'s plot`, `Galería: la parcela de ${who(d.plot)}`)
    case 'voted':
      return pick(`You gave ${String(d.n)}`, `Diste ${String(d.n)}`)
    default:
      return null
  }
}

/** the words for a refusal reason */
export function refusal(cmd: string, reason: string, need: number | undefined, lang: Lang): string {
  const es = lang === 'es'
  if (reason === 'host') return es ? 'Solo el anfitrión puede hacer eso' : 'Only the host can do that'
  if (reason === 'few') return es ? `Faltan jugadores: hacen falta ${need ?? 2}` : `Not enough players: ${need ?? 2} needed`
  if (reason === 'busy') return es ? 'Ahora no: hay una ronda en marcha' : 'Not now: a round is on'
  if (reason === 'admin') return es ? 'Solo un administrador, o el anfitrión de una sala privada' : 'Admins only, or the host of a private room'
  if (reason === 'closed') return es ? 'No se puede entrar a esta ronda' : 'This round cannot be joined'
  if (reason === 'full') return es ? 'La ronda está llena' : 'The round is full'
  if (reason === 'noprops') return es ? 'No hay objetos aquí' : 'No props here'
  return es ? `No se pudo (${cmd})` : `Could not do that (${cmd})`
}
