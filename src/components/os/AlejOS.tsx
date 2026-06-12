import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowSquareOutIcon,
  CrownSimpleIcon,
  DesktopTowerIcon,
  GithubLogoIcon,
  LinkedinLogoIcon,
  PowerIcon,
  SignOutIcon,
  TrashIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { github, linkedin } from '../../data/projects'
import { BOOT_OS_EVENT } from '../../events'
import { lockPageForOverlay } from '../../overlay'
import { APPS, glyphFor, isAppId } from './apps'
import type { AppId } from './apps'
import { Window } from './Window'
import type { WinState } from './Window'
import { sounds } from './sounds'
import { getWallpaperId, subscribeWallpaper, wallpaperById } from './wallpapers'
import { BiosScreen } from './BiosScreen'
import { ScreenEffects } from './ScreenEffects'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { OsContext } from './osContext'
import type { OsApi, Session } from './osContext'
import { LoginScreen } from './LoginScreen'
import {
  DESKTOP,
  MY_COMPUTER,
  RECYCLE_BIN,
  createFolder,
  createTextFile,
  emptyRecycleBin,
  getFsVersion,
  getNode,
  joinPath,
  listDir,
  recycleBinCount,
  removeNode,
  renameNode,
  sortChildren,
  subscribeFs,
} from './fs'
import type { FsNode } from './fs'

/*
  AlejOS: the portfolio as an early-2000s desktop. Booted from the command
  palette, the terminal's `boot` command, or by visiting /alejOS directly —
  while it runs the address bar reads /alejOS so the session is shareable.
  POST, boot splash, then a welcome screen: register a real account (saved in
  the chat server's SQLite), sign back in, or enter as guest. The desktop is
  the filesystem: icons are C:\Desktop, Explorer walks the whole tree, and
  the right-click menu carries the full XP kit. On capable screens CrtScene
  maps the live DOM onto a 3D CRT; Esc always backs out.
*/

const CrtScene = lazy(() => import('./CrtScene'))

type Phase = 'off' | 'post' | 'boot' | 'login' | 'on' | 'down'
type Mode = 'flat' | '3d'

const OS_PATH = '/alejOS'
const isOsUrl = () => location.pathname.toLowerCase() === '/alejos'

const START_ITEMS: { app: AppId; label?: string; props?: Record<string, unknown> }[] = [
  { app: 'explorer', label: 'My Computer', props: { path: MY_COMPUTER } },
  { app: 'browser' },
  { app: 'chat' },
  { app: 'notepad' },
  { app: 'paint' },
  { app: 'minesweeper' },
  { app: 'terminal' },
  { app: 'display' },
]

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type OsWin = WinState & { app: AppId; props: Record<string, unknown> }

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
  id: string
  label: string
  glyph: React.ReactNode
  selected: boolean
  renaming?: boolean
  /** light wallpapers take dark text; everything else gets white + shadow */
  onLight: boolean
  onSelect: () => void
  onOpen: () => void
  onRename?: (next: string) => void
}

// single click selects like a real desktop; double click (or tap, where
// there is no hover) opens. data-icon makes the marquee hit-test find it.
function DesktopIcon({ id, label, glyph, selected, renaming, onLight, onSelect, onOpen, onRename }: DesktopIconProps) {
  const ink = onLight
    ? 'text-stone-800 drop-shadow-sm'
    : 'text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]'
  return (
    <button
      type="button"
      data-icon={id}
      onClick={() => {
        if (renaming) return
        if (window.matchMedia('(hover: none)').matches) onOpen()
        else {
          sounds.click()
          onSelect()
        }
      }}
      onDoubleClick={() => {
        if (!renaming) onOpen()
      }}
      onFocus={onSelect}
      className={`flex w-24 cursor-pointer flex-col items-center gap-1 rounded-md p-2 ${
        selected ? 'bg-blue-700/30' : onLight ? 'hover:bg-stone-950/10' : 'hover:bg-white/15'
      }`}
    >
      <span className={`${ink} [&_svg]:block`}>{glyph}</span>
      {renaming && onRename ? (
        <input
          autoFocus
          defaultValue={label}
          data-no-focus-ring
          aria-label="New name"
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename(e.currentTarget.value)
            if (e.key === 'Escape') onRename(label)
          }}
          onBlur={(e) => onRename(e.target.value)}
          className="w-full rounded-sm border border-blue-600 bg-white px-1 text-center text-xs text-stone-800"
        />
      ) : (
        <span className={`max-w-full truncate text-xs font-medium ${ink}`}>{label}</span>
      )}
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
      <p className="mt-6 font-mono text-xs text-stone-500">starting alejos v2.0</p>
      <p className="absolute right-5 bottom-4 font-mono text-[11px] text-stone-600">esc to skip</p>
    </div>
  )
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((v) => b.has(v))

export default function AlejOS() {
  const [phase, setPhase] = useState<Phase>('off')
  const [mode, setMode] = useState<Mode>('flat')
  const [downMsg, setDownMsg] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [wins, setWins] = useState<OsWin[]>([])
  const [activeId, setActiveId] = useState('')
  const [startOpen, setStartOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; icon: string | null } | null>(null)
  const [renamingIcon, setRenamingIcon] = useState<string | null>(null)
  const phaseRef = useRef(phase)
  const desktopRef = useRef<HTMLDivElement>(null)
  const marqueeOriginRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const wallpaper = wallpaperById(useSyncExternalStore(subscribeWallpaper, getWallpaperId))
  const onLightWallpaper = Boolean(wallpaper.light)
  useSyncExternalStore(subscribeFs, getFsVersion)
  const desktopNodes = listDir(DESKTOP)
  const binCount = recycleBinCount()

  const shutdown = useCallback(() => {
    sounds.shutdown()
    setStartOpen(false)
    setMenu(null)
    setDownMsg(false)
    setPhase('down')
    // the picture collapses to a bright line first, then the farewell text;
    // in 3D mode the camera also needs time to retreat from the glass
    setTimeout(() => setDownMsg(true), 650)
    setTimeout(
      () => {
        setWins([])
        setActiveId('')
        setSelected(new Set())
        setSession(null)
        setPhase('off')
        // hand the address bar back to the site
        if (isOsUrl()) history.pushState(null, '', '/')
      },
      mode === '3d' ? 2900 : 2200,
    )
  }, [mode])

  const boot = useCallback(() => {
    if (phaseRef.current !== 'off') return
    sounds.click()
    // the 3D session only where it can land: mouse, big screen, motion ok
    const fancy =
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      window.innerWidth >= 640
    setMode(fancy ? '3d' : 'flat')
    setPhase(fancy ? 'post' : 'boot')
    // make the session shareable: the OS owns /alejOS while it runs
    if (!isOsUrl()) history.pushState({ alejos: true }, '', OS_PATH)
  }, [])

  useEffect(() => {
    window.addEventListener(BOOT_OS_EVENT, boot)
    // deep link: landing on /alejOS boots straight into the machine
    if (isOsUrl()) boot()
    // browser navigation works like a power switch
    const onPop = () => {
      if (isOsUrl() && phaseRef.current === 'off') boot()
      else if (!isOsUrl() && phaseRef.current !== 'off' && phaseRef.current !== 'down') shutdown()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener(BOOT_OS_EVENT, boot)
      window.removeEventListener('popstate', onPop)
    }
  }, [boot, shutdown])

  useEffect(() => {
    if (phase !== 'post') return
    const id = setTimeout(() => setPhase('boot'), 2800)
    return () => clearTimeout(id)
  }, [phase])

  useEffect(() => {
    if (phase !== 'boot') return
    const id = setTimeout(() => setPhase('login'), 2600)
    return () => clearTimeout(id)
  }, [phase])

  useEffect(() => {
    if (phase === 'off') return
    const unlock = lockPageForOverlay()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (phaseRef.current === 'post') {
        setPhase('boot')
      } else if (phaseRef.current === 'boot') {
        setPhase('login')
      } else if (phaseRef.current === 'login') {
        shutdown()
      } else if (phaseRef.current === 'on') {
        if (startOpen) setStartOpen(false)
        else if (menu) setMenu(null)
        else shutdown()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unlock()
      window.removeEventListener('keydown', onKey)
    }
  }, [phase, startOpen, menu, shutdown])

  const topZ = (list: OsWin[]) => list.reduce((max, w) => Math.max(max, w.z), 10)

  const focusWin = (id: string) => {
    setActiveId(id)
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, z: topZ(prev) + 1 } : w)))
  }

  const patchWin = (id: string, patch: Partial<WinState>) =>
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)))

  const openApp = (app: AppId, props?: Record<string, unknown>) => {
    sounds.open()
    setStartOpen(false)
    setMenu(null)
    setSelected(new Set())
    const def = APPS[app]
    const existing = def.single ? wins.find((w) => w.app === app) : undefined
    if (existing) {
      setActiveId(existing.id)
      setWins((prev) =>
        prev.map((w) =>
          w.id === existing.id ? { ...w, minimized: false, z: topZ(prev) + 1 } : w,
        ),
      )
      return
    }
    const id = `${app}-${crypto.randomUUID().slice(0, 8)}`
    const small = window.innerWidth < 640
    setWins((prev) => {
      const n = prev.length
      const win: OsWin = {
        id,
        app,
        props: props ?? {},
        title: def.name,
        icon: def.glyph(15),
        x: 56 + (n % 5) * 36,
        y: 36 + (n % 5) * 30,
        w: Math.min(def.w, window.innerWidth - 40),
        h: Math.min(def.h, window.innerHeight - 140),
        z: topZ(prev) + 1,
        minimized: false,
        maximized: small,
      }
      return [...prev, win]
    })
    setActiveId(id)
  }

  const openPath = (path: string) => {
    if (path === MY_COMPUTER) {
      openApp('explorer', { path: MY_COMPUTER })
      return
    }
    const node = getNode(path)
    if (!node) return
    switch (node.kind) {
      case 'folder':
        openApp('explorer', { path })
        break
      case 'text':
        openApp('notepad', { path })
        break
      case 'image':
        openApp('viewer', { path })
        break
      case 'app':
        if (isAppId(node.app)) openApp(node.app, node.appProps)
        break
      case 'link':
        if (!node.url) break
        if (node.embed) openApp('browser', { url: node.url })
        else {
          sounds.open()
          window.open(node.url, '_blank', 'noreferrer')
        }
        break
    }
  }

  const closeWin = (id: string) => {
    sounds.close()
    setWins((prev) => prev.filter((w) => w.id !== id))
  }

  const setWinTitle = useCallback((id: string, title: string) => {
    setWins((prev) => {
      const w = prev.find((x) => x.id === id)
      if (!w || w.title === title) return prev
      return prev.map((x) => (x.id === id ? { ...x, title } : x))
    })
  }, [])

  const logOff = useCallback(() => {
    sounds.close()
    setWins([])
    setActiveId('')
    setStartOpen(false)
    setMenu(null)
    setSelected(new Set())
    setSession(null)
    setPhase('login')
  }, [])

  const osApi: OsApi = {
    session: session ?? { kind: 'guest', name: 'guest' },
    openApp: (app, props) => {
      if (isAppId(app)) openApp(app, props)
    },
    openPath,
    logOff,
    shutdown,
  }

  const onTaskButton = (w: OsWin) => {
    sounds.click()
    if (w.minimized || activeId !== w.id) {
      patchWin(w.id, { minimized: false })
      focusWin(w.id)
    } else {
      patchWin(w.id, { minimized: true })
    }
  }

  // --- desktop marquee selection (that blue thing) -------------------------
  const onDesktopPointerDown = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).closest('[data-desktop-bg]')) return
    setStartOpen(false)
    setMenu(null)
    setSelected(new Set())
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const root = desktopRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    marqueeOriginRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    root.setPointerCapture(e.pointerId)
  }

  const onDesktopPointerMove = (e: React.PointerEvent) => {
    const origin = marqueeOriginRef.current
    const root = desktopRef.current
    if (!origin || !root) return
    const rect = root.getBoundingClientRect()
    const cx = Math.min(Math.max(e.clientX - rect.left, 0), rect.width)
    const cy = Math.min(Math.max(e.clientY - rect.top, 0), rect.height)
    const m: Rect = {
      x: Math.min(origin.x, cx),
      y: Math.min(origin.y, cy),
      w: Math.abs(cx - origin.x),
      h: Math.abs(cy - origin.y),
    }
    setMarquee(m)
    const hits = new Set<string>()
    root.querySelectorAll<HTMLElement>('[data-icon]').forEach((node) => {
      const r = node.getBoundingClientRect()
      const left = r.left - rect.left
      const top = r.top - rect.top
      if (left < m.x + m.w && left + r.width > m.x && top < m.y + m.h && top + r.height > m.y) {
        hits.add(node.dataset.icon as string)
      }
    })
    setSelected((prev) => (sameSet(prev, hits) ? prev : hits))
  }

  const endMarquee = () => {
    marqueeOriginRef.current = null
    setMarquee(null)
  }

  const onDesktopContextMenu = (e: React.MouseEvent) => {
    const root = desktopRef.current
    if (!root) return
    const target = e.target as HTMLElement
    const iconEl = target.closest<HTMLElement>('[data-icon]')
    if (!iconEl && !target.closest('[data-desktop-bg]')) return
    e.preventDefault()
    const rect = root.getBoundingClientRect()
    setStartOpen(false)
    const icon = iconEl?.dataset.icon ?? null
    if (icon) setSelected(new Set([icon]))
    setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, icon })
  }

  const commitIconRename = (node: FsNode, next: string) => {
    setRenamingIcon(null)
    const clean = next.trim()
    if (!clean || clean === node.name) return
    const r = renameNode(joinPath(DESKTOP, node.name), clean)
    if (!r.ok) sounds.error()
  }

  // --- context menus --------------------------------------------------------
  const desktopMenuItems = (): MenuItem[] => [
    {
      label: 'Arrange Icons By',
      sub: [
        { label: 'Name', onClick: () => sortChildren(DESKTOP, 'name') },
        { label: 'Type', onClick: () => sortChildren(DESKTOP, 'type') },
        { label: 'Modified', onClick: () => sortChildren(DESKTOP, 'modified') },
      ],
    },
    { label: 'Refresh', onClick: () => sounds.click() },
    { divider: true },
    { label: 'Paste', disabled: true },
    { label: 'Paste Shortcut', disabled: true },
    { label: 'Undo Delete', disabled: true },
    { divider: true },
    {
      label: 'New',
      sub: [
        {
          label: 'Folder',
          onClick: () => {
            const r = createFolder(DESKTOP)
            if (r.ok) setRenamingIcon(`fs:${r.name}`)
          },
        },
        {
          label: 'Text Document',
          onClick: () => {
            const r = createTextFile(DESKTOP)
            if (r.ok) setRenamingIcon(`fs:${r.name}`)
          },
        },
      ],
    },
    { divider: true },
    { label: 'Properties', onClick: () => openApp('display') },
  ]

  const iconMenuItems = (icon: string): MenuItem[] => {
    if (icon === 'my-computer') {
      return [
        { label: 'Open', bold: true, onClick: () => openApp('explorer', { path: MY_COMPUTER }) },
        { divider: true },
        { label: 'Properties', onClick: () => openApp('display') },
      ]
    }
    if (icon === 'recycle-bin') {
      return [
        { label: 'Open', bold: true, onClick: () => openApp('explorer', { path: RECYCLE_BIN }) },
        { divider: true },
        {
          label: 'Empty Recycle Bin',
          disabled: binCount === 0,
          onClick: () => {
            sounds.close()
            emptyRecycleBin()
          },
        },
      ]
    }
    if (icon === 'exit') {
      return [{ label: 'Back to site', bold: true, onClick: shutdown }]
    }
    const name = icon.startsWith('fs:') ? icon.slice(3) : icon
    const node = desktopNodes.find((n) => n.name === name)
    if (!node) return []
    const full = joinPath(DESKTOP, node.name)
    return [
      { label: 'Open', bold: true, onClick: () => openPath(full) },
      { divider: true },
      { label: 'Rename', disabled: node.system, onClick: () => setRenamingIcon(icon) },
      {
        label: 'Delete',
        disabled: node.system,
        onClick: () => {
          const r = removeNode(full)
          if (!r.ok) sounds.error()
          else sounds.close()
        },
      },
    ]
  }

  if (phase === 'off') return null

  const desktop = (
    <div
      ref={desktopRef}
      className="relative h-full select-none"
      onPointerDown={onDesktopPointerDown}
      onPointerMove={onDesktopPointerMove}
      onPointerUp={endMarquee}
      onPointerCancel={endMarquee}
      onContextMenu={onDesktopContextMenu}
    >
      <div
        aria-hidden
        data-desktop-bg="true"
        className="absolute inset-0 bg-cover bg-center"
        style={
          wallpaper.src
            ? { backgroundImage: `url(${wallpaper.src})` }
            : { backgroundColor: wallpaper.color }
        }
      />

      {/* desktop icons: My Computer, then C:\Desktop, then the bin */}
      <div className="absolute top-3 left-3 flex flex-col flex-wrap gap-1.5" style={{ maxHeight: 'calc(100% - 4rem)' }}>
        <DesktopIcon
          id="my-computer"
          label="My Computer"
          glyph={<DesktopTowerIcon size={34} weight="duotone" />}
          selected={selected.has('my-computer')}
          onLight={onLightWallpaper}
          onSelect={() => setSelected(new Set(['my-computer']))}
          onOpen={() => openApp('explorer', { path: MY_COMPUTER })}
        />
        {desktopNodes.map((node) => {
          const id = `fs:${node.name}`
          return (
            <DesktopIcon
              key={id}
              id={id}
              label={node.name}
              glyph={glyphFor(node, 34)}
              selected={selected.has(id)}
              renaming={renamingIcon === id}
              onLight={onLightWallpaper}
              onSelect={() => setSelected(new Set([id]))}
              onOpen={() => openPath(joinPath(DESKTOP, node.name))}
              onRename={(next) => commitIconRename(node, next)}
            />
          )
        })}
        <DesktopIcon
          id="recycle-bin"
          label={binCount > 0 ? `Recycle Bin (${binCount})` : 'Recycle Bin'}
          glyph={<TrashIcon size={34} weight={binCount > 0 ? 'fill' : 'duotone'} />}
          selected={selected.has('recycle-bin')}
          onLight={onLightWallpaper}
          onSelect={() => setSelected(new Set(['recycle-bin']))}
          onOpen={() => openApp('explorer', { path: RECYCLE_BIN })}
        />
        <DesktopIcon
          id="exit"
          label="Back to site"
          glyph={<SignOutIcon size={34} weight="duotone" />}
          selected={selected.has('exit')}
          onLight={onLightWallpaper}
          onSelect={() => setSelected(new Set(['exit']))}
          onOpen={shutdown}
        />
      </div>

      {/* the marquee itself, under the windows like the real thing */}
      {marquee && marquee.w + marquee.h > 4 && (
        <div
          aria-hidden
          className="pointer-events-none absolute border border-blue-500 bg-blue-600/20"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

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
            {APPS[w.app].render({
              winId: w.id,
              props: w.props,
              close: () => closeWin(w.id),
              setTitle: (t) => setWinTitle(w.id, t),
            })}
          </Window>
        ))}
      </div>

      {/* right-click menus: the XP desktop kit, or the icon's own menu */}
      <AnimatePresence>
        {menu && (
          <ContextMenu
            items={menu.icon ? iconMenuItems(menu.icon) : desktopMenuItems()}
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
          />
        )}
      </AnimatePresence>

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
                  {session?.admin ? (
                    <CrownSimpleIcon size={18} weight="fill" />
                  ) : (
                    (session?.name ?? 'g').slice(0, 2)
                  )}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{session?.name ?? 'guest'}</p>
                  <p className="text-[11px] text-blue-100/80">
                    {session?.admin
                      ? 'administrator'
                      : session?.kind === 'user'
                        ? 'registered user'
                        : 'guest session'}
                  </p>
                </div>
              </div>
              <ul className="p-1.5">
                {START_ITEMS.map((item) => (
                  <li key={item.label ?? item.app}>
                    <button
                      type="button"
                      onClick={() => openApp(item.app, item.props)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                    >
                      <span className="text-blue-700 [&_svg]:size-5">
                        {item.label === 'My Computer' ? (
                          <DesktopTowerIcon size={20} weight="duotone" />
                        ) : (
                          APPS[item.app].glyph(20)
                        )}
                      </span>
                      {item.label ?? APPS[item.app].name}
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
                    onClick={logOff}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                  >
                    <UserIcon size={18} className="text-blue-700" />
                    Log off {session?.name ?? 'guest'}
                  </button>
                </li>
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
            setMenu(null)
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
              <span className="truncate">{w.title.split(' - ')[0]}</span>
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

  const screen =
    phase === 'post' ? (
      <BiosScreen />
    ) : phase === 'boot' ? (
      <BootScreen />
    ) : phase === 'login' ? (
      <LoginScreen
        onLogin={(s) => {
          setSession(s)
          setPhase('on')
        }}
      />
    ) : phase === 'down' ? (
      downMsg ? (
        <div className="flex h-full items-center justify-center bg-stone-950 px-6">
          <p className="text-center font-mono text-sm text-stone-400">
            It is now safe to close this portfolio.
          </p>
        </div>
      ) : (
        <div className="pointer-events-none h-full motion-safe:animate-[os-crt-off_0.6s_ease-in_forwards]">
          {desktop}
        </div>
      )
    ) : (
      desktop
    )

  // Chromium refuses to compositor-scroll DOM that lives under the CSS3D
  // perspective transform, so on the 3D screen we scroll by hand: walk up
  // from the wheel target to the nearest scrollable box and nudge it.
  const onScreenWheel = (e: React.WheelEvent) => {
    const step = e.deltaMode === 1 ? 16 : 1
    let el = e.target as HTMLElement | null
    while (el && el !== e.currentTarget) {
      const canY = el.scrollHeight > el.clientHeight + 1
      const canX = el.scrollWidth > el.clientWidth + 1
      if (canY || canX) {
        const style = getComputedStyle(el)
        const scrollsY = canY && (style.overflowY === 'auto' || style.overflowY === 'scroll')
        const scrollsX = canX && (style.overflowX === 'auto' || style.overflowX === 'scroll')
        if (scrollsY || scrollsX) {
          el.scrollBy({
            top: scrollsY ? e.deltaY * step : 0,
            left: scrollsX ? e.deltaX * step : 0,
          })
          return
        }
      }
      el = el.parentElement
    }
  }

  // 3D mode: the OS lives on the monitor glass inside the night-desk scene
  if (mode === '3d')
    return (
      <OsContext.Provider value={osApi}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[60] bg-stone-950"
        >
          <Suspense fallback={null}>
            <CrtScene off={phase === 'down'} onFail={() => setMode('flat')}>
              <div className="relative h-full w-full" onWheel={onScreenWheel}>
                {screen}
                <ScreenEffects />
              </div>
            </CrtScene>
          </Suspense>
        </motion.div>
      </OsContext.Provider>
    )

  return (
    <OsContext.Provider value={osApi}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-[60] bg-stone-950 sm:p-4 lg:p-7"
      >
        {/* the CRT: plastic bezel, slightly curved-feeling screen, power LED */}
        <div className="flex h-full flex-col rounded-none sm:rounded-[26px] sm:bg-stone-300 sm:p-3 sm:shadow-[0_30px_80px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.6)] sm:dark:bg-stone-400">
          <div className="relative flex-1 overflow-hidden bg-stone-950 sm:rounded-lg">
            {screen}
            {/* scanlines + beam + vignette sell the tube without hurting readability */}
            <ScreenEffects rounded />
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
    </OsContext.Provider>
  )
}
