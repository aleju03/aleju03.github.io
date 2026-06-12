import { useState } from 'react'
import { motion } from 'motion/react'
import {
  CrownSimpleIcon,
  PowerIcon,
  UserCircleIcon,
  UserCirclePlusIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { sounds } from './sounds'
import { authRequest } from './chatRooms'
import { FlagLogo } from './FlagLogo'
import type { Session } from './osContext'

/*
  The AlejOS welcome screen, in the spirit of the XP login: dark blue bands
  top and bottom, a glowing divider, picture-frame tiles on the right. Real
  accounts live in the chat server's SQLite (register once, your name is
  yours in the chat rooms); Guest always works, server or no server. A
  previously signed-in user gets their tile back for one-click entry.
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

interface TileProps {
  icon: React.ReactNode
  frame: string
  title: string
  sub: string
  onClick: () => void
}

function Tile({ icon, frame, title, sub, onClick }: TileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-white/10"
    >
      <span
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-md border-2 border-white/60 bg-gradient-to-br text-white transition group-hover:border-white group-hover:shadow-[0_0_14px_rgba(255,255,255,0.45)] ${frame}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-semibold text-white">{title}</span>
        <span className="block text-[11px] text-blue-100/80">{sub}</span>
      </span>
    </button>
  )
}

interface LoginScreenProps {
  onLogin: (session: Session) => void
  onShutdown: () => void
}

export function LoginScreen({ onLogin, onShutdown }: LoginScreenProps) {
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
    <div className="flex h-full flex-col">
      <div
        className="h-12 sm:h-14"
        style={{ background: 'linear-gradient(180deg, #24409e 0%, #152c7f 100%)' }}
      />
      <div className="h-0.5 bg-gradient-to-r from-blue-200/90 via-blue-300/40 to-transparent" />

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-6"
        style={{ background: 'linear-gradient(180deg, #5e82e0 0%, #4868cd 55%, #3a55b8 100%)' }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 60% 45% at 20% 22%, rgba(255,255,255,0.25), transparent 70%)',
          }}
        />
        <div className="relative grid w-full max-w-2xl items-center gap-8 sm:grid-cols-[1fr_auto_1fr]">
          <div className="flex flex-col items-center sm:items-end">
            <div className="flex items-center gap-3">
              <FlagLogo size={64} />
              <div>
                <p className="text-[11px] font-medium tracking-wide text-blue-100/90">
                  AJU Systems
                </p>
                <p className="font-display text-4xl leading-none font-semibold text-white">
                  AlejOS
                </p>
              </div>
            </div>
            <p className="mt-5 text-sm text-blue-50 [text-shadow:0_1px_2px_rgba(0,0,0,0.3)]">
              To begin, click your user name
            </p>
          </div>

          <div
            aria-hidden
            className="hidden h-56 w-px bg-gradient-to-b from-transparent via-white/60 to-transparent sm:block"
          />

          <motion.div
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="flex w-full max-w-xs flex-col gap-1.5 justify-self-center sm:justify-self-start"
          >
            {mode === 'pick' ? (
              <>
                {saved && (
                  <Tile
                    icon={
                      saved.admin ? (
                        <CrownSimpleIcon size={28} weight="duotone" />
                      ) : (
                        <UserCircleIcon size={28} weight="duotone" />
                      )
                    }
                    frame="from-amber-300 to-orange-500"
                    title={saved.name}
                    sub="click to sign back in"
                    onClick={() => enter(saved)}
                  />
                )}
                <Tile
                  icon={<UserCirclePlusIcon size={28} weight="duotone" />}
                  frame="from-lime-300 to-green-600"
                  title="Sign in or register"
                  sub="make a name for yourself"
                  onClick={() => {
                    sounds.click()
                    setError('')
                    setMode('signin')
                  }}
                />
                <Tile
                  icon={<UserIcon size={28} weight="duotone" />}
                  frame="from-sky-300 to-blue-600"
                  title="Guest"
                  sub="just looking around"
                  onClick={() => enter({ kind: 'guest', name: 'guest' })}
                />
              </>
            ) : (
              <form onSubmit={submit} className="rounded-lg border border-white/25 bg-white/10 p-4">
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
                        mode === m ? 'bg-white/20 text-white' : 'text-blue-100 hover:text-white'
                      }`}
                    >
                      {m === 'signin' ? 'Sign in' : 'Register'}
                    </button>
                  ))}
                </div>
                <label className="block text-[11px] text-blue-100">
                  Username
                  <input
                    name="username"
                    autoFocus
                    data-no-focus-ring
                    autoCapitalize="off"
                    autoComplete="username"
                    spellCheck={false}
                    maxLength={20}
                    className="mt-1 w-full rounded-sm border border-white/25 bg-blue-950/40 px-2 py-1.5 text-sm text-white placeholder:text-blue-300/50"
                    placeholder={mode === 'register' ? 'a-z, 0-9, _ or -' : ''}
                  />
                </label>
                <label className="mt-2.5 block text-[11px] text-blue-100">
                  Password
                  <input
                    name="password"
                    type="password"
                    data-no-focus-ring
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    maxLength={100}
                    className="mt-1 w-full rounded-sm border border-white/25 bg-blue-950/40 px-2 py-1.5 text-sm text-white"
                  />
                </label>
                {error && <p className="mt-2 text-[11px] leading-snug text-amber-300">{error}</p>}
                {mode === 'register' && !error && (
                  <p className="mt-2 text-[11px] leading-snug text-blue-100/80">
                    Just a username and password, no email needed.
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
                    className="cursor-pointer px-2 py-1.5 text-xs text-blue-100 hover:text-white"
                  >
                    Back
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        </div>
      </div>

      <div className="h-0.5 bg-gradient-to-r from-orange-400/90 via-orange-300/40 to-transparent" />
      <div
        className="flex h-14 items-center justify-between px-4 sm:h-16 sm:px-6"
        style={{ background: 'linear-gradient(180deg, #2c4ab2 0%, #142a7c 100%)' }}
      >
        <button type="button" onClick={onShutdown} className="group flex cursor-pointer items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-white/40 bg-gradient-to-b from-[#f4885c] to-[#cf3a0e] text-white transition group-hover:brightness-110">
            <PowerIcon size={15} weight="bold" />
          </span>
          <span className="text-sm font-medium text-white">Turn off computer</span>
        </button>
        <p className="hidden max-w-56 text-right text-[11px] leading-snug text-blue-100/80 sm:block">
          After you sign in, the desktop is all yours.
        </p>
      </div>
    </div>
  )
}
