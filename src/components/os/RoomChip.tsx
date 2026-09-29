import { useI18n } from '../../i18n'
import { useWorldRoom } from './worldRoom'

/*
  The one subtle mark that says you are not in the public world: a small
  mono chip in the corner with the room's code. Nothing at all in public, so
  the default game looks exactly as it did before rooms existed. Shown only
  once the server has confirmed the room (`live`), so a refused code never
  flashes up as though it had worked.
*/
export default function RoomChip() {
  const { t } = useI18n()
  const room = useWorldRoom()
  if (!room.live || room.live === 'public') return null
  return (
    <p
      className="pointer-events-none absolute top-3 left-4 z-10 rounded-sm border border-stone-700/70 bg-stone-950/55 px-2 py-[2px] font-mono text-[10px] tracking-wider text-stone-400 backdrop-blur-sm"
      title={t.pause.room.private}
    >
      {t.pause.room.private} <span className="text-stone-200">{room.live}</span>
    </p>
  )
}
