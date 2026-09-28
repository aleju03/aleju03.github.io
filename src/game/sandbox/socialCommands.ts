/*
 * The console's side of ownership and anti-grief: friends, the protection
 * switch, sharing a prop, chunk claims, the vote to remove a griefer and the
 * admin's kick and mute. They are commands of a shared world, so each one
 * says so when there is nobody out here rather than pretending; every one of
 * them is a single message to the server (net/socialProtocol.ts), which is
 * the only thing that decides. What comes back arrives as notices the scene
 * words (net/remoteSocial.ts), so a command's own reply is only "asked".
 *
 * Separate from commands.ts for the reason destruction.ts is: it registers
 * itself on import, reaching the scene only through `host.social`.
 */
import { msg, registerCommand, type CommandCtx, type SandboxHost } from './commands'

/** what the scene lends the console for the shared rules (CrtScene builds it
    over its social mirror) */
export interface SocialHost {
  /** the message goes to the server, scoped to the level we are in */
  send: (m:
    | { op: 'friend' | 'unfriend' | 'votekick' | 'kick' | 'unmute'; name: string }
    | { op: 'mute'; name: string; minutes?: number }
    | { op: 'protect'; on: boolean }
    | { op: 'vote'; yes: boolean }
    | { op: 'claim' | 'unclaim'; cx: number; cz: number }) => void
  admin: () => boolean
  protect: () => boolean
  friends: () => readonly string[]
  /** every claim in this level */
  claims: () => ReadonlyArray<{ cx: number; cz: number; owner: string; mine: boolean }>
  /** the block chunk the walker stands in, or null in a level without claims */
  chunkHere: () => { cx: number; cz: number } | null
}

const social = (ctx: CommandCtx) => {
  const s = ctx.host.social
  if (!s || !ctx.host.online?.()) ctx.fail(msg('nobody else is out here', 'no hay nadie más aquí'))
  return s!
}
const names = (host: SandboxHost) => host.players?.().map((p) => p.name) ?? []
const who = (): { name: string; nameEs: string; type: 'text'; choices: (h: SandboxHost) => readonly string[] } => ({
  name: 'player', nameEs: 'jugador', type: 'text', choices: names,
})
const asked = (ctx: CommandCtx) => ctx.out(msg('asked', 'pedido'))

registerCommand({
  name: 'friend',
  args: [who()],
  help: msg('let a player use your things: physgun, tool gun, parts, removing', 'deja que un jugador use tus cosas: physgun, tool gun, piezas, quitar'),
  run: (ctx) => {
    social(ctx).send({ op: 'friend', name: ctx.args.join(' ').trim() })
    asked(ctx)
  },
})

registerCommand({
  name: 'unfriend',
  args: [{ ...who(), choices: (h) => h.social?.friends() ?? [] }],
  help: msg('take that permission back', 'quita ese permiso'),
  run: (ctx) => {
    social(ctx).send({ op: 'unfriend', name: ctx.args.join(' ').trim() })
    asked(ctx)
  },
})

registerCommand({
  name: 'friends',
  help: msg('who may use your things', 'quién puede usar tus cosas'),
  run: (ctx) => {
    const list = ctx.host.social?.friends() ?? []
    if (!list.length) ctx.fail(msg('nobody. /friend NAME lets somebody in', 'nadie. /friend NOMBRE deja pasar a alguien'))
    for (const n of list) ctx.item(n, msg('may use yours', 'usa lo tuyo'))
  },
})

registerCommand({
  name: 'protect',
  args: [{ name: 'state', nameEs: 'estado', type: 'choice', optional: true, choices: ['on', 'off'] }],
  help: msg(
    'props belong to whoever made them (on by default); the first player here or an admin switches it',
    'los objetos son de quien los hizo (activado de serie); lo cambia el primer jugador o un administrador',
  ),
  run: (ctx) => {
    const s = social(ctx)
    const want = ctx.args[0]
    if (!want) {
      ctx.out(s.protect()
        ? msg('protection is on: things belong to whoever made them', 'la protección está activada: cada cosa es de quien la hizo')
        : msg('protection is off: free for all', 'la protección está desactivada: todo es de todos'))
      return
    }
    s.send({ op: 'protect', on: want === 'on' })
    asked(ctx)
  },
})

const shareIt = (ctx: CommandCtx, on: boolean) => {
  const sb = ctx.needSandbox()
  const net = sb.network
  if (!net?.online || !net.share) ctx.fail(msg('nobody else is out here', 'no hay nadie más aquí'))
  if (ctx.args[0]?.toLowerCase() === 'all') {
    net!.share!('all', on)
    ctx.ok(on ? msg('all your props are open to everyone', 'todos tus objetos están abiertos a todos') : msg('all your props are yours again', 'todos tus objetos vuelven a ser solo tuyos'))
    return
  }
  const a = ctx.host.aim?.()
  const hit = a ? sb.raycast(a.origin, a.dir, 120) : null
  if (!hit?.prop) ctx.fail(msg('look at a prop first (or share all)', 'apunta a un objeto primero (o share all)'))
  net!.share!([hit!.prop!.id], on)
  ctx.ok(on ? msg('shared: anyone may use it', 'compartido: cualquiera puede usarlo') : msg('yours again', 'vuelve a ser solo tuyo'))
}
registerCommand({
  name: 'share',
  args: [{ name: 'what', nameEs: 'qué', type: 'choice', optional: true, choices: ['all'] }],
  help: msg('open the prop you are looking at (or all of yours) to everyone', 'abre a todos el objeto que miras (o todos los tuyos)'),
  run: (ctx) => shareIt(ctx, true),
})
registerCommand({
  name: 'unshare',
  args: [{ name: 'what', nameEs: 'qué', type: 'choice', optional: true, choices: ['all'] }],
  help: msg('take a shared prop (or all of yours) back', 'recupera un objeto compartido (o todos los tuyos)'),
  run: (ctx) => shareIt(ctx, false),
})

registerCommand({
  name: 'claim',
  help: msg('claim the 16x16 chunk you stand in: only you and your friends can build or blast it', 'reclama el chunk de 16x16 donde estás: solo tú y tus amigos pueden construir o volarlo'),
  run: (ctx) => {
    const s = social(ctx)
    const at = s.chunkHere()
    if (!at) ctx.fail(msg('there is nothing to claim in this world', 'aquí no hay nada que reclamar'))
    s.send({ op: 'claim', cx: at!.cx, cz: at!.cz })
    asked(ctx)
  },
})
registerCommand({
  name: 'unclaim',
  help: msg('release the chunk you stand in', 'suelta el chunk donde estás'),
  run: (ctx) => {
    const s = social(ctx)
    const at = s.chunkHere()
    if (!at) ctx.fail(msg('there is nothing to claim in this world', 'aquí no hay nada que reclamar'))
    s.send({ op: 'unclaim', cx: at!.cx, cz: at!.cz })
    asked(ctx)
  },
})
registerCommand({
  name: 'claims',
  help: msg('the chunks claimed in this world, and whose', 'los chunks reclamados en este mundo, y de quién'),
  run: (ctx) => {
    const list = ctx.host.social?.claims() ?? []
    if (!list.length) ctx.fail(msg('no claims here. /claim fences the chunk you stand in', 'no hay reclamos aquí. /claim cerca el chunk donde estás'))
    for (const c of list) ctx.item(msg(`chunk ${c.cx}, ${c.cz}`, `chunk ${c.cx}, ${c.cz}`), c.mine ? msg('yours', 'tuyo') : c.owner)
  },
})

registerCommand({
  name: 'votekick',
  args: [who()],
  help: msg('open a 20 second vote to remove a player for 10 minutes (/yes or /no)', 'abre una votación de 20 segundos para sacar a un jugador 10 minutos (/yes o /no)'),
  run: (ctx) => {
    social(ctx).send({ op: 'votekick', name: ctx.args.join(' ').trim() })
    asked(ctx)
  },
})
registerCommand({
  name: 'yes',
  aliases: ['si'],
  help: msg('vote yes on the open vote', 'vota que sí'),
  run: (ctx) => social(ctx).send({ op: 'vote', yes: true }),
})
registerCommand({
  name: 'no',
  help: msg('vote no on the open vote', 'vota que no'),
  run: (ctx) => social(ctx).send({ op: 'vote', yes: false }),
})

const adminOnly = (ctx: CommandCtx) => {
  const s = social(ctx)
  if (!s.admin()) ctx.fail(msg('admins only', 'solo administradores'))
  return s
}
registerCommand({
  name: 'kick',
  args: [who()],
  help: msg('remove a player from this world for 10 minutes (admin)', 'saca a un jugador de este mundo 10 minutos (administrador)'),
  run: (ctx) => {
    adminOnly(ctx).send({ op: 'kick', name: ctx.args.join(' ').trim() })
    asked(ctx)
  },
})
registerCommand({
  name: 'mute',
  args: [{ name: 'player [minutes]', nameEs: 'jugador [minutos]', type: 'text', choices: names }],
  help: msg('silence a player in chat and voice (admin; 10 minutes unless told)', 'silencia a un jugador en chat y voz (administrador; 10 minutos si no dices)'),
  run: (ctx) => {
    // (the name may have spaces: the last word is the minutes if it is a number)
    const words = ctx.args.join(' ').trim().split(/\s+/)
    const last = Number(words[words.length - 1])
    const minutes = words.length > 1 && Number.isInteger(last) ? last : undefined
    const name = (minutes === undefined ? words : words.slice(0, -1)).join(' ')
    adminOnly(ctx).send({ op: 'mute', name, ...(minutes === undefined ? {} : { minutes }) })
    asked(ctx)
  },
})
registerCommand({
  name: 'unmute',
  args: [who()],
  help: msg('let a muted player talk again (admin)', 'deja hablar de nuevo a un jugador silenciado (administrador)'),
  run: (ctx) => {
    adminOnly(ctx).send({ op: 'unmute', name: ctx.args.join(' ').trim() })
    asked(ctx)
  },
})
