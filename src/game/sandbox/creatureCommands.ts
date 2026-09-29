import { SPAWNABLE } from '../creatures/kinds'
import { msg, registerCommand, type CommandCtx } from './commands'

/*
  The console's verbs for the living: `/mobs on|off|clear|peaceful|hostile|count`
  and `/spawnmob KIND`. Like the other shared-world verbs they reach the
  scene through a host interface (`host.creatures`) and register themselves on
  import, so the console module itself did not grow.

  **`/mobs` is per scope** (a level of a room) and belongs to the first player
  there or an admin. Online it is one message to the server, which is the only
  thing that decides (creatures.js: the host or an admin; anybody else is told
  "not allowed"); offline, where the walker is alone, it is simply theirs.
  `peaceful` sends every hostile away and stops any more coming; `hostile`
  puts things back as they were. `/spawnmob` is for testing and for fun: one
  creature ten units ahead, bounded by the same caps as everything else, and
  a hostile one is refused while it is peaceful.
*/

/** what the scene lends the console for the creatures */
export interface CreatureHost {
  command: (op: 'on' | 'off' | 'clear' | 'peaceful' | 'hostile') => void
  /** one creature of this kind ahead of the walker */
  spawn: (kind: string) => 'ok' | 'unknown' | 'refused' | 'asked'
  count: () => { alive: number; passive: number; hostile: number; arrows: number; host: boolean; on: boolean; peaceful: boolean }
}

const need = (ctx: CommandCtx) => {
  const c = ctx.host.creatures
  if (!c) ctx.fail(msg('nothing lives here', 'aquí no vive nada'))
  return c!
}

registerCommand({
  name: 'mobs',
  args: [{ name: 'state', nameEs: 'estado', type: 'choice', choices: ['on', 'off', 'clear', 'peaceful', 'hostile', 'count'] }],
  help: msg(
    'the living things here: on/off, clear them, peaceful (no hostiles) or hostile again, count them; the first player or an admin',
    'los seres vivos de aquí: on/off, quitarlos, peaceful (sin hostiles) o hostile de nuevo, contarlos; el primer jugador o un administrador',
  ),
  run: (ctx) => {
    const c = need(ctx)
    const op = ctx.args[0].toLowerCase()
    if (op === 'count') {
      const n = c.count()
      ctx.out(msg(
        `${n.alive} alive (${n.passive} calm, ${n.hostile} hostile${n.arrows ? `, ${n.arrows} arrows` : ''}); ${n.on ? 'on' : 'off'}${n.peaceful ? ', peaceful' : ''}; ${n.host ? 'simulated here' : 'simulated by the host'}`,
        `${n.alive} vivos (${n.passive} mansos, ${n.hostile} hostiles${n.arrows ? `, ${n.arrows} flechas` : ''}); ${n.on ? 'activado' : 'desactivado'}${n.peaceful ? ', pacífico' : ''}; ${n.host ? 'simulado aquí' : 'simulado por el anfitrión'}`,
      ))
      return
    }
    if (op !== 'on' && op !== 'off' && op !== 'clear' && op !== 'peaceful' && op !== 'hostile') {
      ctx.fail(msg('on, off, clear, peaceful, hostile or count', 'on, off, clear, peaceful, hostile o count'))
      return
    }
    c.command(op)
    ctx.out(ctx.host.online?.() ? msg('asked', 'pedido') : msg('done', 'hecho'))
  },
})

registerCommand({
  name: 'spawnmob',
  args: [{ name: 'kind', nameEs: 'clase', type: 'choice', choices: SPAWNABLE }],
  help: msg(
    'a creature ten units ahead (pig, cow, sheep, chicken, zombie, creeper, skeleton, walker)',
    'una criatura diez unidades adelante (pig, cow, sheep, chicken, zombie, creeper, skeleton, walker)',
  ),
  run: (ctx) => {
    const c = need(ctx)
    const kind = ctx.args[0].toLowerCase()
    switch (c.spawn(kind)) {
      case 'ok':
        ctx.ok(msg(`a ${kind}`, `un ${kind}`))
        return
      case 'asked':
        ctx.out(msg('asked', 'pedido'))
        return
      case 'unknown':
        ctx.fail(msg(`no such creature: ${SPAWNABLE.join(', ')}`, `no existe: ${SPAWNABLE.join(', ')}`))
        return
      default:
        ctx.fail(msg('not now: too many about, or peaceful, or no room', 'ahora no: hay demasiados, o es pacífico, o no hay sitio'))
    }
  },
})
