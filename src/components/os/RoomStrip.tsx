import { useEffect, useRef, useState } from 'react'
import { menuTick } from '../../game/core/sfx'
import { useI18n } from '../../i18n'
import { worldConfigured } from './worldNet'
import {
  createPrivateRoom,
  dismissRoomError,
  inviteUrl,
  joinRoomCode,
  leaveToPublic,
  useWorldRoom,
} from './worldRoom'
import { CIRCLED, INK, INK_SOFT, MARK } from './paper'
import { Note } from './PaperMarks'

/*
  Who you play with: the strip on the map sheet and the pause sheet that picks
  a room. Same stationery as both (paper.ts's ink, a circled choice, pencil
  notes), because it is written on the same sheet and a settings-panel widget
  would be the one thing on it that had an author from somewhere else.

  Three ways to be somewhere: the public world (the default), a private room
  you make (a code minted on the spot, with the invite link a click from the
  clipboard), or one you were given a code for. It only ever edits the
  decision in `worldRoom.ts`; CrtScene notices the wish change and re-enters,
  and worldNet reports what the server actually said back into the same store,
  which is why the code shown here goes on to say "finding the room…" until
  the welcome lands and why a refused code shows up as a pencilled line
  rather than a dialog.

  It stops key events at the field: the map sheet answers to number keys and
  enter, and a code is made of exactly those.
*/

export default function RoomStrip({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const tr = t.pause.room
  const room = useWorldRoom()
  const [typed, setTyped] = useState('')
  const [bad, setBad] = useState(false)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  // no server, no rooms: nothing to choose between
  if (!worldConfigured()) return null

  const inPrivate = room.code !== null

  const copy = async () => {
    if (!room.code) return
    let ok = false
    try {
      await navigator.clipboard.writeText(inviteUrl(room.code))
      ok = true
    } catch {
      /* insecure context or denied: say so rather than pretend */
    }
    setCopied(ok ? 'ok' : 'fail')
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 2200)
  }

  const submit = () => {
    if (joinRoomCode(typed)) {
      menuTick('pick')
      setBad(false)
      setTyped('')
    } else {
      setBad(true)
    }
  }

  const choice = (on: boolean, label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={() => {
        menuTick('pick')
        onClick()
      }}
      aria-pressed={on}
      className="font-display relative px-1 py-0.5 text-[19px] uppercase"
      style={{ color: on ? INK : INK_SOFT }}
    >
      {label}
      <span
        aria-hidden
        className={`absolute -inset-x-2.5 -inset-y-1 transition-opacity ${on ? 'opacity-100' : 'opacity-0'}`}
        style={CIRCLED}
      />
    </button>
  )

  return (
    <div className={className} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="font-display text-[21px] uppercase" style={{ color: INK }}>
          {tr.title}
        </span>
        {choice(!inPrivate, tr.public, () => leaveToPublic())}
        {choice(inPrivate, inPrivate ? tr.private : tr.create, () => {
          if (!inPrivate) createPrivateRoom()
        })}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value.toUpperCase())
              setBad(false)
              dismissRoomError()
            }}
            placeholder={tr.placeholder}
            aria-label={tr.joinLabel}
            maxLength={16}
            spellCheck={false}
            autoComplete="off"
            className="w-28 border-b-2 bg-transparent px-1 py-0.5 font-mono text-[14px] tracking-[0.18em] uppercase outline-none placeholder:tracking-normal"
            style={{ color: INK, borderColor: `${INK}77` }}
          />
          <button
            type="submit"
            disabled={typed.trim() === ''}
            className="font-display px-1 text-[19px] uppercase disabled:opacity-40"
            style={{ color: INK_SOFT }}
          >
            {tr.join}
          </button>
        </form>
      </div>

      {inPrivate && room.code ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span
            className="px-2 py-[1px] font-mono text-[15px] tracking-[0.22em]"
            style={{
              color: INK,
              background: 'rgba(250,247,239,0.75)',
              border: `1px dashed ${INK}88`,
              transform: 'rotate(-0.8deg)',
            }}
            title={tr.private}
          >
            {room.code}
          </span>
          <button
            type="button"
            onClick={copy}
            className="font-mono text-[12px] underline decoration-dotted underline-offset-4"
            style={{ color: copied === 'fail' ? MARK : INK }}
          >
            {copied === 'ok' ? tr.copied : copied === 'fail' ? tr.copyFailed : tr.copyLink}
          </button>
          <button
            type="button"
            onClick={() => {
              menuTick('pick')
              createPrivateRoom()
            }}
            className="font-mono text-[12px] underline decoration-dotted underline-offset-4"
            style={{ color: INK_SOFT }}
          >
            {tr.another}
          </button>
          <button
            type="button"
            onClick={() => {
              menuTick('pick')
              leaveToPublic()
            }}
            className="font-mono text-[12px] underline decoration-dotted underline-offset-4"
            style={{ color: INK_SOFT }}
          >
            {tr.leave}
          </button>
          <Note>{tr.inviteNote}</Note>
        </div>
      ) : (
        <p className="mt-1.5">
          <Note>{tr.publicNote} · {tr.createNote}</Note>
        </p>
      )}
      {(bad || room.error) && (
        <p className="mt-1.5 font-mono text-[12px]" style={{ color: MARK }}>
          {bad ? tr.invalid : tr.errors[room.error!]}
        </p>
      )}
    </div>
  )
}
