import type { SandboxHost } from '../commands'
import type { Sandbox } from '../sandbox'
import { place, type Blueprint, type Placed } from './blueprint'
import { buildNotices } from './clipboard'
import { reasonText } from './dupe'

/*
  Paste without the tool gun: a blueprint dropped where the crosshair is.

  The console's `/load`, `/paste` and the builds panel's "spawn" all end
  here. It casts the eye ray the way the console's `spawn` does, stands the
  build on whatever it meets (or, looking at nothing, a few steps ahead on
  the ground), and reports through the same
  notice line the tool gun uses.
*/

export function pasteAtCrosshair(host: SandboxHost, sb: Sandbox, bp: Blueprint): Placed {
  const a = host.aim?.()
  const here = host.here?.()
  const reach = 60
  let x: number
  let y: number
  let z: number
  const hit = a ? sb.raycast(a.origin, a.dir, reach, { props: true, world: true }) : null
  if (hit) {
    x = hit.point.x
    y = hit.point.y
    z = hit.point.z
  } else if (here) {
    // eight units ahead, on the ground
    const yaw = here.yaw
    x = here.x - Math.sin(yaw) * 8
    z = here.z - Math.cos(yaw) * 8
    y = sb.groundY(x, z)
  } else {
    x = sb.focus.x
    z = sb.focus.z
    y = sb.groundY(x, z)
  }
  // as it was copied (the tool gun's paste starts unturned too)
  const r = place(sb, bp, { at: { x, y, z } })
  if (r.ok) {
    host.spawned?.(r.ids)
    buildNotices.emit({
      tone: 'ok',
      en: `placed ${r.ids.length} prop${r.ids.length === 1 ? '' : 's'}, ${r.joints} joint${r.joints === 1 ? '' : 's'} (z undoes it)`,
      es: `colocados ${r.ids.length} objeto${r.ids.length === 1 ? '' : 's'}, ${r.joints} unión${r.joints === 1 ? '' : 'es'} (z lo deshace)`,
    })
  } else {
    const t = reasonText(r.reason)
    buildNotices.emit({
      tone: 'err',
      en: r.reason === 'limit' ? `${t.en} (room for ${r.room ?? 0})` : t.en,
      es: r.reason === 'limit' ? `${t.es} (caben ${r.room ?? 0})` : t.es,
    })
  }
  return r
}
