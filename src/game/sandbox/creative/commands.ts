import { msg, registerCommand, type CommandCtx } from '../commands'
import type { Prop, Sandbox } from '../sandbox'
import { creativeOf } from './creative'
import { PALETTE, SIGN_MAX, cleanSign } from './tags'

/*
  The console's words for the creative props.

  `/sign <text>` is how a sign gets its words: E on a sign opens the console
  with `/sign ` and the sign's current text already typed, so the line is the
  editor and enter is the save. It writes the sign E last picked, else the one
  under the crosshair. `/paint <colour>` paints what the crosshair is on, the
  same as the tool gun's paint mode with the colour typed rather than chosen
  on the wheel. Both are one undo entry.
*/

const NAMES = ['none', ...PALETTE.flatMap((c) => [c.name.en, c.name.es])]

/** the prop the crosshair is on, or the sign E last picked */
const aimed = (ctx: CommandCtx, sb: Sandbox, prefer?: number | null): Prop | null => {
  if (prefer != null) {
    const p = sb.get(prefer)
    if (p) return p
  }
  const a = ctx.host.aim?.()
  if (!a) return null
  return sb.raycast(a.origin, a.dir, 16, { props: true, world: false })?.prop ?? null
}

registerCommand({
  name: 'sign',
  args: [{ name: 'text', nameEs: 'texto', type: 'text', optional: true }],
  help: msg(
    `write on the sign you are looking at (up to ${SIGN_MAX} characters). with no text, wipe it`,
    `escribe en el letrero que miras (hasta ${SIGN_MAX} caracteres). sin texto, lo borra`,
  ),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const cr = creativeOf(sb)
    const p = aimed(ctx, sb, cr.signTarget)
    if (!p || p.kind.id !== 'sign') ctx.fail(msg('no sign in front of you', 'no hay ningún letrero frente a ti'))
    const raw = ctx.args[0] ?? ''
    const text = cleanSign(raw)
    if (raw.length > 0 && !text) ctx.fail(msg('none of those characters fit on a sign', 'ninguno de esos caracteres cabe en un letrero'))
    const before = cr.rawTag(p!.id)
    const done = cr.write(p!.id, text)
    if (done === null) return
    ctx.host.history()?.record({
      label: msg('sign', 'letrero'),
      undo: () => cr.restore(p!.id, before),
    })
    cr.signTarget = null
    if (raw.length > SIGN_MAX) ctx.out(msg(`cut to ${SIGN_MAX} characters`, `cortado a ${SIGN_MAX} caracteres`))
    ctx.ok(done ? msg(`"${done}"`, `"${done}"`) : msg('wiped', 'borrado'))
  },
})

registerCommand({
  name: 'paint',
  args: [{ name: 'colour', nameEs: 'color', type: 'choice', choices: NAMES }],
  help: msg(
    'paint the prop you are looking at. none takes the paint off',
    'pinta el objeto que miras. none le quita la pintura',
  ),
  run: (ctx) => {
    const sb = ctx.needSandbox()
    const p = aimed(ctx, sb)
    if (!p) ctx.fail(msg('nothing in front of you to paint', 'no hay nada frente a ti para pintar'))
    const word = ctx.args[0].toLowerCase()
    const idx = word === 'none' ? 0 : PALETTE.findIndex((c) => c.name.en === word || c.name.es === word) + 1
    const cr = creativeOf(sb)
    const before = cr.paint(p!.id, idx)
    if (before === false) return
    ctx.host.history()?.record({ label: msg('paint', 'pintura'), undo: () => cr.restore(p!.id, before) })
    ctx.ok(idx ? msg(`painted ${PALETTE[idx - 1].name.en}`, `pintado de ${PALETTE[idx - 1].name.es}`) : msg('paint off', 'pintura quitada'))
  },
})
