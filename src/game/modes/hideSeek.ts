import type { ModeClient, ModeCtx } from './types'

/*
  Hide and seek, the client's half. The server picks the seekers, gates their
  movement during the hiding time (and walks a seeker back if this client
  ignores the freeze), and rules every tag; this module makes the client
  behave and offers the punch.

  Seekers stand frozen and blind while the others scatter: `frozen` holds the
  walker, `blind` tells the HUD to cover the screen so a seeker cannot peek at
  where people run. When the seeking begins a seeker can shoot the pistol (the
  server takes a hit as a tag, no hit points) or press F, the same key that
  points, at a hider within arm's length: the server checks that distance
  again against where it has watched both of them.

  Hiders are unarmed, so every tool is put away for them.
*/

const PUNCH_REACH = 3.6

export function createHideSeek(c: ModeCtx): ModeClient {
  const role = () => c.store.mine?.role ?? ''
  const hiding = () => c.store.phase === 'playing' && performance.now() < c.store.localAt(c.store.num('seekAt'))
  const punch = () => {
    const me = c.host.here()
    let best = 0
    let bestD = PUNCH_REACH
    for (const o of c.host.others()) {
      if (c.store.partOf(o.id)?.role !== 'hider') continue
      const d = Math.hypot(o.x - me.x, o.z - me.z)
      if (d < bestD && Math.abs(o.y - me.y) < 4) {
        bestD = d
        best = o.id
      }
    }
    if (best) c.host.send({ type: 'world-round-cmd', cmd: 'tag', target: best })
  }
  return {
    frozen: () => c.store.phase === 'countdown' || (role() === 'seeker' && hiding()),
    blind: () => role() === 'seeker' && hiding(),
    locked: () => role() === 'hider',
    tick(input) {
      if (role() === 'seeker' && !hiding() && c.store.phase === 'playing' && input.pressed('point')) punch()
    },
    objective: () =>
      role() === 'seeker'
        ? hiding()
          ? { en: 'Counting. Do not peek.', es: 'Contando. No mires.' }
          : { en: 'Find them: pistol, or F up close', es: 'Encuéntralos: pistola, o F de cerca' }
        : role() === 'hider'
          ? { en: 'Hide. Do not get caught.', es: 'Escóndete. Que no te atrapen.' }
          : null,
  }
}
