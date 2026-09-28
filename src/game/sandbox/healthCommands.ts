import { msg, registerCommand, type CommandCtx } from './commands'

/*
  The console's verbs for hit points: `health`, `hurt n`, `heal`, `pvp
  on|off`, a `kill` that is a real knock-out when a server is keeping the
  numbers, and `god` with its help brought up to date. They live beside the
  other commands' module rather than in it so the health work stays one
  addition; registering a name a second time replaces the first, which is
  how `kill` and `god` are taken over here (offline, `kill` falls back to
  the old fall-in-a-heap it always was).

  Every verb goes through `host.health`, which the scene answers by asking
  the server (server/src/health.js), the only place a hit point exists.
  Offline there is nothing to ask, and the commands say so plainly instead
  of pretending. `heal` and `god` are refused by the server while pvp is on,
  because a fight where either is a keystroke away is not a fight; the
  scene prints that refusal when it arrives.
*/

const need = (ctx: CommandCtx) => {
  const h = ctx.host.health
  if (!h) ctx.fail(msg('not here', 'aquí no'))
  return h!
}
const online = (ctx: CommandCtx) => {
  const h = need(ctx)
  if (!h.read().online) {
    ctx.fail(msg('hit points live on the server: join the shared world first', 'la vida vive en el servidor: entra primero al mundo compartido'))
  }
  return h
}

registerCommand({
  name: 'health',
  aliases: ['hp'],
  help: msg('your hit points, and whether pvp is on', 'tus puntos de vida, y si el pvp está activo'),
  run: (ctx) => {
    const s = need(ctx).read()
    if (!s.online) {
      ctx.out(msg('offline: nothing here can hurt you', 'sin conexión: nada aquí te puede herir'))
      return
    }
    ctx.out(msg(
      `${Math.ceil(s.hp)}/${s.max} hp${s.dead ? ' (down)' : ''}, pvp ${s.pvp ? 'on' : 'off'}`,
      `${Math.ceil(s.hp)}/${s.max} de vida${s.dead ? ' (caído)' : ''}, pvp ${s.pvp ? 'activado' : 'desactivado'}`,
    ))
  },
})

registerCommand({
  name: 'hurt',
  args: [{ name: 'n', type: 'number', optional: true }],
  help: msg('hurt yourself (default 20); works whether pvp is on or not', 'hazte daño (20 por defecto); funciona con o sin pvp'),
  run: (ctx) => {
    const n = ctx.args[0] ? Number(ctx.args[0]) : 20
    if (!(n > 0)) ctx.fail(msg('a positive number', 'un número positivo'))
    online(ctx).hurt(Math.min(500, n))
  },
})

registerCommand({
  name: 'heal',
  help: msg('back to full hit points (not while pvp is on)', 'vida completa (no mientras el pvp está activo)'),
  run: (ctx) => {
    online(ctx).heal()
    ctx.ok(msg('healed', 'curado'))
  },
})

registerCommand({
  name: 'pvp',
  args: [{ name: 'on|off', nameEs: 'on|off', type: 'choice', choices: ['on', 'off'] }],
  help: msg(
    'let players hurt each other here (on), or only knock each other about (off); it tells everyone',
    'que los jugadores se hieran entre sí aquí (on), o solo se empujen (off); avisa a todos',
  ),
  run: (ctx) => {
    online(ctx).pvp(ctx.args[0].toLowerCase() === 'on')
  },
})

registerCommand({
  name: 'kill',
  aliases: ['suicide'],
  help: msg('knock yourself out (online), or fall over in a heap (offline)', 'quedas fuera de combate (en línea), o caes hecho un bulto (sin conexión)'),
  run: (ctx) => {
    const h = ctx.host.health
    if (h?.read().online) {
      h.kill()
      return
    }
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
  name: 'god',
  aliases: ['buddha'],
  help: msg('nothing can knock you over or hurt you (not while pvp is on)', 'nada te puede tumbar ni herir (no mientras el pvp está activo)'),
  run: (ctx) => {
    const f = ctx.host.god
    if (!f) ctx.fail(msg('not here', 'aquí no'))
    const on = f!(!f!())
    ctx.ok(on ? msg('god mode on', 'modo dios activado') : msg('god mode off', 'modo dios desactivado'))
  },
})
