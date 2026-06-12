import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowSquareOutIcon,
  GithubLogoIcon,
  LinkedinLogoIcon,
  PowerIcon,
  SignOutIcon,
} from '@phosphor-icons/react'
import { github, linkedin } from '../../data/projects'
import { BOOT_OS_EVENT } from '../../events'
import { lockPageForOverlay } from '../../overlay'
import { APPS } from './apps'
import type { AppId } from './apps'
import { Window } from './Window'
import type { WinState } from './Window'
import { sounds } from './sounds'

/*
  AlejOS: the portfolio as an early-2000s desktop. Booted from the command
  palette or the terminal's `boot` command, drawn inside a CRT monitor bezel
  (plastic frame, scanlines, power LED) on larger screens. Esc shuts down,
  so the easter egg never traps anyone.
*/

type Phase = 'off' | 'boot' | 'on' | 'down'

const DESKTOP_APPS: AppId[] = ['projects', 'about', 'terminal', 'contact']

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(id)
  }, [])
  return (
    <time className="font-mono text-xs text-white tabular-nums">
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  )
}

interface DesktopIconProps {
  label: string
  glyph: React.ReactNode
  selected: boolean
  onSelect: () => void
  onOpen: () => void
}

// single click selects like a real desktop; double click (or tap, where
// there is no hover) opens
function DesktopIcon({ label, glyph, selected, onSelect, onOpen }: DesktopIconProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (window.matchMedia('(hover: none)').matches) onOpen()
        else sounds.click()
      }}
      onDoubleClick={onOpen}
      onFocus={onSelect}
      className={`flex w-24 cursor-pointer flex-col items-center gap-1 rounded-md p-2 ${
        selected ? 'bg-blue-700/30' : 'hover:bg-stone-950/10'
      }`}
    >
      <span className="text-stone-800 drop-shadow-sm [&_svg]:block">{glyph}</span>
      <span className="max-w-full truncate text-xs font-medium text-stone-800">{label}</span>
    </button>
  )
}

function BootScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-stone-950">
      <p className="font-display text-5xl font-semibold text-stone-100">
        Alej<span className="text-blue-500">OS</span>
      </p>
      <div className="mt-10 h-4 w-56 overflow-hidden rounded-sm border border-stone-700 p-0.5">
        <motion.div
          className="flex h-full gap-1"
          animate={{ x: [-44, 224] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: 'linear' }}
        >
          <span className="h-full w-3 rounded-[2px] bg-blue-500" />
          <span className="h-full w-3 rounded-[2px] bg-blue-500" />
          <span className="h-full w-3 rounded-[2px] bg-blue-500" />
        </motion.div>
      </div>
      <p className="mt-6 font-mono text-xs text-stone-500">starting alejos v1.0</p>
      <p className="absolute right-5 bottom-4 font-mono text-[11px] text-stone-600">esc to skip</p>
    </div>
  )
}

export default function AlejOS() {
  const [phase, setPhase] = useState<Phase>('off')
  const [wins, setWins] = useState<(WinState & { app: AppId })[]>([])
  const [activeId, setActiveId] = useState('')
  const [startOpen, setStartOpen] = useState(false)
  const [selected, setSelected] = useState<AppId | 'exit' | null>(null)
  const zRef = useRef(10)
  const openCountRef = useRef(0)
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const shutdown = () => {
    sounds.shutdown()
    setStartOpen(false)
    setPhase('down')
    setTimeout(() => {
      setWins([])
      setActiveId('')
      setSelected(null)
      openCountRef.current = 0
      setPhase('off')
    }, 1700)
  }

  useEffect(() => {
    const onBoot = () => {
      if (phaseRef.current !== 'off') return
      sounds.click()
      setPhase('boot')
    }
    window.addEventListener(BOOT_OS_EVENT, onBoot)
    return () => window.removeEventListener(BOOT_OS_EVENT, onBoot)
  }, [])

  useEffect(() => {
    if (phase !== 'boot') return
    const id = setTimeout(() => {
      setPhase('on')
      sounds.startup()
    }, 2600)
    return () => clearTimeout(id)
  }, [phase])

  useEffect(() => {
    if (phase === 'off') return
    const unlock = lockPageForOverlay()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (phaseRef.current === 'boot') {
        setPhase('on')
        sounds.startup()
      } else if (phaseRef.current === 'on') {
        if (startOpen) setStartOpen(false)
        else shutdown()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unlock()
      window.removeEventListener('keydown', onKey)
    }
  }, [phase, startOpen])

  const focusWin = (id: string) => {
    setActiveId(id)
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, z: ++zRef.current } : w)))
  }

  const openApp = (app: AppId) => {
    sounds.open()
    setStartOpen(false)
    setSelected(null)
    setWins((prev) => {
      const existing = prev.find((w) => w.app === app)
      if (existing) {
        return prev.map((w) =>
          w.app === app ? { ...w, minimized: false, z: ++zRef.current } : w,
        )
      }
      const def = APPS[app]
      const n = openCountRef.current++
      const small = window.innerWidth < 640
      return [
        ...prev,
        {
          id: app,
          app,
          title: def.title,
          icon: def.icon,
          x: 56 + (n % 5) * 36,
          y: 36 + (n % 5) * 30,
          w: Math.min(def.w, window.innerWidth - 40),
          h: Math.min(def.h, window.innerHeight - 140),
          z: ++zRef.current,
          minimized: false,
          maximized: small,
        },
      ]
    })
    setActiveId(app)
  }

  const closeWin = (id: string) => {
    sounds.close()
    setWins((prev) => prev.filter((w) => w.id !== id))
  }

  const patchWin = (id: string, patch: Partial<WinState>) =>
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)))

  const onTaskButton = (w: WinState & { app: AppId }) => {
    sounds.click()
    if (w.minimized || activeId !== w.id) {
      patchWin(w.id, { minimized: false })
      focusWin(w.id)
    } else {
      patchWin(w.id, { minimized: true })
    }
  }

  if (phase === 'off') return null

  const screen =
    phase === 'boot' ? (
      <BootScreen />
    ) : phase === 'down' ? (
      <div className="flex h-full items-center justify-center bg-stone-950 px-6">
        <p className="text-center font-mono text-sm text-stone-400">
          It is now safe to close this portfolio.
        </p>
      </div>
    ) : (
      <div className="relative h-full select-none">
        <img
          src="/os/wallpaper.webp"
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* desktop icons */}
        <div className="absolute top-3 left-3 flex flex-col gap-1.5">
          {DESKTOP_APPS.map((app) => (
            <DesktopIcon
              key={app}
              label={APPS[app].title.split(' — ')[0]}
              glyph={APPS[app].big}
              selected={selected === app}
              onSelect={() => setSelected(app)}
              onOpen={() => openApp(app)}
            />
          ))}
          <DesktopIcon
            label="Back to site"
            glyph={<SignOutIcon size={34} weight="duotone" />}
            selected={selected === 'exit'}
            onSelect={() => setSelected('exit')}
            onOpen={shutdown}
          />
        </div>

        {/* windows live between the icons and the taskbar; the layer itself
            must not eat desktop clicks */}
        <div className="pointer-events-none absolute inset-x-0 top-0 bottom-12">
          {wins.map((w) => (
            <Window
              key={w.id}
              win={w}
              active={activeId === w.id}
              onFocus={() => focusWin(w.id)}
              onClose={() => closeWin(w.id)}
              onMinimize={() => patchWin(w.id, { minimized: true })}
              onToggleMaximize={() => patchWin(w.id, { maximized: !w.maximized })}
              onMove={(x, y) => patchWin(w.id, { x, y })}
              onResize={(width, height) => patchWin(w.id, { w: width, h: height })}
            >
              {APPS[w.app].render(() => closeWin(w.id))}
            </Window>
          ))}
        </div>

        {/* start menu */}
        <AnimatePresence>
          {startOpen && (
            <>
              <button
                type="button"
                aria-label="Close start menu"
                onClick={() => setStartOpen(false)}
                className="absolute inset-0 cursor-default"
              />
              <motion.nav
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                aria-label="Start menu"
                className="absolute bottom-13 left-1.5 z-[5000] w-72 overflow-hidden rounded-lg border border-blue-900 bg-stone-50 shadow-2xl shadow-stone-950/50"
              >
                <div className="flex items-center gap-3 bg-gradient-to-b from-blue-600 to-blue-700 px-4 py-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-white/20 font-mono text-sm font-bold text-white">
                    aj
                  </span>
                  <p className="text-sm font-medium text-white">Alejandro Jiménez</p>
                </div>
                <ul className="p-1.5">
                  {DESKTOP_APPS.map((app) => (
                    <li key={app}>
                      <button
                        type="button"
                        onClick={() => openApp(app)}
                        className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                      >
                        <span className="text-blue-700 [&_svg]:size-5">{APPS[app].big}</span>
                        {APPS[app].title.split(' — ')[0]}
                      </button>
                    </li>
                  ))}
                  <li aria-hidden className="mx-3 my-1.5 border-t border-stone-200" />
                  {[
                    { label: 'GitHub', href: github, icon: <GithubLogoIcon size={18} /> },
                    { label: 'LinkedIn', href: linkedin, icon: <LinkedinLogoIcon size={18} /> },
                  ].map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-blue-600/10"
                      >
                        <span className="text-blue-700">{item.icon}</span>
                        {item.label}
                        <ArrowSquareOutIcon size={13} className="ml-auto text-stone-400" />
                      </a>
                    </li>
                  ))}
                  <li aria-hidden className="mx-3 my-1.5 border-t border-stone-200" />
                  <li>
                    <button
                      type="button"
                      onClick={shutdown}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                    >
                      <PowerIcon size={18} className="text-blue-700" />
                      Shut down
                    </button>
                  </li>
                </ul>
              </motion.nav>
            </>
          )}
        </AnimatePresence>

        {/* taskbar */}
        <div className="absolute inset-x-0 bottom-0 z-[4000] flex h-12 items-stretch border-t border-blue-500/60 bg-gradient-to-b from-blue-700 to-blue-800">
          <button
            type="button"
            aria-label="Start"
            onClick={() => {
              sounds.click()
              setStartOpen((o) => !o)
            }}
            className={`m-1.5 flex cursor-pointer items-center gap-2 rounded-md px-4 font-display text-sm font-semibold text-white transition-colors ${
              startOpen ? 'bg-white/30' : 'bg-white/15 hover:bg-white/25'
            }`}
          >
            <span className="flex size-5 items-center justify-center rounded-sm bg-white font-mono text-[11px] font-bold text-blue-700">
              aj
            </span>
            start
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1.5">
            {wins.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => onTaskButton(w)}
                className={`flex h-full min-w-0 max-w-44 cursor-pointer items-center gap-2 rounded-md px-3 text-xs text-white transition-colors ${
                  activeId === w.id && !w.minimized
                    ? 'bg-white/30 shadow-[inset_0_1px_3px_rgba(0,0,0,0.25)]'
                    : 'bg-white/10 hover:bg-white/20'
                }`}
              >
                <span className="shrink-0">{w.icon}</span>
                <span className="truncate">{w.title.split(' — ')[0]}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-l border-white/20 px-3">
            <Clock />
            <button
              type="button"
              onClick={shutdown}
              aria-label="Shut down AlejOS"
              className="cursor-pointer rounded-md p-1.5 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
            >
              <PowerIcon size={15} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[60] bg-stone-950 sm:p-4 lg:p-7"
    >
      {/* the CRT: plastic bezel, slightly curved-feeling screen, power LED */}
      <div className="flex h-full flex-col rounded-none sm:rounded-[26px] sm:bg-stone-300 sm:p-3 sm:shadow-[0_30px_80px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.6)] sm:dark:bg-stone-400">
        <div className="relative flex-1 overflow-hidden bg-stone-950 sm:rounded-lg">
          {screen}
          {/* scanlines + vignette sell the tube without hurting readability */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[9000] opacity-50"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, rgba(0,0,0,0.10) 0px, rgba(0,0,0,0.10) 1px, transparent 1px, transparent 3px)',
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[9000] shadow-[inset_0_0_110px_rgba(0,0,0,0.42)] sm:rounded-lg"
          />
        </div>
        <div className="hidden h-7 shrink-0 items-center justify-center gap-3 sm:flex">
          <span className="flex items-baseline gap-2 select-none">
            <span className="text-[11px] font-bold tracking-[0.08em] text-stone-500 italic">AJU</span>
            <span className="text-[10px] font-medium tracking-[0.3em] text-stone-500/70">700FD</span>
          </span>
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-blue-600 shadow-[0_0_6px_2px_rgba(37,99,235,0.55)]"
          />
        </div>
      </div>
    </motion.div>
  )
}
