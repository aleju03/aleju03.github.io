/*
  The tool gun's words: its modes, what each click does in them, and the
  two readouts (the hint tape's line and the gun's own little screen), in
  both languages.

  Kept apart from toolgun.ts, and importing nothing, because the scene reads
  these every frame and the scene is the eager chunk: toolgun.ts pulls in the
  contraptions, the kinds and the catalogue, which are the sandbox's lazily
  loaded half and must stay there.
*/

type Msg = { en: string; es: string }

export type ToolMode = 'weld' | 'axis' | 'rope' | 'nocollide' | 'keys' | 'remove'
export const TOOL_MODES: readonly ToolMode[] = ['weld', 'axis', 'rope', 'nocollide', 'keys', 'remove']


export const MODE_NAMES: Record<ToolMode, Msg> = {
  weld: { en: 'weld', es: 'soldar' },
  axis: { en: 'axis', es: 'eje' },
  rope: { en: 'rope', es: 'cuerda' },
  nocollide: { en: 'no-collide', es: 'sin choque' },
  keys: { en: 'keys', es: 'teclas' },
  remove: { en: 'remove', es: 'quitar' },
}

/** what the hint tape says the clicks do, by mode and step (0: nothing
    picked yet, 1: the first prop is picked) */
const STEPS: Record<ToolMode, [Msg, Msg]> = {
  weld: [
    { en: 'lmb a part or prop · rmb unweld it', es: 'clic izq una pieza u objeto · clic der desoldarlo' },
    { en: 'lmb what to weld it to · rmb cancel', es: 'clic izq a qué soldarlo · clic der cancela' },
  ],
  axis: [
    { en: 'lmb a wheel · rmb take its axle off', es: 'clic izq una rueda · clic der quita su eje' },
    { en: 'lmb the face to hinge it on · rmb cancel', es: 'clic izq la cara donde va · clic der cancela' },
  ],
  rope: [
    { en: 'lmb where the rope starts · rmb cut its ropes', es: 'clic izq donde empieza · clic der corta sus cuerdas' },
    { en: 'lmb where it ends · rmb cancel', es: 'clic izq donde termina · clic der cancela' },
  ],
  nocollide: [
    { en: 'lmb a prop · rmb let it collide again', es: 'clic izq un objeto · clic der que choque otra vez' },
    { en: 'lmb the other one · rmb cancel', es: 'clic izq el otro · clic der cancela' },
  ],
  keys: [
    { en: 'lmb a part: next keys · rmb reverse it', es: 'clic izq una pieza: otras teclas · clic der invertirla' },
    { en: '', es: '' },
  ],
  remove: [
    { en: 'lmb remove a prop · rmb strip its joints', es: 'clic izq quita un objeto · clic der quita sus uniones' },
    { en: '', es: '' },
  ],
}

/** the hint line for a `state`, in either language */
export const toolgunLine = (state: string, lang: 'en' | 'es', keysLabel?: string | null): string => {
  const [m, s] = state.split(':') as [ToolMode, string]
  const name = MODE_NAMES[m]
  if (!name) return ''
  const step = STEPS[m][s === '1' ? 1 : 0][lang]
  const tag = lang === 'es' ? 'pistola' : 'tool gun'
  const next = lang === 'es' ? 'r modo' : 'r mode'
  const on = m === 'keys' && keysLabel ? ` (${keysLabel})` : ''
  return `${tag}: ${name[lang]}${on} · ${step} · ${next}`
}

/** the screen on the gun: the mode's name and the step, short */
export const toolgunScreen = (state: string, lang: 'en' | 'es', keysLabel?: string | null): [string, string] => {
  const [m, s] = state.split(':') as [ToolMode, string]
  const name = MODE_NAMES[m]?.[lang] ?? ''
  const two = m !== 'keys' && m !== 'remove'
  const sub = m === 'keys' ? (keysLabel ?? '') : two ? (s === '1' ? 'B' : 'A') : ''
  return [name.toUpperCase(), sub.toUpperCase()]
}

