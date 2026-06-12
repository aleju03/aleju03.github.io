import { useEffect, useRef, useState } from 'react'
import { CrownSimpleIcon, HashIcon, PaperPlaneRightIcon, UsersIcon, XIcon } from '@phosphor-icons/react'
import { useOs } from './osContext'
import { useRoomChat } from './chatRooms'
import type { RoomMessage } from './chatRooms'
import { ContactApp } from './appWindows'
import { sounds } from './sounds'

/*
  Chat Rooms: the AlejOS take on an early-2000s IRC client with a Discord
  floor plan — rooms down the left, people down the right, everyone in the
  middle. Registered users keep their name across visits, guests pick a nick
  on the spot, and the admin's messages wear a little crown. Runs on the
  self-hosted chat server; with no server configured it falls back to mail.
*/

const ROOM_BLURBS: Record<string, string> = {
  general: 'anything goes',
  projects: 'talk about the stuff on this site',
  random: 'the watercooler',
}

function timeOf(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function NameTag({ m }: { m: Pick<RoomMessage, 'from' | 'admin' | 'registered'> }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
        m.admin ? 'text-amber-600' : m.registered ? 'text-blue-700' : 'text-stone-500'
      }`}
    >
      {m.admin && <CrownSimpleIcon size={11} weight="fill" />}
      {m.from}
    </span>
  )
}

export function ChatApp() {
  const os = useOs()
  const chat = useRoomChat(os.session, () => sounds.message())
  const [draft, setDraft] = useState('')
  const [showUsers, setShowUsers] = useState(true)
  const [nickDraft, setNickDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const isGuest = os.session.kind === 'guest'

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages, chat.typing])

  if (!chat.enabled) {
    return (
      <div className="flex h-full flex-col">
        <p className="border-b border-stone-300 bg-stone-200 px-3 py-1.5 text-[11px] text-stone-500">
          Chat is offline right now, but mail still works.
        </p>
        <div className="min-h-0 flex-1">
          <ContactApp />
        </div>
      </div>
    )
  }

  const submit = () => {
    if (!draft.trim()) return
    chat.send(draft)
    setDraft('')
  }

  const online = chat.status === 'online'

  return (
    <div className="flex h-full bg-stone-100">
      {/* rooms */}
      <nav className="flex w-36 shrink-0 flex-col border-r border-stone-300 bg-stone-200/70">
        <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-stone-500 uppercase">
          Rooms
        </p>
        <ul className="flex-1 overflow-y-auto px-1.5">
          {(chat.rooms.length > 0 ? chat.rooms : [{ id: 'general', users: 0 }]).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  sounds.click()
                  chat.joinRoom(r.id)
                }}
                title={ROOM_BLURBS[r.id]}
                className={`flex w-full cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs ${
                  chat.room === r.id
                    ? 'bg-blue-600/15 font-medium text-blue-800'
                    : 'text-stone-600 hover:bg-blue-600/5'
                }`}
              >
                <HashIcon size={12} weight="bold" className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{r.id}</span>
                {r.users > 0 && (
                  <span className="shrink-0 rounded-full bg-stone-300 px-1.5 text-[10px] tabular-nums text-stone-600">
                    {r.users}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-stone-300 px-3 py-2">
          <p className="truncate text-[11px] font-medium text-stone-700">{chat.me}</p>
          <p className="flex items-center gap-1 text-[10px] text-stone-500">
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${
                online ? 'bg-green-600' : chat.status === 'connecting' ? 'bg-stone-400' : 'bg-red-500'
              }`}
            />
            {online ? (isGuest ? 'guest' : 'signed in') : chat.status}
          </p>
        </div>
      </nav>

      {/* messages */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-stone-300 bg-gradient-to-b from-stone-100 to-stone-200 px-3 py-2">
          <HashIcon size={14} weight="bold" className="text-blue-700" />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-stone-800">
            {chat.room}
            <span className="ml-2 hidden text-[11px] font-normal text-stone-500 sm:inline">
              {ROOM_BLURBS[chat.room]}
            </span>
          </p>
          <button
            type="button"
            aria-label="Toggle member list"
            onClick={() => setShowUsers((s) => !s)}
            className={`cursor-pointer rounded-sm p-1 ${
              showUsers ? 'bg-blue-600/15 text-blue-800' : 'text-stone-500 hover:bg-stone-300/70'
            }`}
          >
            <UsersIcon size={14} weight="bold" />
          </button>
        </div>

        {!online && (
          <p className="border-b border-stone-300 bg-amber-100/70 px-3 py-1 text-[11px] text-amber-900">
            {chat.status === 'connecting' ? 'Dialing in…' : 'Line is busy. Redialing…'}
          </p>
        )}
        {chat.notice && (
          <p className="flex items-center gap-2 border-b border-stone-300 bg-blue-50 px-3 py-1 text-[11px] text-blue-900">
            <span className="min-w-0 flex-1 truncate">{chat.notice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={chat.clearNotice}
              className="cursor-pointer text-blue-700 hover:text-blue-900"
            >
              <XIcon size={11} weight="bold" />
            </button>
          </p>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-white p-2.5">
          {chat.messages.length === 0 && (
            <p className="px-1 py-2 text-xs text-stone-400">
              Nothing here yet. Say something, it sticks around.
            </p>
          )}
          {chat.messages.map((m, i) => {
            const firstOfRun = i === 0 || chat.messages[i - 1].from !== m.from
            return (
              <div key={m.id} className={m.pending ? 'opacity-60' : undefined}>
                {firstOfRun && (
                  <p className="mt-2 flex items-baseline gap-2">
                    <NameTag m={m} />
                    <span className="text-[10px] text-stone-400 tabular-nums">{timeOf(m.at)}</span>
                  </p>
                )}
                <p className="pl-3 text-[13px] leading-snug break-words whitespace-pre-wrap text-stone-800">
                  {m.text}
                </p>
              </div>
            )
          })}
          {chat.typing.length > 0 && (
            <p className="mt-2 text-[11px] text-stone-400 italic">
              {chat.typing.slice(0, 3).join(', ')}
              {chat.typing.length > 3 ? ' and others' : ''}{' '}
              {chat.typing.length === 1 ? 'is' : 'are'} typing…
            </p>
          )}
        </div>

        {/* guest nick row */}
        {isGuest && online && (
          <form
            className="flex items-center gap-2 border-t border-stone-300 bg-stone-200/60 px-2.5 py-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (nickDraft.trim()) {
                sounds.click()
                chat.setNick(nickDraft)
                setNickDraft('')
              }
            }}
          >
            <label htmlFor="chat-nick" className="shrink-0 text-[11px] text-stone-500">
              Chatting as <span className="font-medium text-stone-700">{chat.me}</span>. Change:
            </label>
            <input
              id="chat-nick"
              value={nickDraft}
              data-no-focus-ring
              maxLength={24}
              placeholder="new nickname"
              onChange={(e) => setNickDraft(e.target.value)}
              className="h-6 w-32 min-w-0 rounded-sm border border-stone-400 bg-white px-2 text-xs text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
            />
            <button
              type="submit"
              className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-2 py-0.5 text-[11px] text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
            >
              OK
            </button>
          </form>
        )}

        {/* composer */}
        <div className="flex items-stretch gap-2 border-t border-stone-300 bg-stone-100 p-2.5">
          <textarea
            value={draft}
            data-no-focus-ring
            disabled={!online}
            rows={2}
            placeholder={online ? `Message #${chat.room}` : 'Reconnecting…'}
            aria-label="Message"
            onChange={(e) => {
              setDraft(e.target.value)
              chat.sendTyping()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            className="min-w-0 flex-1 resize-none rounded-sm border border-stone-400 bg-white px-2 py-1.5 text-[13px] text-stone-800 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] disabled:bg-stone-100"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!online}
            aria-label="Send message"
            className="flex cursor-pointer items-center rounded-sm border border-stone-400 bg-stone-200 px-3 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-50"
          >
            <PaperPlaneRightIcon size={16} weight="fill" />
          </button>
        </div>
      </div>

      {/* members */}
      {showUsers && (
        <aside className="hidden w-36 shrink-0 flex-col border-l border-stone-300 bg-stone-200/70 sm:flex">
          <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider text-stone-500 uppercase">
            Online · {chat.users.length}
          </p>
          <ul className="flex-1 overflow-y-auto px-1.5 pb-2">
            {chat.users.map((u) => (
              <li key={u.name} className="flex items-center gap-1.5 rounded-md px-2 py-1">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-green-600" />
                <NameTag m={{ from: u.name, admin: u.admin, registered: u.registered }} />
              </li>
            ))}
            {chat.users.length === 0 && (
              <li className="px-2 py-1 text-[11px] text-stone-400">nobody yet</li>
            )}
          </ul>
        </aside>
      )}
    </div>
  )
}
