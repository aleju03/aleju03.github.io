/*
  The tool gun's words: its modes, what each click does in them, and the
  two readouts (the hint tape's line and the gun's own little screen), in
  both languages.

  Kept apart from toolgun.ts, and importing only the paint palette (creative/
  tags.ts, which imports nothing itself), because the scene reads
  these every frame and the scene is the eager chunk: toolgun.ts pulls in the
  contraptions, the kinds and the catalogue, which are the sandbox's lazily
  loaded half and must stay there.
*/

import { PALETTE } from '../creative/tags'

type Msg = { en: string; es: string }

export type ToolMode = 'weld' | 'axis' | 'rope' | 'nocollide' | 'keys' | 'paint' | 'balloon' | 'remove' | 'copy' | 'paste'
export const TOOL_MODES: readonly ToolMode[] = ['weld', 'axis', 'rope', 'nocollide', 'keys', 'paint', 'balloon', 'remove', 'copy', 'paste']


export const MODE_NAMES: Record<ToolMode, Msg> = {
  weld: { en: 'weld', es: 'soldar' },
  axis: { en: 'axis', es: 'eje' },
  rope: { en: 'rope', es: 'cuerda' },
  nocollide: { en: 'no-collide', es: 'sin choque' },
  keys: { en: 'keys', es: 'teclas' },
  paint: { en: 'paint', es: 'pintar' },
  balloon: { en: 'balloon', es: 'globo' },
  remove: { en: 'remove', es: 'quitar' },
  copy: { en: 'copy', es: 'copiar' },
  paste: { en: 'paste', es: 'pegar' },
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
  paint: [
    { en: 'lmb paint it · rmb clear the paint · wheel colour', es: 'clic izq pintar · clic der quitar la pintura · rueda color' },
    { en: '', es: '' },
  ],
  balloon: [
    { en: 'lmb tie a balloon on a prop · lmb a balloon to pick it · rmb cut its rope', es: 'clic izq atar un globo · clic izq a un globo para tomarlo · clic der cortar su cuerda' },
    { en: 'lmb what to tie it to · rmb cancel', es: 'clic izq a qué atarlo · clic der cancela' },
  ],
  remove: [
    { en: 'lmb remove a prop · rmb strip its joints', es: 'clic izq quita un objeto · clic der quita sus uniones' },
    { en: '', es: '' },
  ],
  copy: [
    { en: 'lmb copy a prop and all it is joined to · rmb copy just it', es: 'clic izq copia un objeto y todo lo unido · clic der solo él' },
    { en: '', es: '' },
  ],
  paste: [
    { en: 'copy something first (r to the copy mode)', es: 'copia algo primero (r al modo copiar)' },
    { en: 'lmb place it · wheel or e turn it · rmb forget it', es: 'clic izq lo coloca · rueda o e lo gira · clic der lo olvida' },
  ],
}

/** a palette colour's name from the state's third field */
const colorName = (c: string | undefined, lang: 'en' | 'es') => PALETTE[Number(c) | 0]?.name[lang] ?? ''

/** the swatch on the gun's screen for a state: the colour's hex in paint
    and balloon modes, else none */
export const toolgunSwatch = (state: string): string | null => {
  const [m, , c] = state.split(':')
  return (m === 'paint' || m === 'balloon') && PALETTE[Number(c) | 0] ? PALETTE[Number(c) | 0].hex : null
}

/** the hint line for a `state`, in either language */
export const toolgunLine = (state: string, lang: 'en' | 'es', keysLabel?: string | null): string => {
  const [m, s, c] = state.split(':') as [ToolMode, string, string | undefined]
  const name = MODE_NAMES[m]
  if (!name) return ''
  const step = STEPS[m][s === '1' ? 1 : 0][lang]
  const tag = lang === 'es' ? 'pistola' : 'tool gun'
  const next = lang === 'es' ? 'r modo' : 'r mode'
  const on = (m === 'keys' || m === 'paste') && keysLabel ? ` (${keysLabel})` : m === 'paint' || m === 'balloon' ? ` (${colorName(c, lang)})` : ''
  return `${tag}: ${name[lang]}${on} · ${step} · ${next}`
}

/** the screen on the gun: the mode's name and the step, short */
export const toolgunScreen = (state: string, lang: 'en' | 'es', keysLabel?: string | null): [string, string] => {
  const [m, s, c] = state.split(':') as [ToolMode, string, string | undefined]
  const name = MODE_NAMES[m]?.[lang] ?? ''
  const two = m !== 'keys' && m !== 'remove' && m !== 'copy' && m !== 'paste' && m !== 'paint' && m !== 'balloon'
  const sub = m === 'keys' || m === 'paste' ? (keysLabel ?? '') : m === 'paint' ? colorName(c, lang) : m === 'balloon' ? (s === '1' ? 'B' : colorName(c, lang)) : two ? (s === '1' ? 'B' : 'A') : ''
  return [name.toUpperCase(), sub.toUpperCase()]
}

