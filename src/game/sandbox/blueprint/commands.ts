import { msg, registerCommand, type CommandCtx } from '../commands'
import { pasteAtCrosshair } from './actions'
import { capture, connectedTo, propsWithin, type Blueprint } from './blueprint'
import { buildsBackend, clipboard } from './clipboard'
import { cleanName } from './code'
import { reasonText } from './dupe'

/*
  The console side of the duplicator and the build slots.

    copy [radius]   the machine you look at, or every prop within radius
    paste           the clipboard, set down where you look
    save NAME       keep the clipboard (or the machine you look at) in a slot
    load NAME       take a slot into the clipboard and set it down
    unsave NAME     empty a slot
    builds          list the slots and open the builds panel
    publish NAME    put a slot on the public gallery (an account is needed)

  The commands are the same actions the tool gun's copy and paste modes and
  the builds panel take (dupe.ts, actions.ts); what is different here is only
  that the aim comes from the console host. Saving goes through the backend
  the React side installs (clipboard.ts), and every command says plainly when
  there is none.
*/

const noBackend = (ctx: CommandCtx) =>
  ctx.fail(msg('saving is not available here', 'aquí no se puede guardar'))

let slotNames: string[] = []
const refreshNames = () => {
  void buildsBackend()?.list().then((l) => {
    slotNames = l.map((s) => s.name)
  })
}

const nameOf = (ctx: CommandCtx) => {
  const n = cleanName(ctx.args.join(' '))
  if (!n) ctx.fail(msg('give it a name', 'ponle un nombre'))
  return n
}

/** what the crosshair is on: a prop, its whole machine, or a ball of props */
const lookedAt = (ctx: CommandCtx, radius?: number): Blueprint => {
  const sb = ctx.needSandbox()
  const a = ctx.host.aim?.()
  if (!a) ctx.fail(msg('nothing to aim with', 'no hay con qué apuntar'))
  const hit = sb.raycast(a!.origin, a!.dir, 120, { props: true, world: true })
  if (radius !== undefined) {
    if (!hit) ctx.fail(msg('look at the ground or a prop first', 'apunta al suelo o a un objeto primero'))
    const r = capture(sb, propsWithin(sb, hit!.point, radius))
    if (!r.ok) ctx.fail(msg(reasonText(r.reason).en, reasonText(r.reason).es))
    return r.bp
  }
  if (!hit?.prop) ctx.fail(msg('look at a prop first', 'apunta a un objeto primero'))
  const r = capture(sb, connectedTo(sb, hit!.prop!.id))
  if (!r.ok) ctx.fail(msg(reasonText(r.reason).en, reasonText(r.reason).es))
  return r.bp
}

registerCommand({
  name: 'copy',
  args: [{ name: 'radius', nameEs: 'radio', type: 'number', optional: true }],
  help: msg(
    'copy the machine you look at (or every prop within a radius) for paste',
    'copia la máquina que miras (o los objetos dentro de un radio) para pegar',
  ),
  run: (ctx) => {
    const radius = ctx.args[0] ? Math.max(1, Math.min(60, Number(ctx.args[0]))) : undefined
    if (radius !== undefined && !Number.isFinite(radius)) ctx.fail(msg('radius is a number', 'el radio es un número'))
    const bp = lookedAt(ctx, radius)
    clipboard.set(bp)
    const n = bp.props.length
    ctx.ok(msg(
      `copied ${n} prop${n === 1 ? '' : 's'}, ${bp.joints.length} joint${bp.joints.length === 1 ? '' : 's'}`,
      `copiados ${n} objeto${n === 1 ? '' : 's'}, ${bp.joints.length} unión${bp.joints.length === 1 ? '' : 'es'}`,
    ))
  },
})

registerCommand({
  name: 'paste',
  help: msg('set the copied build down where you look (or use the tool gun\'s paste mode)', 'coloca lo copiado donde miras (o usa el modo pegar de la pistola)'),
  run: (ctx) => {
    const bp = clipboard.get()
    if (!bp) ctx.fail(msg('nothing copied yet: copy, or /load a build', 'no hay nada copiado: copy, o /load una construcción'))
    const r = pasteAtCrosshair(ctx.host, ctx.needSandbox(), bp!)
    if (!r.ok) ctx.fail(msg('could not place it', 'no se pudo colocar'))
  },
})

registerCommand({
  name: 'save',
  args: [{ name: 'name', nameEs: 'nombre', type: 'text' }],
  help: msg(
    'keep the copied build (or the machine you look at) in a named slot',
    'guarda lo copiado (o la máquina que miras) en una casilla con nombre',
  ),
  run: async (ctx) => {
    const backend = buildsBackend() ?? noBackend(ctx)
    const name = nameOf(ctx)
    const bp = clipboard.get() ?? lookedAt(ctx)
    if (!(await backend.save({ ...bp, name }))) {
      ctx.fail(msg('could not save it (storage full or blocked, or 50 slots used)', 'no se pudo guardar (almacenamiento lleno o bloqueado, o 50 casillas usadas)'))
    }
    refreshNames()
    ctx.ok(msg(`saved "${name}" (${bp.props.length} props)`, `guardado "${name}" (${bp.props.length} objetos)`))
  },
})

registerCommand({
  name: 'load',
  args: [{ name: 'name', nameEs: 'nombre', type: 'text', choices: () => slotNames }],
  help: msg('take a saved build and set it down where you look', 'toma una construcción guardada y colócala donde miras'),
  run: async (ctx) => {
    const backend = buildsBackend() ?? noBackend(ctx)
    const name = nameOf(ctx)
    const bp = await backend.load(name)
    if (!bp) ctx.fail(msg(`no build called "${name}" (try /builds)`, `no hay construcción llamada "${name}" (prueba /builds)`))
    clipboard.set(bp)
    const r = pasteAtCrosshair(ctx.host, ctx.needSandbox(), bp!)
    if (!r.ok) ctx.fail(msg('could not place it', 'no se pudo colocar'))
  },
})

registerCommand({
  name: 'unsave',
  args: [{ name: 'name', nameEs: 'nombre', type: 'text', choices: () => slotNames }],
  help: msg('empty a build slot', 'vacía una casilla de construcción'),
  run: async (ctx) => {
    const backend = buildsBackend() ?? noBackend(ctx)
    const name = nameOf(ctx)
    if (!(await backend.remove(name))) ctx.fail(msg(`no build called "${name}"`, `no hay construcción llamada "${name}"`))
    refreshNames()
    ctx.ok(msg(`emptied "${name}"`, `vaciada "${name}"`))
  },
})

registerCommand({
  name: 'builds',
  aliases: ['blueprints'],
  help: msg('list your saved builds and open the builds book', 'lista tus construcciones guardadas y abre el libro de construcciones'),
  run: async (ctx) => {
    const backend = buildsBackend() ?? noBackend(ctx)
    const list = await backend.list()
    slotNames = list.map((s) => s.name)
    if (!list.length) ctx.out(msg('no saved builds yet: /copy then /save NAME', 'aún no hay construcciones guardadas: /copy y luego /save NOMBRE'))
    for (const s of list) ctx.item(s.name, msg(`${s.props} props`, `${s.props} objetos`))
    backend.open?.()
  },
})

registerCommand({
  name: 'publish',
  args: [{ name: 'name', nameEs: 'nombre', type: 'text', choices: () => slotNames }],
  help: msg(
    'put a saved build on the public gallery (registered accounts only)',
    'publica una construcción guardada en la galería pública (solo cuentas registradas)',
  ),
  run: async (ctx) => {
    const backend = buildsBackend() ?? noBackend(ctx)
    const name = nameOf(ctx)
    const r = await backend.publish(name)
    if (!r.ok) ctx.fail(msg(`could not publish: ${r.reason.en}`, `no se pudo publicar: ${r.reason.es}`))
    ctx.ok(msg(`published "${name}"`, `publicada "${name}"`))
  },
})

// keep the completer's names fresh once a backend exists
refreshNames()
export const refreshBuildNames = refreshNames
