import { useState } from 'react'
import { motion } from 'motion/react'
import { CrownSimpleIcon, UserCircleIcon, UserCirclePlusIcon, UserIcon } from '@phosphor-icons/react'
import { sounds } from './sounds'
import { authRequest } from './chatRooms'
import type { Session } from './osContext'

/*
  The AlejOS welcome screen, in the spirit of the XP login: pick who you are
  before the desktop appears. Real accounts live in the chat server's SQLite
  (register once, your name is yours in the chat rooms); Guest always works,
  server or no server. A previously signed-in user gets their tile back for
  one-click entry.
*/

const SESSION_KEY = 'alejos-session'

function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Session
    if (v && v.kind === 'user' && typeof v.name === 'string' && typeof v.token === 'string')
      return v
  } catch {
    /* corrupted or unavailable */
  }
  return null
}

function storeSession(session: Session | null) {
  try {
    if (session && session.kind === 'user') {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } else {
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {
    /* storage unavailable */
  }
}

const tile =
  'group flex w-full cursor-pointer items-center gap-4 rounded-lg border border-white/15 bg-white/10 px-4 py-3 text-left transition hover:border-white/40 hover:bg-white/20'

interface LoginScreenProps {
  onLogin: (session: Session) => void
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<'pick' | 'signin' | 'register'>('pick')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saved = loadStoredSession()

  const enter = (session: Session) => {
    storeSession(session)
    sounds.startup()
    onLogin(session)
  }

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (busy) return
    const data = new FormData(e.currentTarget)
    const username = String(data.get('username') ?? '').trim()
    const password = String(data.get('password') ?? '')
    if (!username || !password) return
    setBusy(true)
    setError('')
    const r = await authRequest(mode === 'register' ? 'register' : 'login', username, password)
    setBusy(false)
    if (!r.ok) {
      sounds.error()
      setError(r.error)
      return
    }
    enter({ kind: 'user', name: r.name, token: r.token, admin: r.admin })
  }

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-blue-800 via-blue-700 to-blue-900">
      <div className="h-12 border-b border-blue-400/30" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="grid w-full max-w-2xl items-center gap-8 sm:grid-cols-[1fr_auto_1fr]">
          <div className="text-center sm:text-right">
            <p className="font-display text-4xl font-semibold text-white">
              Alej<span className="text-blue-300">OS</span>
            </p>
            <p className="mt-2 text-sm text-blue-200">To begin, choose who you are</p>
          </div>

          <div aria-hidden className="hidden h-48 w-px bg-blue-400/30 sm:block" />

          <motion.div
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="flex w-full max-w-xs flex-col gap-2.5 justify-self-center sm:justify-self-start"
          >
            {mode === 'pick' ? (
              <>
                {saved && (
                  <button type="button" className={tile} onClick={() => enter(saved)}>
                    <span className="text-blue-200">
                      {saved.admin ? (
                        <CrownSimpleIcon size={34} weight="duotone" />
                      ) : (
                        <UserCircleIcon size={34} weight="duotone" />
                      )}
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-white">{saved.name}</span>
                      <span className="block text-[11px] text-blue-200">click to sign back in</span>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className={tile}
                  onClick={() => {
                    sounds.click()
                    setError('')
                    setMode('signin')
                  }}
                >
                  <span className="text-blue-200">
                    <UserCirclePlusIcon size={34} weight="duotone" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-white">
                      Sign in or register
                    </span>
                    <span className="block text-[11px] text-blue-200">
                      make a name for yourself
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={tile}
                  onClick={() => enter({ kind: 'guest', name: 'guest' })}
                >
                  <span className="text-blue-200">
                    <UserIcon size={34} weight="duotone" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-white">Guest</span>
                    <span className="block text-[11px] text-blue-200">just looking around</span>
                  </span>
                </button>
              </>
            ) : (
              <form onSubmit={submit} className="rounded-lg border border-white/15 bg-white/10 p-4">
                <div className="mb-3 flex gap-1 rounded-md bg-blue-950/40 p-0.5">
                  {(['signin', 'register'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMode(m)
                        setError('')
                      }}
                      className={`flex-1 cursor-pointer rounded-[5px] py-1 text-xs font-medium transition ${
                        mode === m ? 'bg-white/20 text-white' : 'text-blue-200 hover:text-white'
                      }`}
                    >
                      {m === 'signin' ? 'Sign in' : 'Register'}
                    </button>
                  ))}
                </div>
                <label className="block text-[11px] text-blue-200">
                  Username
                  <input
                    name="username"
                    autoFocus
                    data-no-focus-ring
                    autoCapitalize="off"
                    autoComplete="username"
                    spellCheck={false}
                    maxLength={20}
                    className="mt-1 w-full rounded-sm border border-white/20 bg-blue-950/40 px-2 py-1.5 text-sm text-white placeholder:text-blue-300/50"
                    placeholder={mode === 'register' ? 'a-z, 0-9, _ or -' : ''}
                  />
                </label>
                <label className="mt-2.5 block text-[11px] text-blue-200">
                  Password
                  <input
                    name="password"
                    type="password"
                    data-no-focus-ring
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    maxLength={100}
                    className="mt-1 w-full rounded-sm border border-white/20 bg-blue-950/40 px-2 py-1.5 text-sm text-white"
                  />
                </label>
                {error && <p className="mt-2 text-[11px] leading-snug text-amber-300">{error}</p>}
                {mode === 'register' && !error && (
                  <p className="mt-2 text-[11px] leading-snug text-blue-200/80">
                    No email, no nonsense. Pick a name and it is yours in the chat rooms.
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="cursor-pointer rounded-md bg-white/20 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-white/30 disabled:cursor-default disabled:opacity-60"
                  >
                    {busy ? 'Checking…' : mode === 'register' ? 'Create account' : 'Sign in'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      sounds.click()
                      setMode('pick')
                      setError('')
                    }}
                    className="cursor-pointer px-2 py-1.5 text-xs text-blue-200 hover:text-white"
                  >
                    Back
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        </div>
      </div>
      <div className="flex h-14 items-center justify-between border-t border-blue-400/30 px-5">
        <p className="text-[11px] text-blue-200/80">
          After you sign in, the desktop is all yours.
        </p>
        <p className="hidden text-[11px] text-blue-200/80 sm:block">esc to power off</p>
      </div>
    </div>
  )
}
