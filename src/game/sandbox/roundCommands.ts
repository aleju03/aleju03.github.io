import { MODE_DEFS } from '../modes/defs'
import { ROUND_MODES, type RoundModeId } from '../net/roundProtocol'
import { msg, registerCommand, type CommandCtx } from './commands'

/*
  The console's word for the rounds: `round` (alias `r`) with a verb. It is the
  keyboard's way of everything the play page does, and the only way to the
  server's solo-test flag from a harness:

    round                 what is on, who is ready
    round mode <game>     pick a game (host)
    round ready [off]     press ready
    round start           start it (host)
    round stop            end the round (host)
    round debug [off]     let one player start any game (admin, or host of a private room)
    round join            join a deathmatch in progress

  Every verb goes through `host.rounds`, which the scene answers with the
  round store and the socket; the server decides, and a refusal comes back as
  a line in the chat rail. Offline there is nothing to ask.
*/

const need = (ctx: CommandCtx) => {
  const r = ctx.host.rounds
  if (!r) ctx.fail(msg('not here', 'aquí no'))
  return r!
}

registerCommand({
  name: 'round',
  aliases: ['r'],
  args: [
    { name: 'verb', nameEs: 'verbo', type: 'choice', choices: ['status', 'mode', 'ready', 'start', 'stop', 'debug', 'join'], optional: true },
    { name: 'what', nameEs: 'qué', type: 'word', optional: true, choices: () => [...ROUND_MODES, 'off', 'on'] },
  ],
  help: msg(
    'rounds: round mode <game>, ready, start, stop, debug, join; alone it says what is on',
    'rondas: round mode <juego>, ready, start, stop, debug, join; solo, dice qué hay',
  ),
  run: (ctx) => {
    const r = need(ctx)
    const st = r.state()
    const verb = (ctx.args[0] ?? 'status').toLowerCase()
    const what = (ctx.args[1] ?? '').toLowerCase()
    const cmd = (m: Parameters<typeof r.send>[0]) => {
      if (!r.send(m)) ctx.fail(msg('rounds need the shared world', 'las rondas necesitan el mundo compartido'))
    }
    switch (verb) {
      case 'status': {
        const d = MODE_DEFS[st.mode]
        ctx.out(msg(
          `${d.name.en} on ${st.level}: ${st.phase}, ${st.ready.size} ready, ${st.parts.length} playing${st.debug ? ', solo test on' : ''}`,
          `${d.name.es} en ${st.level}: ${st.phase}, ${st.ready.size} listos, ${st.parts.length} jugando${st.debug ? ', prueba en solitario' : ''}`,
        ))
        ctx.out(msg(`games: ${ROUND_MODES.join(', ')}`, `juegos: ${ROUND_MODES.join(', ')}`))
        return
      }
      case 'mode': {
        if (!(ROUND_MODES as readonly string[]).includes(what)) ctx.fail(msg(`one of: ${ROUND_MODES.join(', ')}`, `uno de: ${ROUND_MODES.join(', ')}`))
        cmd({ type: 'world-round-cmd', cmd: 'mode', mode: what as RoundModeId })
        return
      }
      case 'ready':
        cmd({ type: 'world-round-cmd', cmd: 'ready', on: what !== 'off' })
        return
      case 'start':
        cmd({ type: 'world-round-cmd', cmd: 'start' })
        return
      case 'stop':
        cmd({ type: 'world-round-cmd', cmd: 'stop' })
        return
      case 'debug':
        cmd({ type: 'world-round-cmd', cmd: 'debug', on: what !== 'off' })
        return
      case 'join':
        cmd({ type: 'world-round-cmd', cmd: 'join' })
        return
    }
    ctx.fail(msg('round [status|mode|ready|start|stop|debug|join]', 'round [status|mode|ready|start|stop|debug|join]'))
  },
})
