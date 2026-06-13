import { useState } from 'react'
import { motion } from 'motion/react'
import { sounds } from './sounds'
import { authRequest } from './chatRooms'
import { AlejLogo } from './AlejLogo'
import { xpIcon } from './xpIcon'
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
  /** a real XP account picture from public/os/pictures */
  img: string
  title: string
  sub: string
  onClick: () => void
}

function Tile({ img, title, sub, onClick }: TileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full cursor-pointer items-center gap-3.5 px-3 py-2 text-left"
    >
      <span className="h-[54px] w-[54px] shrink-0 rounded-[4px] border border-white/50 bg-gradient-to-b from-white to-[#d8e2f8] p-[3px] shadow-[1px_1px_3px_rgba(0,0,30,0.4)] transition group-hover:border-white group-hover:shadow-[0_0_14px_rgba(255,233,160,0.7)]">
        <img
          src={img}
          alt=""
          width={48}
          height={48}
          draggable={false}
          className="h-full w-full rounded-[2px] select-none"
        />
      </span>
      <span className="min-w-0">
        <span className="font-xp block truncate text-[17px] font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)] transition group-hover:[text-shadow:0_0_10px_rgba(255,255,255,0.85)]">
          {title}
        </span>
        <span className="block text-[11px] text-blue-100/85">{sub}</span>
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
    <div className="flex h-full flex-col [font-family:Tahoma,Verdana,sans-serif]">
      <div
        className="h-12 sm:h-16"
        style={{ background: 'linear-gradient(180deg, #1c349f 0%, #0b2185 100%)' }}
      />
      <div
        className="h-[2px]"
        style={{
          background:
            'linear-gradient(90deg, rgba(166,202,255,0.95) 0%, rgba(222,236,255,0.9) 30%, rgba(166,202,255,0.4) 70%, rgba(166,202,255,0.1) 100%)',
        }}
      />

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-6"
        style={{ background: 'linear-gradient(180deg, #7396e8 0%, #5379d8 50%, #3f5ec2 100%)' }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 55% 55% at 50% 45%, rgba(255,255,255,0.16), transparent 70%), radial-gradient(ellipse 55% 40% at 16% 14%, rgba(255,255,255,0.22), transparent 70%)',
          }}
        />
        <div className="relative grid w-full max-w-2xl items-center gap-8 sm:grid-cols-[1fr_auto_1fr]">
          <div className="flex flex-col items-center sm:items-end">
            <div className="flex items-center gap-3">
              <AlejLogo size={64} />
              <p className="font-xp text-4xl leading-none font-semibold text-white">AlejOS</p>
            </div>
            <p className="font-xp mt-5 text-lg font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
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
            className="flex w-full max-w-xs flex-col gap-2 justify-self-center sm:justify-self-start"
          >
            {mode === 'pick' ? (
              <>
                {saved && (
                  <Tile
                    img={saved.admin ? '/os/pictures/chess.png' : '/os/pictures/ball.png'}
                    title={saved.name}
                    sub="click to sign back in"
                    onClick={() => enter(saved)}
                  />
                )}
                <Tile
                  img="/os/pictures/accounts.png"
                  title="Sign in or register"
                  sub="make a name for yourself"
                  onClick={() => {
                    sounds.click()
                    setError('')
                    setMode('signin')
                  }}
                />
                <Tile
                  img="/os/pictures/duck.png"
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

      <div
        className="h-[2px]"
        style={{
          background:
            'linear-gradient(90deg, #ffb142 0%, #f1922a 30%, rgba(241,146,42,0.35) 65%, rgba(241,146,42,0) 90%)',
        }}
      />
      <div
        className="flex h-14 items-center justify-between px-4 sm:h-[72px] sm:px-7"
        style={{ background: 'linear-gradient(180deg, #1c349f 0%, #0b2185 100%)' }}
      >
        <button
          type="button"
          onClick={onShutdown}
          className="group flex cursor-pointer items-center gap-2.5"
        >
          <span className="transition group-hover:brightness-110 group-hover:drop-shadow-[0_0_7px_rgba(255,190,120,0.65)]">
            {xpIcon('exit', 32)}
          </span>
          <span className="font-xp text-[15px] font-medium text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)]">
            Turn off computer
          </span>
        </button>
        <p className="hidden max-w-64 text-right text-[11px] leading-snug text-blue-100/85 sm:block">
          To look around without an account, click Guest.
        </p>
      </div>
    </div>
  )
}
