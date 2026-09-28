import type { ModeClient, ModeCtx } from './types'

/*
  Prop hunt, the client's half. The server spawns the sixty decoys, deals the
  roles, holds the hunters for the hiding time, accepts a disguise (`cmd
  disguise`) and applies every rule of damage; this module is the prop's key
  and the hunter's blindfold.

  A prop looks at any shared prop in the level and presses Y: that kind is
  what everyone else now sees in place of the body (director.ts draws it as a
  proxy in the sandbox's own batch, so it costs no new program) and what
  shots must hit (the hitbox is the kind's shape). Y with nothing under the
  crosshair puts the body back. Props carry nothing, so every tool is put away
  for them; hunters are blind and still until the hiding is over.
*/

export function createPropHunt(c: ModeCtx): ModeClient {
  const role = () => c.store.mine?.role ?? ''
  const hiding = () => c.store.phase === 'playing' && performance.now() < c.store.localAt(c.store.num('seekAt'))
  return {
    frozen: () => c.store.phase === 'countdown' || (role() === 'hunter' && hiding()),
    blind: () => role() === 'hunter' && hiding(),
    locked: () => role() === 'prop',
    tick(input) {
      if (role() !== 'prop' || c.store.mine?.out || !input.pressed('disguise')) return
      const seen = c.host.aimedProp()
      if (seen) c.host.send({ type: 'world-round-cmd', cmd: 'disguise', kind: seen.kind })
      else if (c.store.disguises.has(c.store.you)) c.host.send({ type: 'world-round-cmd', cmd: 'disguise', kind: '' })
    },
    objective: () => {
      if (c.store.mine?.out) return { en: 'You are out. Watch the rest.', es: 'Estás fuera. Mira a los demás.' }
      if (role() === 'prop') {
        return c.store.disguises.has(c.store.you)
          ? { en: 'Stay still. Y to change, or look away and Y to drop it.', es: 'Quédate quieto. Y para cambiar, o mira a otro lado y Y para dejarlo.' }
          : { en: 'Look at a thing and press Y', es: 'Mira algo y pulsa Y' }
      }
      if (role() === 'hunter') {
        return hiding()
          ? { en: 'Wait. They are hiding.', es: 'Espera. Se están escondiendo.' }
          : { en: 'Shoot what does not belong. Wrong shots cost 5 hp.', es: 'Dispara a lo que sobra. Cada error cuesta 5 de vida.' }
      }
      return null
    },
  }
}
