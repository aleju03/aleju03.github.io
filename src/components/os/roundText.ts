import { useI18n } from '../../i18n'
import type { Bilingual } from '../../game/modes/defs'

/*
  Every word the round screens print that is not a mode's own text (those are
  in game/modes/defs.ts): the play page, the strip on the map sheet, the HUD,
  the scoreboard and the results sheet. One table, each entry `{ en, es }`, and
  a hook that reads the site's language, so a string cannot be added in one
  language only (the type has no way to). It lives beside the components
  rather than inside i18n.tsx so the rounds are one addition, not a scatter of
  edits across a file every branch touches.
*/

const T = {
  play: { en: 'Play', es: 'Jugar' },
  rounds: { en: 'Rounds', es: 'Rondas' },
  offline: { en: 'Rounds need the shared world. Join it (and a room with friends) first.', es: 'Las rondas necesitan el mundo compartido. Entra primero (y a una sala con amigos).' },
  inRoom: { en: '{n} in this room', es: '{n} en esta sala' },
  hostNote: { en: '{name} is the host', es: '{name} es el anfitrión' },
  youHost: { en: 'You are the host', es: 'Eres el anfitrión' },
  pickMode: { en: 'Pick a game', es: 'Elige un juego' },
  minPlayers: { en: '{n}+ players', es: '{n}+ jugadores' },
  maxPlayers: { en: 'up to {n}', es: 'hasta {n}' },
  map: { en: 'Map', es: 'Mapa' },
  ready: { en: 'Ready', es: 'Listo' },
  notReady: { en: 'Not ready', es: 'No listo' },
  readyCount: { en: '{a} of {b} ready', es: '{a} de {b} listos' },
  start: { en: 'Start', es: 'Empezar' },
  stop: { en: 'Stop round', es: 'Parar ronda' },
  join: { en: 'Join in progress', es: 'Unirse ahora' },
  spectate: { en: 'Watching', es: 'Mirando' },
  debug: { en: 'Solo test', es: 'Prueba en solitario' },
  debugHint: { en: 'lets one player start any game (admins, or the host of a private room)', es: 'deja que un solo jugador empiece cualquier juego (administradores, o el anfitrión de una sala privada)' },
  hostOnly: { en: 'The host picks the game', es: 'El anfitrión elige el juego' },
  allReady: { en: 'When everyone is ready it starts by itself', es: 'Cuando todos están listos empieza sola' },
  roundOn: { en: 'A round is on', es: 'Hay una ronda en marcha' },
  yourPlace: { en: 'You are in it', es: 'Estás dentro' },
  notInIt: { en: 'You are watching', es: 'Estás mirando' },
  waiting: { en: 'Waiting for everyone to arrive on the map…', es: 'Esperando a que todos lleguen al mapa…' },
  getReady: { en: 'Get ready', es: 'Prepárate' },
  go: { en: 'GO', es: 'YA' },
  time: { en: 'Time', es: 'Tiempo' },
  youAre: { en: 'You are', es: 'Eres' },
  scoreboard: { en: 'Scoreboard', es: 'Marcador' },
  player: { en: 'Player', es: 'Jugador' },
  score: { en: 'Score', es: 'Puntos' },
  kills: { en: 'Kills', es: 'Bajas' },
  deaths: { en: 'Deaths', es: 'Muertes' },
  tags: { en: 'Tags', es: 'Capturas' },
  survived: { en: 'Survived', es: 'Aguantó' },
  found: { en: 'Found', es: 'Hallados' },
  time2: { en: 'Time', es: 'Tiempo' },
  rings: { en: 'Rings', es: 'Aros' },
  marks: { en: 'Marks', es: 'Votos' },
  tally: { en: 'Total', es: 'Suma' },
  dnf: { en: 'did not finish', es: 'no terminó' },
  results: { en: 'Results', es: 'Resultados' },
  winner: { en: 'Winner', es: 'Ganador' },
  winners: { en: 'Winners', es: 'Ganadores' },
  draw: { en: 'A draw', es: 'Empate' },
  nobody: { en: 'Nobody won', es: 'Nadie ganó' },
  youWon: { en: 'You won', es: 'Ganaste' },
  youLost: { en: 'Better luck next time', es: 'Suerte la próxima' },
  backSoon: { en: 'Back to the lobby in a moment', es: 'Volvemos a la sala en un momento' },
  why_limit: { en: 'The kill limit was reached', es: 'Se alcanzó el límite de bajas' },
  why_time: { en: 'Time ran out', es: 'Se acabó el tiempo' },
  why_last: { en: 'Nobody was left to play', es: 'No quedó nadie contra quien jugar' },
  why_hunted: { en: 'Every prop was found', es: 'Encontraron todos los objetos' },
  why_survived: { en: 'The props survived', es: 'Los objetos sobrevivieron' },
  why_done: { en: 'Everyone has had their go', es: 'Todos tuvieron su turno' },
  why_abandoned: { en: 'Too few players were left', es: 'Quedaron muy pocos jugadores' },
  why_stopped: { en: 'The host stopped the round', es: 'El anfitrión paró la ronda' },
  why_last_hider: { en: 'The last one found wins', es: 'Gana el último en ser encontrado' },
  blindTitle: { en: 'Eyes shut', es: 'Ojos cerrados' },
  blindText: { en: 'The others are hiding. Back in a moment.', es: 'Los demás se esconden. Ya vuelves.' },
  hideTimer: { en: 'Hiding time', es: 'Tiempo para esconderse' },
  seekTimer: { en: 'Seeking', es: 'Buscando' },
  propsLeft: { en: 'Props left', es: 'Objetos vivos' },
  hidersLeft: { en: 'Hiders left', es: 'Escondidos' },
  theme: { en: 'Theme', es: 'Tema' },
  building: { en: 'Building', es: 'Construyendo' },
  gallery: { en: 'Gallery', es: 'Galería' },
  plotOf: { en: "{name}'s plot", es: 'Parcela de {name}' },
  yourTurn: { en: 'Your turn', es: 'Tu turno' },
  turnOf: { en: "{name}'s turn", es: 'Turno de {name}' },
  laps: { en: 'laps', es: 'vueltas' },
  eliminated: { en: 'Out', es: 'Fuera' },
  hold: { en: 'hold Tab', es: 'mantén Tab' },
  teamRed: { en: 'Red', es: 'Rojo' },
  chooseLevel: { en: 'On', es: 'En' },
  optOn: { en: 'on', es: 'sí' },
  optOff: { en: 'off', es: 'no' },
  pressStart: { en: 'Press Start when you are ready', es: 'Pulsa Empezar cuando quieras' },
} satisfies Record<string, Bilingual>

export type RoundKey = keyof typeof T

export function useRoundText() {
  const { language } = useI18n()
  const lang: 'en' | 'es' = language === 'es' ? 'es' : 'en'
  const tr = (k: RoundKey, vars?: Record<string, string | number>) => {
    let s: string = T[k][lang]
    if (vars) for (const [key, v] of Object.entries(vars)) s = s.replace(`{${key}}`, String(v))
    return s
  }
  return { tr, lang }
}
