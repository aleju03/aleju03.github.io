import { useEffect, useRef, useState } from 'react'
import { PaperPlaneRightIcon, SignOutIcon } from '@phosphor-icons/react'
import { ContactApp } from './appWindows'
import { useChat } from './chat'
import type { ChatMessage } from './chat'
import { sounds } from './sounds'

/*
  Messenger: 1:1 chat with Alejandro over the VPS chat server, instant-messenger
  style. Visitors see his presence and chat (or leave a message when he's away);
  Alejandro types "/admin <token>" in the same window to flip it into the admin
  console with the conversation list. When no server is configured or reachable,
  the window falls back to the classic mail composer.
*/

const inset =
  'rounded-sm border border-stone-400 bg-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

function ChatLog({
  messages,
  meSender,
  peerName,
  peerTyping,
  emptyHint,
}: {
  messages: ChatMessage[]
  meSender: 'visitor' | 'admin'
  peerName: string
  peerTyping: boolean
  emptyHint: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, peerTyping])

  return (
    <div className={`${inset} relative min-h-0 flex-1`}>
      <div ref={scrollRef} className="h-full overflow-y-auto p-2.5">
        {messages.length === 0 && (
          <p className="px-1 py-2 text-xs text-stone-500">{emptyHint}</p>
        )}
        {messages.map((m, i) => {
          const mine = m.sender === meSender
          const firstOfRun = i === 0 || messages[i - 1].sender !== m.sender
          return (
            <div key={m.id} className={m.pending ? 'opacity-60' : undefined}>
              {firstOfRun && (
                <p
                  className={`mt-1.5 text-[11px] font-semibold ${
                    mine ? 'text-stone-500' : 'text-blue-700'
                  }`}
                >
                  {mine ? 'you say:' : `${peerName} says:`}
                </p>
              )}
              <p className="pl-3 text-[13px] leading-snug whitespace-pre-wrap text-stone-800">
                {m.text}
              </p>
            </div>
          )
        })}
        {peerTyping && (
          <p className="mt-2 text-[11px] text-stone-400 italic">{peerName} is typing...</p>
        )}
      </div>
    </div>
  )
}

function Composer({
  onSend,
  onTyping,
  disabled,
}: {
  onSend: (text: string) => void
  onTyping: () => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const submit = () => {
    if (!draft.trim()) return
    onSend(draft)
    setDraft('')
  }
  return (
    <div className="flex items-stretch gap-2">
      <textarea
        value={draft}
        data-no-focus-ring
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value)
          onTyping()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        placeholder="Type a message"
        aria-label="Message"
        className={`${inset} flex-1 resize-none px-2 py-1.5 text-[13px] text-stone-800 disabled:bg-stone-100`}
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled}
        aria-label="Send message"
        className="flex cursor-pointer items-center rounded-sm border border-stone-400 bg-stone-200 px-3 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-50"
      >
        <PaperPlaneRightIcon size={16} weight="fill" />
      </button>
    </div>
  )
}

export function MessengerApp() {
  const chat = useChat(() => sounds.message())
  const [namePrompt, setNamePrompt] = useState(() => !chat.name)

  // no server configured, or it is unreachable right now: classic mail instead
  if (!chat.enabled || chat.status === 'unavailable') {
    return (
      <div className="flex h-full flex-col">
        <p className="border-b border-stone-300 bg-stone-200 px-3 py-1.5 text-[11px] text-stone-500">
          Live chat is offline right now, but mail still works.
        </p>
        <div className="min-h-0 flex-1">
          <ContactApp />
        </div>
      </div>
    )
  }

  const send = (text: string) => {
    // the admin backdoor: never sent as a message
    if (text.startsWith('/admin ')) {
      chat.loginAdmin(text.slice(7))
      return
    }
    if (text === '/logout' && chat.role === 'admin') {
      chat.logoutAdmin()
      return
    }
    chat.send(text)
  }

  if (chat.role === 'admin') {
    const active = chat.convos.find((c) => c.id === chat.activeConvo)
    return (
      <div className="flex h-full flex-col bg-stone-100">
        <div className="flex items-center gap-2 border-b border-stone-300 bg-stone-200 px-3 py-1.5">
          <span className="size-2 rounded-full bg-green-600" aria-hidden />
          <p className="flex-1 text-xs font-medium text-stone-700">
            admin console · {chat.convos.length} conversation{chat.convos.length === 1 ? '' : 's'}
          </p>
          <button
            type="button"
            onClick={chat.logoutAdmin}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-stone-500 hover:text-stone-800"
          >
            <SignOutIcon size={12} /> log out
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <ul className="w-44 shrink-0 overflow-y-auto border-r border-stone-300 bg-white">
            {chat.convos.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-stone-400">No conversations yet</li>
            )}
            {chat.convos.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    sounds.click()
                    chat.openConvo(c.id)
                  }}
                  className={`block w-full cursor-pointer border-b border-stone-200 px-2.5 py-2 text-left hover:bg-blue-600/5 ${
                    chat.activeConvo === c.id ? 'bg-blue-600/10' : ''
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="flex-1 truncate text-xs font-medium text-stone-800">
                      {c.name || `visitor ${c.id.slice(0, 6)}`}
                    </span>
                    {(chat.unread[c.id] ?? 0) > 0 && (
                      <span className="rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">
                        {chat.unread[c.id]}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-stone-500">{c.lastText}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
            {chat.activeConvo ? (
              <>
                <ChatLog
                  messages={chat.adminMessages}
                  meSender="admin"
                  peerName={active?.name || 'visitor'}
                  peerTyping={chat.peerTyping}
                  emptyHint="Loading conversation..."
                />
                <Composer onSend={send} onTyping={chat.sendTyping} />
              </>
            ) : (
              <p className="m-auto text-xs text-stone-400">Pick a conversation</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  const online = chat.status === 'online'
  const connecting = chat.status === 'connecting'

  return (
    <div className="flex h-full flex-col bg-stone-100">
      {/* buddy header */}
      <div className="flex items-center gap-2.5 border-b border-stone-300 bg-gradient-to-b from-stone-100 to-stone-200 px-3 py-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-b from-blue-500 to-blue-700 font-mono text-xs font-bold text-white">
          aj
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-stone-800">Alejandro Jiménez</p>
          <p className="flex items-center gap-1.5 text-[11px] text-stone-500">
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${
                online ? 'bg-green-600' : connecting ? 'bg-stone-400' : 'bg-amber-500'
              }`}
            />
            {online ? 'Online' : connecting ? 'Connecting' : 'Away'}
          </p>
        </div>
      </div>

      {!online && !connecting && (
        <p className="border-b border-stone-300 bg-stone-200/70 px-3 py-1.5 text-[11px] text-stone-600">
          Alejandro is away. Your message lands on his server and he answers when he is back.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
        <ChatLog
          messages={chat.messages}
          meSender="visitor"
          peerName="alejandro"
          peerTyping={chat.peerTyping}
          emptyHint="Say hi. This chat runs on the same server this site talks about."
        />
        {namePrompt && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const value = new FormData(e.currentTarget).get('nick')
              chat.setName(String(value ?? ''))
              setNamePrompt(false)
              sounds.click()
            }}
          >
            <label htmlFor="msgr-nick" className="text-[11px] text-stone-500">
              Your name
            </label>
            <input
              id="msgr-nick"
              name="nick"
              data-no-focus-ring
              maxLength={40}
              placeholder="optional"
              className={`${inset} h-6 w-36 px-2 text-xs text-stone-800`}
            />
            <button
              type="submit"
              className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-2.5 py-0.5 text-[11px] text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
            >
              OK
            </button>
          </form>
        )}
        <Composer onSend={send} onTyping={chat.sendTyping} />
      </div>
    </div>
  )
}
