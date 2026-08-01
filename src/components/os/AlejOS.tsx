import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  CaretLeftIcon,
  CaretRightIcon,
  CrownSimpleIcon,
  GithubLogoIcon,
  LinkedinLogoIcon,
  PlayIcon,
  PowerIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  SquaresFourIcon,
  UserIcon,
  XIcon,
} from '@phosphor-icons/react'
import { github, linkedin } from '../../data/projects'
import { BOOT_OS_EVENT, OS_SCENE_READY_EVENT, SESSION_EXPIRED_EVENT } from '../../events'
import {
  HOME_PATH,
  LEGACY_WORLD_PATH,
  OS_PATH,
  PC_PATH,
  WORLD_PATH,
  isOsPath,
  isPcPath,
  isWorldPath,
} from '../../version'
import { lockPageForOverlay } from '../../overlay'
import { setViewer, track } from '../../analytics'
import { APPS, glyphFor, isAppId } from './apps'
import { preloadImage, preloadXpIcons, xpIcon } from './xpIcon'
import type { XpIconName } from './xpIcon'
import type { AppId } from './apps'
import { Window } from './Window'
import type { WinState } from './Window'
import { getVolume, isMuted, setMuted, setVolume, sounds, subscribeVolume } from './sounds'
import { getWallpaperId, subscribeWallpaper, wallpaperById } from './wallpapers'
import {
  DEFAULT_OS_YEAR,
  MAX_OS_YEAR,
  MIN_OS_YEAR,
  getOsYear,
  osDate,
  setOsYear,
  subscribeOsYear,
} from './osYear'
import { BiosScreen } from './BiosScreen'
import { AlejLogo } from './AlejLogo'
import { ScreenEffects } from './ScreenEffects'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { OsContext } from './osContext'
import type { OsApi, OsTask, Session } from './osContext'
import { LoginScreen } from './LoginScreen'
import BootCover from './BootCover'
import StepOutCover from './StepOutCover'
import type { LoadStage } from './CrtScene'
import { DialogLayer, alertBox, closeAllDialogs, confirmBox } from './dialogs'
import { showProperties } from './PropertiesSheet'
import { showRunDialog } from './RunDialog'
import { ScreensaverLayer } from './Screensaver'
import {
  canPasteInto,
  clipCopy,
  clipCut,
  getClipboard,
  isCut,
  paste,
  subscribeClipboard,
} from './clipboard'
import {
  beginDrag,
  canDrop,
  dragLabel,
  dropTargetAt,
  endDrag as endDragStore,
  getDrag,
  performDrop,
  subscribeDrag,
  updateDrag,
} from './dnd'
import type { DragState } from './dnd'
import {
  DESKTOP,
  MY_COMPUTER,
  RECYCLE_BIN,
  baseName,
  createFolder,
  createShortcut,
  createTextFile,
  emptyRecycleBin,
  getFsVersion,
  getNode,
  joinPath,
  listDir,
  recycleBinCount,
  removeNode,
  renameNode,
  resolvePath,
  sortChildren,
  subscribeFs,
  undoLabel,
  undoLast,
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

  Two renderings, one desktop. The 3D one is the default where it can land,
  but a boot can ask for the flat bezel outright (`{ flat: true }` on the boot
  event, or the /pc route) — same OS, none of the three.js. `{ world: true }`
  (or /world) asks for the far end instead: the open world loaded up front,
  the machine already dark, entering at the 'room' phase and skipping the whole
  boot sequence. An ordinary 3D boot builds only the room; the planet past the
  front door streams in on demand if anyone actually opens that door.
  The request also picks which URL the session owns, so the three stay
  distinguishable on a reload or a trip through the back button: a device that
  merely fell back to flat still reads /alejOS, while someone who asked for
  the machine keeps a shareable /pc and someone who asked for the world keeps
  /world (each re-derived through isPcPath/isWorldPath on re-entry).
*/

const CrtScene = lazy(() => import('./CrtScene'))

type Phase = 'off' | 'post' | 'boot' | 'login' | 'on' | 'down' | 'room'
type Mode = 'flat' | '3d'

const isOsUrl = () => isOsPath()

const START_ITEMS: {
  app: AppId
  label?: string
  icon?: XpIconName
  props?: Record<string, unknown>
}[] = [
  { app: 'explorer', label: 'My Computer', icon: 'my-computer', props: { path: MY_COMPUTER } },
  { app: 'browser' },
  { app: 'chat' },
  { app: 'notepad' },
  { app: 'paint' },
  { app: 'explorer', label: 'Games', icon: 'games', props: { path: 'C:\\Desktop\\Games' } },
  { app: 'terminal' },
  { app: 'display' },
]

// Only the admin's Start menu carries these. Hiding them is presentation, not
// protection — the server refuses the reads themselves to anyone else.
const ADMIN_START_ITEMS: typeof START_ITEMS = [{ app: 'peeko', label: 'peeko site traffic' }]

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type OsWin = WinState & { app: AppId; props: Record<string, unknown> }

// the tray clock keeps real hours but lives in the pretend year (2003 by
// default, this machine's vintage), so the date line is the giveaway
function Clock({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [now, setNow] = useState(() => new Date())
  const year = useSyncExternalStore(subscribeOsYear, getOsYear)
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(id)
  }, [])
  const then = new Date(now)
  then.setFullYear(year)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Date and Time"
      aria-expanded={open}
      data-open={open}
      title={then.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })}
      className="cursor-pointer rounded-md px-1.5 py-0.5 text-right leading-tight transition-colors hover:bg-white/20 data-[open=true]:bg-white/20"
    >
      <time className="block font-mono text-xs text-white tabular-nums">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
      <span className="block font-mono text-[10px] text-white/75 tabular-nums">
        {then.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })}
      </span>
    </button>
  )
}

// the flyout the clock opens: Date and Time Properties, AlejOS edition. Only
// the year is up for grabs, and Internet Explorer time-travels along with it.
function ClockFlyout() {
  const year = useSyncExternalStore(subscribeOsYear, getOsYear)
  const then = osDate()
  const stepBtn =
    'flex size-7 cursor-pointer items-center justify-center rounded-sm border border-stone-400 bg-stone-200 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-40 disabled:hover:border-stone-400 disabled:hover:bg-stone-200'
  const pick = (y: number) => {
    sounds.click()
    setOsYear(y)
  }
  return (
    <>
      <div className="bg-gradient-to-b from-blue-600 to-blue-700 px-4 py-3">
        <p className="text-sm font-medium text-white">Date and Time</p>
        <p className="text-[11px] text-blue-100/80">
          {then.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      </div>
      <div className="p-4">
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            aria-label="Previous year"
            className={stepBtn}
            disabled={year <= MIN_OS_YEAR}
            onClick={() => pick(year - 1)}
          >
            <CaretLeftIcon size={13} weight="bold" />
          </button>
          <select
            value={year}
            aria-label="Year"
            onChange={(e) => pick(Number(e.target.value))}
            className="cursor-pointer appearance-none rounded-sm border border-stone-400 bg-white px-4 py-1 text-center font-mono text-lg text-stone-800 tabular-nums shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] hover:border-blue-600"
          >
            {Array.from({ length: MAX_OS_YEAR - MIN_OS_YEAR + 1 }, (_, i) => MAX_OS_YEAR - i).map(
              (y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ),
            )}
          </select>
          <button
            type="button"
            aria-label="Next year"
            className={stepBtn}
            disabled={year >= MAX_OS_YEAR}
            onClick={() => pick(year + 1)}
          >
            <CaretRightIcon size={13} weight="bold" />
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-stone-500">
          Internet Explorer follows this calendar and loads pages the way they looked back then.
        </p>
        {year !== DEFAULT_OS_YEAR && (
          <button
            type="button"
            onClick={() => pick(DEFAULT_OS_YEAR)}
            className="mx-auto mt-2 block cursor-pointer text-[11px] text-blue-700 underline-offset-2 hover:underline"
          >
            Take me back to {DEFAULT_OS_YEAR}
          </button>
        )}
      </div>
    </>
  )
}

// --- the tray volume --------------------------------------------------------
// XP's volume flyout is a narrow raised panel with a *vertical* trackbar: a
// sunken groove, a wide short thumb with a green grip in it, and a square
// Mute checkbox under it. None of that is an <input type="range">, and trying
// to make one into it is a losing fight — the vendor pseudo-elements that
// style a native slider disagree across engines about which axis is which
// once the writing mode is vertical, and the look is the entire point of this
// control. So it is drawn, and the keyboard contract (arrows, page, home/end)
// is rebuilt by hand on a role="slider".

const VOL_TRACK_H = 96
const VOL_THUMB_H = 11

function VolumeFlyout() {
  const level = useSyncExternalStore(subscribeVolume, getVolume)
  const muted = useSyncExternalStore(subscribeVolume, isMuted)
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const value = muted ? 0 : level

  /*
    Read the pointer as a fraction of the groove's own bounding rect rather
    than converting through the desktop's scale: both numbers are in client
    space, so whatever the CRT is doing to the screen DOM cancels out.
  */
  const setFromPointer = (clientY: number) => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const thumb = (VOL_THUMB_H * r.height) / VOL_TRACK_H
    const travel = Math.max(1, r.height - thumb)
    const t = 1 - (clientY - r.top - thumb / 2) / travel
    setVolume(Math.min(1, Math.max(0, t)))
  }

  const nudge = (by: number) => setVolume(Math.min(1, Math.max(0, value + by)))

  return (
    <div className="flex w-[86px] flex-col items-center border border-[#8d8b7c] bg-[#ece9d8] px-2 py-2.5 shadow-[0_8px_20px_rgba(0,0,0,0.4),inset_1px_1px_0_rgba(255,255,255,0.85)]">
      <p className="text-[11px] text-[#1b1b1b]">Volume</p>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        data-no-focus-ring
        style={{ height: VOL_TRACK_H, width: 24 }}
        className="relative my-2.5 cursor-pointer touch-none outline-none"
        onPointerDown={(e) => {
          draggingRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          setFromPointer(e.clientY)
        }}
        onPointerMove={(e) => draggingRef.current && setFromPointer(e.clientY)}
        onPointerUp={() => {
          draggingRef.current = false
          // the click you hear is the level you just set, which is the only
          // honest preview a volume control can give
          sounds.click()
        }}
        onPointerCancel={() => (draggingRef.current = false)}
        onKeyDown={(e) => {
          const step =
            e.key === 'PageUp' || e.key === 'PageDown' ? 0.2 : 0.05
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp') {
            e.preventDefault()
            nudge(step)
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown') {
            e.preventDefault()
            nudge(-step)
          } else if (e.key === 'Home') {
            e.preventDefault()
            setVolume(1)
          } else if (e.key === 'End') {
            e.preventDefault()
            setVolume(0)
          }
        }}
      >
        {/* the sunken groove */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-[4px] -translate-x-1/2 bg-[#dedbcb] shadow-[inset_1px_1px_0_#83816f,inset_-1px_-1px_0_#ffffff]"
        />
        {/* the Luna thumb: light bevelled block, green grip through the middle */}
        <span
          aria-hidden
          style={{
            top: (1 - value) * (VOL_TRACK_H - VOL_THUMB_H),
            width: 21,
            height: VOL_THUMB_H,
          }}
          className="absolute left-1/2 -translate-x-1/2 rounded-[2px] border border-[#6f6d5e] bg-gradient-to-b from-[#fefefa] to-[#cbc8b6] shadow-[inset_0_1px_0_#ffffff]"
        >
          <span className="absolute inset-x-[3px] top-[3px] h-[3px] rounded-[1px] bg-gradient-to-b from-[#b9ef88] to-[#3d8c1c]" />
        </span>
      </div>

      <button
        type="button"
        role="checkbox"
        aria-checked={muted}
        onClick={() => {
          setMuted(!muted)
          if (muted) sounds.click()
        }}
        className="flex w-full cursor-pointer items-center gap-1.5"
      >
        <span className="flex size-[13px] shrink-0 items-center justify-center border border-[#7f9db9] bg-white shadow-[inset_1px_1px_1px_rgba(0,0,0,0.14)]">
          {muted && (
            <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
              <path
                d="M1 4.5 L3.4 7 L8 1.8"
                fill="none"
                stroke="#14520f"
                strokeWidth="1.7"
                strokeLinecap="square"
              />
            </svg>
          )}
        </span>
        <span className="text-[11px] text-[#1b1b1b]">Mute</span>
      </button>
    </div>
  )
}

// --- the desktop icon grid ---------------------------------------------------
// icons live on Windows-style cells: column-major flow by default, but any
// icon can be dragged to a new cell and the arrangement sticks (localStorage).
interface Cell {
  col: number
  row: number
}

const ICON_POS_KEY = 'alejos-icon-pos'
// the desktop's welcome tip is shown once per browser, ever
const TIP_KEY = 'alejos-tip-seen'
const CELL_W = 102
const CELL_H = 78
const GRID_PAD = 12
// narrow screens shrink cells down to this so the columns that visibly fit
// actually exist (a 390px phone packs four columns instead of three)
const MIN_CELL_W = 84

const isCell = (value: unknown): value is Cell => {
  if (!value || typeof value !== 'object') return false
  const { col, row } = value as Partial<Cell>
  return (
    typeof col === 'number' &&
    typeof row === 'number' &&
    Number.isInteger(col) &&
    Number.isInteger(row) &&
    col >= 0 &&
    row >= 0
  )
}

const cleanIconPos = (value: unknown): Record<string, Cell> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, Cell> = {}
  for (const [id, cell] of Object.entries(value)) {
    if (isCell(cell)) out[id] = { col: cell.col, row: cell.row }
  }
  return out
}

const loadIconPos = (): Record<string, Cell> => {
  try {
    return cleanIconPos(JSON.parse(localStorage.getItem(ICON_POS_KEY) ?? '{}'))
  } catch {
    return {}
  }
}

const saveIconPos = (positions: Record<string, Cell>) => {
  try {
    localStorage.setItem(ICON_POS_KEY, JSON.stringify(positions))
  } catch {
    /* storage unavailable; the arrangement still works in memory */
  }
}

/** stored cells win (first come keeps the spot); the rest flow down the columns */
function layoutIcons(
  ids: string[],
  placed: Record<string, Cell>,
  cols: number,
  rows: number,
): Record<string, Cell> {
  const out: Record<string, Cell> = {}
  const taken = new Set<string>()
  const key = (c: Cell) => `${c.col},${c.row}`
  for (const id of ids) {
    const p = placed[id]
    if (p && p.col >= 0 && p.row >= 0 && p.col < cols && p.row < rows && !taken.has(key(p))) {
      out[id] = p
      taken.add(key(p))
    }
  }
  let slot = 0
  for (const id of ids) {
    if (out[id]) continue
    while (taken.has(`${Math.floor(slot / rows)},${slot % rows}`)) slot++
    const c = { col: Math.floor(slot / rows), row: slot % rows }
    out[id] = c
    taken.add(key(c))
    slot++
  }
  return out
}

interface DesktopIconProps {
  id: string
  label: string
  glyph: React.ReactNode
  cell: Cell
  /** cell width in px; narrow screens pack tighter than CELL_W */
  cw: number
  selected: boolean
  renaming?: boolean
  /** light wallpapers use darker hover treatment; labels keep XP-style contrast */
  onLight: boolean
  /** where a drop on this icon goes: a folder's path, or the bin */
  dropPath?: string
  /** something droppable is hovering over it right now */
  dropLit?: boolean
  /** marked by a cut and waiting for a paste */
  dimmed?: boolean
  /** the files this icon carries when dragged; empty means it only repositions */
  dragPaths?: string[]
  onSelect: () => void
  onOpen: () => void
  onRename?: (next: string) => void
  /**
   * Let go. dx/dy are the pixel delta from the icon's resting cell, target is
   * the drop target under the pointer — the desktop decides between the two,
   * because that decision is the whole gesture: over open desktop this is a
   * reposition, over a folder or the bin it is a file move.
   */
  onDragEnd: (dx: number, dy: number, target: string | null, copy: boolean) => void
}

// single click selects like a real desktop; double click (or tap, where
// there is no hover) opens. data-icon makes the marquee hit-test find it.
// holding and moving past a small threshold picks the icon up instead.
function DesktopIcon({
  id,
  label,
  glyph,
  cell,
  cw,
  selected,
  renaming,
  onLight,
  dropPath,
  dropLit,
  dimmed,
  dragPaths,
  onSelect,
  onOpen,
  onRename,
  onDragEnd,
}: DesktopIconProps) {
  const dragRef = useRef<{ px: number; py: number; scale: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [lift, setLift] = useState<{ x: number; y: number } | null>(null)
  const carries = dragPaths ?? []

  type Drag = NonNullable<typeof dragRef.current>
  const localDelta = (d: Drag, e: React.PointerEvent) => ({
    x: (e.clientX - d.px) / d.scale,
    y: (e.clientY - d.py) / d.scale,
  })

  const startDrag = (e: React.PointerEvent) => {
    if (renaming || e.button !== 0) return
    // the 3D CRT scales the screen DOM, so client px ≠ desktop px
    const el = e.currentTarget as HTMLElement
    const scale = el.getBoundingClientRect().width / el.offsetWidth || 1
    dragRef.current = { px: e.clientX, py: e.clientY, scale, moved: false }
    el.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const { x, y } = localDelta(d, e)
    if (!d.moved && Math.hypot(x, y) < 5) return
    if (!d.moved && carries.length) {
      // the icon itself is the drag image here, so no ghost is asked for
      beginDrag(carries, e.clientX, e.clientY, { ghost: false })
    }
    d.moved = true
    setLift({ x, y })
    if (carries.length) {
      updateDrag(e.clientX, e.clientY, dropTargetAt(e.clientX, e.clientY), e.ctrlKey)
    }
  }
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    setLift(null)
    if (d?.moved) {
      const { x, y } = localDelta(d, e)
      const target = carries.length ? dropTargetAt(e.clientX, e.clientY) : null
      endDragStore()
      onDragEnd(x, y, target, e.ctrlKey)
      suppressClick.current = true
    }
  }

  const ink = 'text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.85)]'
  return (
    <button
      type="button"
      data-icon={id}
      {...(dropPath ? { 'data-drop-path': dropPath } : {})}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
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
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        left: GRID_PAD + cell.col * cw,
        top: GRID_PAD + cell.row * CELL_H,
        width: cw - 6,
        // a lifted icon must not be hit-testable, or it would be the thing
        // elementFromPoint finds under the cursor instead of the drop target
        ...(lift && {
          transform: `translate(${lift.x}px, ${lift.y}px)`,
          zIndex: 3000,
          pointerEvents: 'none' as const,
        }),
      }}
      className={`pointer-events-auto absolute flex cursor-pointer touch-none flex-col items-center gap-1 rounded-md p-2 ${
        lift ? 'opacity-75' : ''
      } ${dimmed ? 'opacity-50' : ''} ${
        dropLit
          ? 'bg-blue-500/40 ring-2 ring-blue-300'
          : selected
            ? 'bg-blue-700/30'
            : onLight
              ? 'hover:bg-stone-950/10'
              : 'hover:bg-white/15'
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
    <div className="relative flex h-full flex-col items-center justify-center bg-black">
      <div>
        <AlejLogo size={88} className="mx-auto" />
        <p className="font-xp mt-1 text-[44px] leading-none font-semibold text-white">AlejOS</p>
      </div>
      <div className="mt-16 h-[15px] w-48 rounded-[4px] border border-[#b5b5b5] p-[2px] shadow-[0_0_3px_rgba(180,200,255,0.35)]">
        <div className="h-full overflow-hidden rounded-[1px]">
          <motion.div
            className="flex h-full gap-[2px]"
            animate={{ x: [-32, 192] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-full w-2 shrink-0 rounded-[1px]"
                style={{
                  background:
                    'linear-gradient(180deg, #9cb8f8 0%, #5f7ff2 30%, #2e4fd8 60%, #2138b8 100%)',
                }}
              />
            ))}
          </motion.div>
        </div>
      </div>
      <p className="absolute bottom-4 left-5 text-[11px] text-stone-400 [font-family:Tahoma,Verdana,sans-serif]">
        Copyright © 2003 AJU Corporation
      </p>
      <p className="absolute right-5 bottom-4 font-mono text-[11px] text-stone-600">esc to skip</p>
    </div>
  )
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((v) => b.has(v))

/**
 * The thing under the cursor mid-drag. XP dragged a translucent copy of the
 * icon with a count badge when there were several, and the badge is what
 * makes a multi-file drag legible — four icons stacked under a cursor read
 * as one icon that failed to render.
 */
function DragGhost({
  drag,
  toLocal,
}: {
  drag: DragState
  toLocal: (x: number, y: number) => { x: number; y: number }
}) {
  const at = toLocal(drag.x, drag.y)
  const head = getNode(drag.paths[0])
  return (
    <div
      aria-hidden
      style={{ left: at.x + 12, top: at.y + 10 }}
      className="pointer-events-none absolute z-[8000] flex max-w-52 items-center gap-1.5 rounded-md border border-blue-300/60 bg-blue-900/70 px-2 py-1 opacity-90 shadow-lg backdrop-blur-[1px]"
    >
      <span className="shrink-0 [&_img]:block">{glyphFor(head, 18)}</span>
      <span className="truncate text-[11px] font-medium text-white">
        {dragLabel(drag.paths)}
      </span>
      {drag.copy && (
        <span className="shrink-0 rounded-[3px] bg-white px-1 text-[10px] font-bold text-blue-800">
          +
        </span>
      )}
    </div>
  )
}

export default function AlejOS({
  initialBoot,
  onPowerOff,
}: {
  initialBoot?: { detail?: unknown }
  /** the OS gave the address bar back to the site; /pc uses this to bow out */
  onPowerOff?: () => void
}) {
  const [phase, setPhase] = useState<Phase>('off')
  const [mode, setMode] = useState<Mode>('flat')
  // how far the 3D boot has got, for the cover over it (null once the first
  // frame is up). Only CrtScene ever writes it
  const [loadStage, setLoadStage] = useState<LoadStage | null>('models')
  // There can be more than one load now: the boot builds only the room, and
  // walking out of the front door pulls the open world in behind the same
  // cover. BootCover unmounts for good at the end of a run, so each run gets a
  // fresh key instead — counted here, where the transition is actually visible,
  // rather than by asking the cover to notice it went backwards.
  const [loadRun, setLoadRun] = useState(0)
  const prevStageRef = useRef<LoadStage | null>('models')
  const onLoadStage = useCallback((stage: LoadStage | null) => {
    if (stage !== null && prevStageRef.current === null) setLoadRun((n) => n + 1)
    prevStageRef.current = stage
    setLoadStage(stage)
  }, [])
  // standing up mid-session: the OS keeps running and the tube stays lit
  // while you walk the room; sitting back down resumes where you left off
  const [away, setAway] = useState(false)
  const [downMsg, setDownMsg] = useState(false)
  // the screen the shutdown started from, so the CRT-off collapse plays over
  // what was actually showing (turning off at login must not flash the desktop)
  const [downFrom, setDownFrom] = useState<Phase>('on')
  const [session, setSession] = useState<Session | null>(null)
  // why the login screen is up, when it is up for a reason the visitor did not
  // choose: an expired session hands back the welcome screen, and doing that
  // without a word is what makes it read as "it logged me out for no reason"
  const [loginNotice, setLoginNotice] = useState('')
  const [wins, setWins] = useState<OsWin[]>([])
  const [activeId, setActiveId] = useState('')
  const [startOpen, setStartOpen] = useState(false)
  const [clockOpen, setClockOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  // the tray balloon, once per session: it is where the desktop tells a
  // first-time visitor that the files on it are actually draggable
  const [balloon, setBalloon] = useState(false)
  // Alt+Tab: null when the switcher is down, otherwise the highlighted index
  const [switcher, setSwitcher] = useState<number | null>(null)
  const [taskMenu, setTaskMenu] = useState<{ x: number; y: number; win: string | null } | null>(null)
  // which windows Show Desktop took down, so pressing it again puts back
  // those and only those
  const [hiddenByShowDesktop, setHiddenByShowDesktop] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; icon: string | null } | null>(null)
  const [renamingIcon, setRenamingIcon] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [desktopReady, setDesktopReady] = useState(false)
  const [iconPos, setIconPos] = useState<Record<string, Cell>>(loadIconPos)
  // the icon grid, plus the desktop's own size — Cascade and Tile need the
  // stage in pixels, and this effect is already measuring it
  const [grid, setGrid] = useState({ cols: 8, rows: 8, cw: CELL_W, w: 900, h: 600 })
  // true when this boot was the wreck swallowing the hero's paper plane:
  // the 3D room lays the dart on the bedroom rug as the other end of the trip
  const [planeInRoom, setPlaneInRoom] = useState(false)
  const phaseRef = useRef(phase)
  const awayRef = useRef(away)
  const pendingAppRef = useRef<AppId | null>(null)
  const desktopRef = useRef<HTMLDivElement>(null)
  const marqueeOriginRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    phaseRef.current = phase
    awayRef.current = away
  }, [phase, away])

  const wallpaper = wallpaperById(useSyncExternalStore(subscribeWallpaper, getWallpaperId))

  // warm everything the desktop's first frame needs: the icon set and the
  // wallpaper. without the wallpaper the boot splash would hand off to a
  // black desktop for the moment the background image spends in flight.
  const warmDesktop = useCallback(() => {
    void Promise.all([
      preloadXpIcons(),
      wallpaper.src ? preloadImage(wallpaper.src) : Promise.resolve(),
    ]).then(() => setDesktopReady(true))
  }, [wallpaper.src])
  const onLightWallpaper = Boolean(wallpaper.light)
  useSyncExternalStore(subscribeFs, getFsVersion)
  const clip = useSyncExternalStore(subscribeClipboard, getClipboard)
  const drag = useSyncExternalStore(subscribeDrag, getDrag)
  const volume = useSyncExternalStore(subscribeVolume, getVolume)
  const muted = useSyncExternalStore(subscribeVolume, isMuted)
  const desktopNodes = listDir(DESKTOP)
  const binCount = recycleBinCount()

  // how many icon cells fit on this screen; re-measured when the CRT resizes
  useLayoutEffect(() => {
    if (phase !== 'on' || !desktopReady) return
    const el = desktopRef.current
    if (!el) return
    const measure = () => {
      const avail = el.clientWidth - GRID_PAD
      // As many columns as the width can actually hold. Flooring at the
      // nominal cell width throws the remainder away, and the remainder is
      // usually most of a column: a 1320px desktop kept 12 columns and left
      // an 84px strip down the right that no icon could be dropped into,
      // because moveIcon clamps to cols - 1. So take the extra column
      // whenever there is any leftover, then divide the width between them,
      // and only fall back when that would squeeze cells under MIN_CELL_W
      // (which is what keeps a 390px phone at four columns).
      const most = Math.max(1, Math.floor(avail / MIN_CELL_W))
      const cols = Math.min(most, Math.max(1, Math.ceil(avail / CELL_W)))
      setGrid({
        cols,
        // leave the taskbar (h-12) plus a little breathing room at the bottom
        rows: Math.max(1, Math.floor((el.clientHeight - GRID_PAD - 56) / CELL_H)),
        cw: Math.min(CELL_W, Math.floor(avail / cols)),
        w: el.clientWidth,
        h: el.clientHeight,
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [phase, desktopReady])

  const iconIds = [
    'my-computer',
    ...desktopNodes.map((n) => `fs:${n.name}`),
    'recycle-bin',
    'exit',
  ]
  const iconCells = layoutIcons(iconIds, iconPos, grid.cols, grid.rows)

  const commitIconPos = (next: Record<string, Cell>) => {
    saveIconPos(next)
    setIconPos(next)
  }

  const moveIcon = (id: string, dx: number, dy: number) => {
    const from = iconCells[id]
    const col = Math.min(grid.cols - 1, Math.max(0, Math.round(from.col + dx / grid.cw)))
    const row = Math.min(grid.rows - 1, Math.max(0, Math.round(from.row + dy / CELL_H)))
    if (col === from.col && row === from.row) return
    // freeze the whole current layout, then swap with whoever holds the cell
    const next = { ...iconCells }
    const occupant = iconIds.find((k) => k !== id && next[k].col === col && next[k].row === row)
    if (occupant) next[occupant] = from
    next[id] = { col, row }
    commitIconPos(next)
    sounds.click()
  }

  // --- the desktop as a folder ---------------------------------------------
  // Everything below treats C:\Desktop as what it is: a directory whose icons
  // happen to be laid out on a grid. The same clipboard, the same drag store
  // and the same undo history Explorer uses, so a file cut in a window really
  // does paste out here.

  /** fs paths behind the current selection; My Computer and the bin drop out */
  const selectedPaths = (): string[] =>
    [...selected].filter((id) => id.startsWith('fs:')).map((id) => joinPath(DESKTOP, id.slice(3)))

  /** what a drag from this icon carries: the whole selection if it is in it */
  const dragPathsFor = (id: string): string[] => {
    if (!id.startsWith('fs:')) return []
    const own = joinPath(DESKTOP, id.slice(3))
    const sel = selectedPaths()
    return selected.has(id) && sel.length > 1 ? sel : [own]
  }

  /**
   * Where a drop on this icon goes. A folder swallows it; anything else
   * hands it to the desktop behind it, because the icons cover most of the
   * left edge of the screen and "you missed the gap between two icons" is
   * not a thing a desktop should ever say. Dropping a desktop file onto
   * another desktop file therefore resolves to a same-folder move, which
   * canDrop rejects, which is what makes it fall through to a reposition.
   */
  const dropPathFor = (node: FsNode): string =>
    node.kind === 'folder' ? joinPath(DESKTOP, node.name) : DESKTOP

  const dropLit = (target: string | undefined) =>
    Boolean(target && drag.active && drag.over === target && canDrop(drag.paths, target))

  /**
   * Let go of an icon. Over open desktop this is a reposition on the grid;
   * over a folder, the bin or an open Explorer window it is a file move, and
   * canDrop is what tells the two apart — a file dropped back on the desktop
   * it already lives on is not a move, so it falls through to the grid.
   */
  const onIconDragEnd = (id: string, dx: number, dy: number, target: string | null, copy: boolean) => {
    const paths = dragPathsFor(id)
    if (target && paths.length && canDrop(paths, target)) {
      const r = performDrop(paths, target, copy)
      if (r.error) void alertBox('Move', r.error)
      else if (r.done) {
        sounds.open()
        setSelected(new Set())
      }
      return
    }
    moveIcon(id, dx, dy)
  }

  /**
   * The backstop. Every drag source settles its own drop (the icons here,
   * the items in Explorer), and their pointerup bubbles through this handler
   * with the store already cleared — so this normally does nothing. It exists
   * for the one case they cannot cover: a source that is unmounted mid-drag,
   * whose pointer never comes back up anywhere it can be heard, which would
   * otherwise leave a ghost stuck to the cursor for the rest of the session.
   */
  const onDesktopDrop = (e: React.PointerEvent) => {
    const d = getDrag()
    if (!d.active) return
    const target = dropTargetAt(e.clientX, e.clientY)
    endDragStore()
    if (target !== DESKTOP || !canDrop(d.paths, DESKTOP)) return
    const r = performDrop(d.paths, DESKTOP, e.ctrlKey)
    if (r.error) void alertBox('Move', r.error)
    else if (r.done) sounds.open()
  }

  const deleteSelection = async () => {
    const paths = selectedPaths()
    if (paths.length === 0) return
    const nodes = paths.map((p) => getNode(p)).filter(Boolean) as FsNode[]
    const blocked = nodes.find((n) => n.system)
    if (blocked) {
      void alertBox('Delete File', `${blocked.name} ships with AlejOS and cannot be deleted.`, 'warn')
      return
    }
    const what = paths.length === 1 ? `'${baseName(paths[0])}'` : `these ${paths.length} items`
    if (!(await confirmBox('Confirm Delete', `Are you sure you want to send ${what} to the Recycle Bin?`)))
      return
    sounds.close()
    for (const p of paths) {
      const r = removeNode(p)
      if (!r.ok) void alertBox('Delete File', r.error)
    }
    setSelected(new Set())
  }

  const pasteToDesktop = () => {
    const r = paste(DESKTOP)
    if (r.error) void alertBox('Paste', r.error)
    else if (r.done) sounds.open()
  }

  const undoOnDesktop = () => {
    if (undoLast()) sounds.click()
  }

  /**
   * The machine is off for good: hand the address bar back to the site. On
   * /pc there is no site mounted underneath to hand it to, so the host is
   * told to swap the portfolio in where the desktop was.
   */
  const returnToSite = useCallback(() => {
    if (isOsUrl()) history.pushState(null, '', HOME_PATH)
    onPowerOff?.()
  }, [onPowerOff])

  /** power off; in 3D mode the room stays up to roam unless toSite is set */
  const shutdown = useCallback(
    (toSite = false) => {
      sounds.shutdown()
      setDownFrom(phase)
      setStartOpen(false)
      setMenu(null)
      setTaskMenu(null)
      closeAllDialogs()
      setDownMsg(false)
      setPhase('down')
      // the picture collapses to a bright line first, then the farewell text;
      // in 3D mode the camera retreat from the glass lands at ~2.1s, and the
      // room phase must take over right then — any later is dead air spent
      // staring at a frozen frame before the stand-up glide begins
      setTimeout(() => setDownMsg(true), 650)
      setTimeout(
        () => {
          setWins([])
          setActiveId('')
          setSelected(new Set())
          setSession(null)
          if (mode === '3d' && !toSite) {
            // the machine is dark but the room is still there: walk it
            setPhase('room')
          } else {
            setPhase('off')
            returnToSite()
          }
        },
        mode === '3d' ? 2150 : 2200,
      )
    },
    [mode, phase, returnToSite],
  )

  /** interacted with the dark machine while roaming: boot it again */
  const wake = useCallback(() => {
    if (phaseRef.current !== 'room') return
    sounds.click()
    warmDesktop()
    setPhase('post')
  }, [warmDesktop])

  /** push back from the desk mid-session; the desktop stays on the tube */
  const standUp = useCallback(() => {
    if (phaseRef.current !== 'on' || awayRef.current) return
    // WASD must steer the walk, not type into whatever app had focus
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setStartOpen(false)
    setMenu(null)
    setAway(true)
  }, [])

  /** interacted with the machine while it was still running: sit back down */
  const sitDown = useCallback(() => {
    sounds.click()
    setAway(false)
  }, [])

  /** the "Back to site" icon: straight out, no detour through the dark room */
  const exitToSite = useCallback(() => shutdown(true), [shutdown])

  /** leave the roam scene for the site proper, dropping any live session */
  const leaveRoom = useCallback(() => {
    if (phaseRef.current !== 'room' && !awayRef.current) return
    setAway(false)
    setWins([])
    setActiveId('')
    setSelected(new Set())
    setSession(null)
    setPhase('off')
    returnToSite()
  }, [returnToSite])

  const boot = useCallback((e?: Event) => {
    if (phaseRef.current !== 'off') return
    sounds.click()
    warmDesktop()
    // the boot event's detail can name an app to open once someone logs in;
    // the contact section uses this to land visitors straight in the chat
    const detail = (
      e as CustomEvent<{ app?: string; via?: string; flat?: boolean; world?: boolean }> | undefined
    )?.detail
    const want = detail?.app
    pendingAppRef.current = isAppId(want) ? want : null
    // a plane-triggered boot carries the dart into the room with it
    setPlaneInRoom(detail?.via === 'plane')
    // someone asked for the machine and not the room — either through the
    // palette/terminal or by landing on /pc
    const flatOnly = detail?.flat === true || isPcPath()
    // ...or for the room and not the machine: /world (and its palette/terminal
    // twins) enters at the far end, tube already dark, no boot sequence
    const worldEntry = !flatOnly && (detail?.world === true || isWorldPath())
    // the 3D session only where it can land: mouse, big screen, motion ok
    const fancy =
      !flatOnly &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      window.innerWidth >= 640
    // without the 3D there is no room to walk, so a /world request on a phone
    // degrades to the ordinary flat boot rather than to nothing
    const entry: Phase = fancy ? (worldEntry ? 'room' : 'post') : 'boot'
    setMode(fancy ? '3d' : 'flat')
    setPhase(entry)
    // advance the ref NOW, not at commit: this boot pushes /alejOS below, so
    // the deep-link check in the next effect would otherwise boot a second
    // time in the same pass (still seeing 'off') and wipe this call's detail
    phaseRef.current = entry
    // make the session shareable: the OS owns its route while it runs, and
    // which route says how you got in — /pc stays /pc and /world stays /world
    // when shared, while a phone that merely fell back to the flat bezel (or
    // to the boot it asked to skip) still reads /alejOS
    const path = flatOnly ? PC_PATH : entry === 'room' ? WORLD_PATH : OS_PATH
    if (location.pathname.toLowerCase() !== path.toLowerCase()) {
      // an old /room link is the same destination under its previous name, so
      // normalise it in place — pushing would leave /room one Back away, where
      // it would boot a second session
      const legacy = location.pathname.toLowerCase() === LEGACY_WORLD_PATH
      const write = legacy ? history.replaceState : history.pushState
      write.call(history, { alejos: true }, '', path)
    }
  }, [warmDesktop])

  useEffect(() => {
    if (!initialBoot) return
    boot(new CustomEvent(BOOT_OS_EVENT, { detail: initialBoot.detail }))
  }, [boot, initialBoot])

  useEffect(() => {
    window.addEventListener(BOOT_OS_EVENT, boot)
    // deep link: landing on /alejOS boots straight into the machine
    if (isOsUrl()) boot()
    // browser navigation works like a power switch
    const onPop = () => {
      if (isOsUrl() && phaseRef.current === 'off') boot()
      else if (!isOsUrl() && (phaseRef.current === 'room' || awayRef.current)) leaveRoom()
      else if (!isOsUrl() && phaseRef.current !== 'off' && phaseRef.current !== 'down')
        shutdown(true)
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener(BOOT_OS_EVENT, boot)
      window.removeEventListener('popstate', onPop)
    }
  }, [boot, shutdown, leaveRoom])

  // the flat bezel has no scene to build: the warp tunnel can open its exit
  // as soon as the screen exists (this also covers the 3D-failed fallback,
  // where the tunnel is still holding for a room that will never come)
  useEffect(() => {
    if (phase === 'off' || mode !== 'flat') return
    window.dispatchEvent(new Event(OS_SCENE_READY_EVENT))
  }, [phase, mode])

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
    if (phase === 'post' || phase === 'boot' || phase === 'login' || phase === 'on') {
      warmDesktop()
    }
  }, [phase, warmDesktop])

  useEffect(() => {
    if (phase === 'off') return
    // opaque and fullscreen: the site underneath pauses its scenes
    const unlock = lockPageForOverlay(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (phaseRef.current === 'post') {
        setPhase('boot')
      } else if (phaseRef.current === 'boot') {
        setPhase('login')
      } else if (phaseRef.current === 'login') {
        shutdown()
      } else if (phaseRef.current === 'room') {
        leaveRoom()
      } else if (phaseRef.current === 'on') {
        if (awayRef.current) leaveRoom()
        else if (startOpen) setStartOpen(false)
        else if (clockOpen) setClockOpen(false)
        else if (volumeOpen) setVolumeOpen(false)
        else if (menu) setMenu(null)
        else if (taskMenu) setTaskMenu(null)
        // in the room, esc means stand up; shutting down lives in the start menu
        else if (mode === '3d') standUp()
        else shutdown()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unlock()
      window.removeEventListener('keydown', onKey)
    }
  }, [phase, startOpen, clockOpen, volumeOpen, menu, taskMenu, mode, shutdown, leaveRoom, standUp])

  const topZ = (list: OsWin[]) => list.reduce((max, w) => Math.max(max, w.z), 10)

  const focusWin = (id: string) => {
    setActiveId(id)
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, z: topZ(prev) + 1 } : w)))
  }

  const patchWin = (id: string, patch: Partial<WinState>) =>
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)))

  const openApp = (app: AppId, props?: Record<string, unknown>) => {
    // which of the desktop's toys people actually open, games included
    track('app_open', { app })
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

  const openPath = (rawPath: string) => {
    if (rawPath === MY_COMPUTER) {
      openApp('explorer', { path: MY_COMPUTER })
      return
    }
    // a shortcut opens whatever it points at, not itself
    const path = resolvePath(rawPath)
    const node = getNode(path)
    if (!node) {
      void alertBox(
        'Shortcut',
        'The item this shortcut refers to has been changed or moved, so the shortcut no longer works.',
        'warn',
      )
      return
    }
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
      case 'shortcut':
        // resolvePath only hands one of these back when the chain loops
        void alertBox('Shortcut', 'This shortcut points back at itself.', 'warn')
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

  /** back to the welcome screen; `notice` explains an involuntary trip there */
  const logOff = useCallback((notice = '') => {
    sounds.close()
    // a properties sheet left open over the login screen would outlive the
    // session it was describing
    closeAllDialogs()
    setWins([])
    setActiveId('')
    setStartOpen(false)
    setMenu(null)
    setTaskMenu(null)
    setSelected(new Set())
    setSession(null)
    setViewer(null)
    setLoginNotice(notice)
    setPhase('login')
  }, [])

  // A socket reported that the server does not recognise our token — the
  // session is over whether or not the desktop knew it. Staying in it silently
  // acts as a guest (arcade scores land on the boards under a guest name,
  // peeko refuses to load), so hand back the login screen instead of showing a
  // name the server will not use. Say why: this fires on the first socket an
  // app happens to open, which from the desk looks like being thrown out at
  // random minutes after signing in.
  useEffect(() => {
    const expire = () => {
      if (phaseRef.current === 'off' || phaseRef.current === 'login') return
      logOff('The account server no longer recognises that session. Sign in again.')
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, expire)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expire)
  }, [logOff])

  // --- window management ----------------------------------------------------
  // The taskbar's own menu, which is where XP kept the three commands that act
  // on every window at once. Show Desktop remembers exactly what it minimised,
  // so pressing it twice puts back what it took down and leaves alone the
  // windows you had minimised yourself.

  const tasks: OsTask[] = wins.map((w) => ({
    id: w.id,
    app: w.app,
    title: w.title,
    minimized: w.minimized,
    active: activeId === w.id,
  }))

  const restoreWin = (id: string) => {
    patchWin(id, { minimized: false })
    focusWin(id)
  }

  const osApi: OsApi = {
    session: session ?? { kind: 'guest', name: 'guest' },
    openApp: (app, props) => {
      if (isAppId(app)) openApp(app, props)
    },
    openPath,
    logOff: () => logOff(),
    shutdown: () => shutdown(),
    tasks,
    focusWindow: restoreWin,
    closeWindow: closeWin,
  }

  const onTaskButton = (w: OsWin) => {
    sounds.click()
    if (w.minimized || activeId !== w.id) {
      restoreWin(w.id)
    } else {
      patchWin(w.id, { minimized: true })
    }
  }

  const toggleShowDesktop = () => {
    sounds.click()
    if (hiddenByShowDesktop) {
      const hidden = hiddenByShowDesktop
      setHiddenByShowDesktop(null)
      setWins((prev) => prev.map((w) => (hidden.includes(w.id) ? { ...w, minimized: false } : w)))
      return
    }
    const open = wins.filter((w) => !w.minimized).map((w) => w.id)
    if (open.length === 0) return
    setHiddenByShowDesktop(open)
    setWins((prev) => prev.map((w) => (open.includes(w.id) ? { ...w, minimized: true } : w)))
  }

  /** the area a window may occupy: the desktop minus the taskbar */
  const stageSize = () => ({ w: grid.w, h: grid.h - 48 })

  const cascadeWindows = () => {
    sounds.click()
    const { w: sw, h: sh } = stageSize()
    let n = 0
    setWins((prev) =>
      prev.map((win) => {
        if (win.minimized) return win
        const step = 28 * n++
        return {
          ...win,
          maximized: false,
          x: 24 + step,
          y: 18 + step,
          w: Math.max(320, Math.min(win.w, sw - step - 60)),
          h: Math.max(220, Math.min(win.h, sh - step - 40)),
        }
      }),
    )
  }

  const tileWindows = () => {
    sounds.click()
    const { w: sw, h: sh } = stageSize()
    const open = wins.filter((w) => !w.minimized)
    if (open.length === 0) return
    const cols = Math.ceil(Math.sqrt(open.length))
    const rows = Math.ceil(open.length / cols)
    const cw = Math.floor(sw / cols)
    const ch = Math.floor(sh / rows)
    const at = new Map(open.map((w, i) => [w.id, i]))
    setWins((prev) =>
      prev.map((win) => {
        const i = at.get(win.id)
        if (i === undefined) return win
        return {
          ...win,
          maximized: false,
          x: (i % cols) * cw,
          y: Math.floor(i / cols) * ch,
          w: Math.max(320, cw - 4),
          h: Math.max(220, ch - 4),
        }
      }),
    )
  }

  const taskbarMenuItems = (): MenuItem[] => [
    { label: 'Cascade Windows', disabled: wins.length === 0, onClick: cascadeWindows },
    { label: 'Tile Windows', disabled: wins.length === 0, onClick: tileWindows },
    {
      label: hiddenByShowDesktop ? 'Show Open Windows' : 'Show the Desktop',
      onClick: toggleShowDesktop,
    },
    { divider: true },
    { label: 'Task Manager', onClick: () => openApp('taskmgr') },
    { divider: true },
    { label: 'Properties', onClick: () => openApp('display') },
  ]

  const taskButtonMenuItems = (w: OsWin): MenuItem[] => [
    { label: 'Restore', disabled: !w.minimized && !w.maximized, onClick: () => restoreWin(w.id) },
    {
      label: 'Minimize',
      disabled: w.minimized,
      onClick: () => patchWin(w.id, { minimized: true }),
    },
    {
      label: 'Maximize',
      disabled: w.maximized,
      onClick: () => {
        patchWin(w.id, { maximized: true, minimized: false })
        focusWin(w.id)
      },
    },
    { divider: true },
    { label: 'Close', bold: true, shortcut: 'Alt+F4', onClick: () => closeWin(w.id) },
  ]

  /*
    Alt+Tab, in the order a real one uses: most recently focused first, so the
    first press flips between the two windows you are actually working in.
    Some desktop environments eat the combination before the browser sees it,
    which is out of our hands and costs nothing when it happens — the
    switcher simply never opens. Ctrl+Shift+Esc is unclaimed everywhere and
    rides along here as the other way in.
  */
  const zOrder = [...wins].sort((a, b) => b.z - a.z)

  useEffect(() => {
    if (phase !== 'on' || away) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'Escape') {
        e.preventDefault()
        openApp('taskmgr')
        return
      }
      if (e.key !== 'Tab' || !e.altKey) return
      e.preventDefault()
      if (zOrder.length < 2) return
      const n = zOrder.length
      setSwitcher((i) => (i === null ? (e.shiftKey ? n - 1 : 1) : (i + (e.shiftKey ? -1 : 1) + n) % n))
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      setSwitcher((i) => {
        if (i !== null && zOrder[i]) restoreWin(zOrder[i].id)
        return null
      })
    }
    const drop = () => setSwitcher(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', drop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', drop)
    }
    // deliberately re-bound every render: the handlers close over the current
    // z-order, and a stale one would tab to whatever was on top a while ago
  })

  /*
    The tip balloon, once per browser and then never again — the same
    localStorage this machine keeps its files, its wallpaper and its icon
    arrangement in. Per *session* would have been the easier flag and the
    wrong one: a returning visitor already knows the icons drag, and being
    told a second time reads as the site not remembering them.

    The flag is written when the balloon actually appears rather than when
    this effect runs, so a visitor who logs in and shuts down inside three
    seconds has not silently spent their one showing.
  */
  useEffect(() => {
    if (phase !== 'on' || away) return
    try {
      if (localStorage.getItem(TIP_KEY) === 'seen') return
    } catch {
      /* storage unavailable: it shows once per boot instead */
    }
    const show = window.setTimeout(() => {
      setBalloon(true)
      try {
        localStorage.setItem(TIP_KEY, 'seen')
      } catch {
        /* storage unavailable */
      }
    }, 2600)
    const hide = window.setTimeout(() => setBalloon(false), 13_000)
    return () => {
      window.clearTimeout(show)
      window.clearTimeout(hide)
    }
  }, [phase, away])

  // --- desktop marquee selection (that blue thing) -------------------------
  // Client pixels are not desktop pixels on the 3D CRT, which draws the whole
  // screen DOM through a CSS3D transform: every conversion here divides by the
  // scale the desktop is actually being drawn at, or the box lands somewhere
  // other than under the cursor and selects the wrong icons.
  const localScale = () => {
    const root = desktopRef.current
    if (!root) return 1
    return root.getBoundingClientRect().width / root.offsetWidth || 1
  }

  /** viewport px to desktop px: where the ghost has to be drawn */
  const toLocal = (x: number, y: number) => {
    const root = desktopRef.current
    if (!root) return { x, y }
    const rect = root.getBoundingClientRect()
    const scale = localScale()
    return { x: (x - rect.left) / scale, y: (y - rect.top) / scale }
  }

  const onDesktopPointerDown = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).closest('[data-desktop-bg]')) return
    desktopRef.current?.focus({ preventScroll: true })
    setStartOpen(false)
    setMenu(null)
    setTaskMenu(null)
    setSelected(new Set())
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    const root = desktopRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const scale = localScale()
    marqueeOriginRef.current = {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    }
    root.setPointerCapture(e.pointerId)
  }

  const onDesktopPointerMove = (e: React.PointerEvent) => {
    const origin = marqueeOriginRef.current
    const root = desktopRef.current
    if (!origin || !root) return
    const rect = root.getBoundingClientRect()
    const scale = localScale()
    const cx = Math.min(Math.max((e.clientX - rect.left) / scale, 0), root.clientWidth)
    const cy = Math.min(Math.max((e.clientY - rect.top) / scale, 0), root.clientHeight)
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
      const left = (r.left - rect.left) / scale
      const top = (r.top - rect.top) / scale
      if (
        left < m.x + m.w &&
        left + r.width / scale > m.x &&
        top < m.y + m.h &&
        top + r.height / scale > m.y
      ) {
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
    const scale = rect.width / root.offsetWidth || 1
    setStartOpen(false)
    const icon = iconEl?.dataset.icon ?? null
    // right-clicking inside a multi-selection keeps it, so "Delete" can mean
    // all four of them; right-clicking outside one replaces it
    if (icon && !selected.has(icon)) setSelected(new Set([icon]))
    setMenu({ x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale, icon })
  }

  /*
    Keyboard file management, but only when the desktop itself has the
    keyboard. Every window in AlejOS lives inside this same div, so an
    unguarded Delete here would also fire while someone is editing a file in
    Notepad — the guard is that the event has to have come from the desktop
    root or from an icon on it.
  */
  const onDesktopKeyDown = (e: React.KeyboardEvent) => {
    if (renamingIcon) return
    const t = e.target as HTMLElement
    const mine = t === desktopRef.current || Boolean(t.closest('[data-icon]'))
    if (!mine) return
    const ctrl = e.ctrlKey || e.metaKey
    const paths = selectedPaths()
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(new Set(iconIds))
      return
    }
    if (ctrl && e.key.toLowerCase() === 'c' && paths.length) {
      e.preventDefault()
      clipCopy(paths)
      return
    }
    if (ctrl && e.key.toLowerCase() === 'x' && paths.length) {
      e.preventDefault()
      clipCut(paths.filter((p) => !getNode(p)?.system))
      return
    }
    if (ctrl && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      pasteToDesktop()
      return
    }
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undoOnDesktop()
      return
    }
    if (e.key === 'F5') {
      e.preventDefault()
      refreshDesktop()
      return
    }
    if (e.key === 'F2' && selected.size === 1) {
      const only = [...selected][0]
      if (only.startsWith('fs:') && !getNode(joinPath(DESKTOP, only.slice(3)))?.system) {
        e.preventDefault()
        setRenamingIcon(only)
      }
      return
    }
    if (e.key === 'Delete' && paths.length) {
      e.preventDefault()
      void deleteSelection()
      return
    }
    if (e.key === 'Enter' && selected.size === 1) {
      const only = [...selected][0]
      e.preventDefault()
      if (only === 'my-computer') openApp('explorer', { path: MY_COMPUTER })
      else if (only === 'recycle-bin') openApp('explorer', { path: RECYCLE_BIN })
      else if (only === 'exit') exitToSite()
      else if (only.startsWith('fs:')) openPath(joinPath(DESKTOP, only.slice(3)))
    }
  }

  const commitIconRename = (node: FsNode, next: string) => {
    setRenamingIcon(null)
    const clean = next.trim()
    if (!clean || clean === node.name) return
    const r = renameNode(joinPath(DESKTOP, node.name), clean)
    if (!r.ok) {
      sounds.error()
      return
    }
    // the icon's grid spot is keyed by name, so it moves with the rename
    const cell = iconPos[`fs:${node.name}`]
    if (!cell) return
    const nextPos = { ...iconPos, [`fs:${r.name}`]: cell }
    delete nextPos[`fs:${node.name}`]
    commitIconPos(nextPos)
  }

  // the whole point of Refresh is the blink: the icons vanish for a beat and
  // come back, which somehow proves the computer is fine
  useEffect(() => {
    if (!refreshing) return
    const id = window.setTimeout(() => setRefreshing(false), 100)
    return () => window.clearTimeout(id)
  }, [refreshing])
  const refreshDesktop = () => {
    sounds.click()
    setRefreshing(true)
  }

  // --- context menus --------------------------------------------------------
  const desktopMenuItems = (): MenuItem[] => [
    {
      label: 'Arrange Icons By',
      sub: [
        // sorting also forgets manual spots, so everything flows again
        { label: 'Name', onClick: () => { commitIconPos({}); sortChildren(DESKTOP, 'name') } },
        { label: 'Type', onClick: () => { commitIconPos({}); sortChildren(DESKTOP, 'type') } },
        { label: 'Modified', onClick: () => { commitIconPos({}); sortChildren(DESKTOP, 'modified') } },
      ],
    },
    { label: 'Refresh', shortcut: 'F5', onClick: refreshDesktop },
    { divider: true },
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      disabled: !canPasteInto(DESKTOP),
      onClick: pasteToDesktop,
    },
    {
      label: 'Paste Shortcut',
      disabled: clip.paths.length === 0,
      onClick: () => {
        let made = false
        for (const p of clip.paths) {
          const r = createShortcut(p, DESKTOP)
          if (!r.ok) void alertBox('Create Shortcut', r.error)
          else made = true
        }
        if (made) sounds.open()
      },
    },
    {
      label: undoLabel() ? `Undo ${undoLabel()}` : 'Undo',
      shortcut: 'Ctrl+Z',
      disabled: !undoLabel(),
      onClick: undoOnDesktop,
    },
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

  const emptyBin = async () => {
    if (binCount === 0) return
    const ok = await confirmBox(
      'Confirm Delete',
      `Are you sure you want to permanently delete ${
        binCount === 1 ? 'this item' : `these ${binCount} items`
      }?`,
      { icon: 'warn' },
    )
    if (!ok) return
    sounds.close()
    emptyRecycleBin()
  }

  const iconMenuItems = (icon: string): MenuItem[] => {
    if (icon === 'my-computer') {
      return [
        { label: 'Open', bold: true, onClick: () => openApp('explorer', { path: MY_COMPUTER }) },
        { label: 'Explore', onClick: () => openApp('explorer', { path: 'C:' }) },
        { divider: true },
        { label: 'Manage', onClick: () => openApp('taskmgr') },
        {
          label: 'Properties',
          onClick: () => showProperties('', session?.name ?? 'guest'),
        },
      ]
    }
    if (icon === 'recycle-bin') {
      return [
        { label: 'Open', bold: true, onClick: () => openApp('explorer', { path: RECYCLE_BIN }) },
        { divider: true },
        { label: 'Empty Recycle Bin', disabled: binCount === 0, onClick: () => void emptyBin() },
        { divider: true },
        {
          label: 'Properties',
          onClick: () => showProperties(RECYCLE_BIN, session?.name ?? 'guest'),
        },
      ]
    }
    if (icon === 'exit') {
      return [{ label: 'Back to site', bold: true, onClick: exitToSite }]
    }
    const name = icon.startsWith('fs:') ? icon.slice(3) : icon
    const node = desktopNodes.find((n) => n.name === name)
    if (!node) return []
    const full = joinPath(DESKTOP, node.name)
    const many = selectedPaths().length > 1 && selected.has(icon)
    const targets = many ? selectedPaths() : [full]
    const allMine = targets.every((p) => !getNode(p)?.system)
    return [
      { label: 'Open', bold: true, disabled: many, onClick: () => openPath(full) },
      { divider: true },
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: !allMine, onClick: () => clipCut(targets) },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => clipCopy(targets) },
      {
        label: 'Create Shortcut',
        onClick: () => {
          for (const p of targets) {
            const r = createShortcut(p, DESKTOP)
            if (!r.ok) void alertBox('Create Shortcut', r.error)
          }
        },
      },
      { divider: true },
      {
        label: 'Rename',
        shortcut: 'F2',
        disabled: node.system || many,
        onClick: () => setRenamingIcon(icon),
      },
      {
        label: 'Delete',
        shortcut: 'Del',
        disabled: !allMine,
        onClick: () => void deleteSelection(),
      },
      { divider: true },
      {
        label: 'Properties',
        disabled: many,
        onClick: () => showProperties(full, session?.name ?? 'guest'),
      },
    ]
  }

  if (phase === 'off') return null

  const desktop = (
    <div
      ref={desktopRef}
      tabIndex={-1}
      data-no-focus-ring
      className="relative h-full outline-none select-none"
      onPointerDown={onDesktopPointerDown}
      onPointerMove={onDesktopPointerMove}
      onPointerUp={(e) => {
        endMarquee()
        onDesktopDrop(e)
      }}
      onPointerCancel={endMarquee}
      onContextMenu={onDesktopContextMenu}
      onKeyDown={onDesktopKeyDown}
    >
      {/* the wallpaper doubles as the desktop's drop target: anything let go
          over open ground lands in C:\Desktop */}
      <div
        aria-hidden
        data-desktop-bg="true"
        data-drop-path={DESKTOP}
        className={`absolute inset-0 bg-cover bg-center ${
          dropLit(DESKTOP) ? 'ring-4 ring-blue-400/70 ring-inset' : ''
        }`}
        style={
          wallpaper.src
            ? { backgroundImage: `url(${wallpaper.src})` }
            : { backgroundColor: wallpaper.color }
        }
      />

      {/* desktop icons: My Computer, then C:\Desktop, then the bin. each one
          sits on its grid cell; the layer itself must not eat desktop clicks.
          Refresh blanks the whole layer for a beat, XP style */}
      <div className="pointer-events-none absolute inset-0 bottom-12" style={refreshing ? { visibility: 'hidden' } : undefined}>
        <DesktopIcon
          id="my-computer"
          label="My Computer"
          glyph={xpIcon('my-computer', 34)}
          cell={iconCells['my-computer']}
          cw={grid.cw}
          selected={selected.has('my-computer')}
          onLight={onLightWallpaper}
          dropPath={DESKTOP}
          onSelect={() => setSelected(new Set(['my-computer']))}
          onOpen={() => openApp('explorer', { path: MY_COMPUTER })}
          onDragEnd={(dx, dy) => moveIcon('my-computer', dx, dy)}
        />
        {desktopNodes.map((node) => {
          const id = `fs:${node.name}`
          const full = joinPath(DESKTOP, node.name)
          return (
            <DesktopIcon
              key={id}
              id={id}
              label={node.name}
              glyph={glyphFor(node, 34)}
              cell={iconCells[id]}
              cw={grid.cw}
              selected={selected.has(id)}
              renaming={renamingIcon === id}
              onLight={onLightWallpaper}
              dropPath={dropPathFor(node)}
              dropLit={dropLit(dropPathFor(node))}
              dimmed={isCut(full)}
              dragPaths={dragPathsFor(id)}
              onSelect={() => setSelected(new Set([id]))}
              onOpen={() => openPath(full)}
              onRename={(next) => commitIconRename(node, next)}
              onDragEnd={(dx, dy, target, copy) => onIconDragEnd(id, dx, dy, target, copy)}
            />
          )
        })}
        <DesktopIcon
          id="recycle-bin"
          label={binCount > 0 ? `Recycle Bin (${binCount})` : 'Recycle Bin'}
          glyph={xpIcon(binCount > 0 ? 'recycle-full' : 'recycle-empty', 34)}
          cell={iconCells['recycle-bin']}
          cw={grid.cw}
          selected={selected.has('recycle-bin')}
          onLight={onLightWallpaper}
          dropPath={RECYCLE_BIN}
          dropLit={dropLit(RECYCLE_BIN)}
          onSelect={() => setSelected(new Set(['recycle-bin']))}
          onOpen={() => openApp('explorer', { path: RECYCLE_BIN })}
          onDragEnd={(dx, dy) => moveIcon('recycle-bin', dx, dy)}
        />
        <DesktopIcon
          id="exit"
          label="Back to site"
          glyph={xpIcon('exit', 34)}
          cell={iconCells['exit']}
          cw={grid.cw}
          selected={selected.has('exit')}
          onLight={onLightWallpaper}
          dropPath={DESKTOP}
          onSelect={() => setSelected(new Set(['exit']))}
          onOpen={exitToSite}
          onDragEnd={(dx, dy) => moveIcon('exit', dx, dy)}
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

      {/* what the cursor is carrying, when the source is not carrying itself:
          drawn above the windows so a file dragged across one stays visible,
          and never hit-testable, since it sits exactly where the drop target
          has to be found */}
      {drag.active && drag.ghost && <DragGhost drag={drag} toLocal={toLocal} />}

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
              className="absolute bottom-12 left-0 z-[5000] w-72 overflow-hidden rounded-t-lg border border-blue-900 bg-stone-50 shadow-2xl shadow-stone-950/50"
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
                {(session?.admin ? [...START_ITEMS, ...ADMIN_START_ITEMS] : START_ITEMS).map((item) => (
                  <li key={item.label ?? item.app}>
                    <button
                      type="button"
                      onClick={() => openApp(item.app, item.props)}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                    >
                      <span className="text-blue-700 [&_svg]:size-5">
                        {item.icon ? xpIcon(item.icon, 20) : APPS[item.app].glyph(20)}
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
                    <button
                      type="button"
                      onClick={() => openApp('browser', { url: item.href })}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                    >
                      <span className="text-blue-700">{item.icon}</span>
                      {item.label}
                    </button>
                  </li>
                ))}
                <li aria-hidden className="mx-3 my-1.5 border-t border-stone-200" />
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setStartOpen(false)
                      showRunDialog({
                        openApp: (app, props) => {
                          if (isAppId(app)) openApp(app, props)
                        },
                        openPath,
                      })
                    }}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                  >
                    <PlayIcon size={18} weight="fill" className="text-blue-700" />
                    Run…
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => logOff()}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-stone-700 hover:bg-blue-600/10"
                  >
                    <UserIcon size={18} className="text-blue-700" />
                    Log off {session?.name ?? 'guest'}
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => shutdown()}
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

      {/* clock flyout */}
      <AnimatePresence>
        {clockOpen && (
          <>
            <button
              type="button"
              aria-label="Close Date and Time"
              onClick={() => setClockOpen(false)}
              className="absolute inset-0 cursor-default"
            />
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              role="dialog"
              aria-label="Date and Time"
              className="absolute right-0 bottom-12 z-[5000] w-72 overflow-hidden rounded-t-lg border border-blue-900 bg-stone-50 shadow-2xl shadow-stone-950/50"
            >
              <ClockFlyout />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* clicking anywhere else puts the volume panel away; the panel itself
          lives up in the tray, anchored over the speaker it belongs to */}
      {volumeOpen && (
        <button
          type="button"
          aria-label="Close volume"
          onClick={() => setVolumeOpen(false)}
          className="absolute inset-0 cursor-default"
        />
      )}

      {/* the tray balloon: one tip per session, pointing at the desktop it
          is describing */}
      <AnimatePresence>
        {balloon && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            // click-through except for its own close button: it sits over the
            // bottom-left corner of the desktop for thirteen seconds, and a
            // tip that eats a drop is worse than no tip
            className="pointer-events-none absolute bottom-14 left-3 z-[5000] w-64 rounded-lg border border-stone-400 bg-[#ffffe1] p-3 shadow-xl shadow-stone-950/40"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">{xpIcon('folder', 16)}</span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-stone-800">This is a real desktop</p>
                <p className="mt-1 text-[11px] leading-relaxed text-stone-600">
                  Drag files between the desktop and any window, drop them on the Recycle Bin, cut
                  and paste them, right-click anything. Everything you make stays in your browser.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close tip"
                onClick={() => setBalloon(false)}
                className="pointer-events-auto -mt-1 -mr-1 shrink-0 cursor-pointer rounded-sm p-0.5 text-stone-500 hover:bg-stone-950/10 hover:text-stone-800"
              >
                <XIcon size={11} weight="bold" />
              </button>
            </div>
            {/* the tail, pointing down at the taskbar */}
            <span className="absolute -bottom-[7px] left-8 size-3 rotate-45 border-r border-b border-stone-400 bg-[#ffffe1]" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Alt+Tab */}
      {switcher !== null && zOrder.length > 1 && (
        <div className="absolute inset-0 z-[7000] flex items-center justify-center">
          <div className="rounded-lg border border-blue-900 bg-stone-100/95 p-4 shadow-2xl shadow-stone-950/50">
            <div className="flex flex-wrap justify-center gap-2">
              {zOrder.map((w, i) => (
                <span
                  key={w.id}
                  className={`flex size-14 items-center justify-center rounded-md border ${
                    i === switcher ? 'border-blue-700 bg-blue-600/20' : 'border-transparent'
                  }`}
                >
                  <span className="[&_img]:size-8 [&_svg]:size-8">{w.icon}</span>
                </span>
              ))}
            </div>
            <p className="mt-2 text-center text-xs text-stone-700">
              {zOrder[switcher]?.title ?? ''}
            </p>
          </div>
        </div>
      )}

      {/* taskbar */}
      <div
        className="os-taskbar absolute inset-x-0 bottom-0 z-[4000] flex h-12 items-stretch"
        onContextMenu={(e) => {
          const root = desktopRef.current
          if (!root) return
          e.preventDefault()
          const rect = root.getBoundingClientRect()
          const scale = localScale()
          const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-task-win]')
          setStartOpen(false)
          setMenu(null)
          setTaskMenu({
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale,
            win: btn?.dataset.taskWin ?? null,
          })
        }}
      >
        <button
          type="button"
          aria-label="Start"
          data-open={startOpen}
          onClick={() => {
            sounds.click()
            setMenu(null)
            setClockOpen(false)
            setVolumeOpen(false)
            setStartOpen((o) => !o)
          }}
          className="os-start font-xp flex shrink-0 cursor-pointer items-center gap-1.5 pr-7 pl-2 text-xl font-semibold text-white italic"
        >
          <AlejLogo size={30} outlined />
          start
        </button>

        {/* quick launch, XP's own strip: show desktop plus the two things
            people reach for most */}
        <div className="hidden shrink-0 items-center gap-0.5 border-r border-white/20 px-1.5 sm:flex">
          <button
            type="button"
            aria-label="Show the desktop"
            title="Show the desktop"
            onClick={toggleShowDesktop}
            className="flex size-7 cursor-pointer items-center justify-center rounded-sm text-white/85 hover:bg-white/20 hover:text-white"
          >
            <SquaresFourIcon size={15} weight="bold" />
          </button>
          {(['browser', 'paint', 'terminal'] as AppId[]).map((app) => (
            <button
              key={app}
              type="button"
              aria-label={APPS[app].name}
              title={APPS[app].name}
              onClick={() => openApp(app)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-sm hover:bg-white/20"
            >
              {APPS[app].glyph(16)}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-[5px]">
          {wins.map((w) => (
            <button
              key={w.id}
              type="button"
              data-task-win={w.id}
              onClick={() => onTaskButton(w)}
              data-active={activeId === w.id && !w.minimized}
              className="os-task flex h-full min-w-0 max-w-44 cursor-pointer items-center gap-1.5 px-2 text-xs text-white"
            >
              <span className="shrink-0 drop-shadow-[1px_1px_1px_rgba(0,0,0,0.4)]">{w.icon}</span>
              <span className="truncate">{w.title.split(' - ')[0]}</span>
            </button>
          ))}
        </div>
        <div className="os-tray flex items-center gap-1 pr-2.5 pl-3.5">
          <div className="relative">
            <button
              type="button"
              aria-label={muted ? 'Unmute' : 'Volume'}
              data-open={volumeOpen}
              onClick={() => {
                sounds.click()
                setStartOpen(false)
                setClockOpen(false)
                setVolumeOpen((o) => !o)
              }}
              className="flex cursor-pointer rounded-md p-1.5 text-white/85 transition-colors hover:bg-white/20 hover:text-white data-[open=true]:bg-white/20"
            >
              {muted || volume === 0 ? (
                <SpeakerSlashIcon size={15} weight="bold" />
              ) : (
                <SpeakerHighIcon size={15} weight="bold" />
              )}
            </button>
            <AnimatePresence>
              {volumeOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                  role="dialog"
                  aria-label="Volume"
                  className="absolute right-0 bottom-[calc(100%+10px)] z-[5000]"
                >
                  <VolumeFlyout />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <Clock
            open={clockOpen}
            onToggle={() => {
              sounds.click()
              setStartOpen(false)
              setVolumeOpen(false)
              setMenu(null)
              setClockOpen((o) => !o)
            }}
          />
          <button
            type="button"
            onClick={() => shutdown()}
            aria-label="Shut down AlejOS"
            className="cursor-pointer rounded-md p-1.5 text-white/85 transition-colors hover:bg-white/20 hover:text-white"
          >
            <PowerIcon size={15} weight="bold" />
          </button>
        </div>
      </div>

      {/* the taskbar's own menus: one for a window button, one for the bar */}
      <AnimatePresence>
        {taskMenu && (
          <ContextMenu
            items={
              taskMenu.win
                ? (() => {
                    const w = wins.find((x) => x.id === taskMenu.win)
                    return w ? taskButtonMenuItems(w) : taskbarMenuItems()
                  })()
                : taskbarMenuItems()
            }
            x={taskMenu.x}
            y={taskMenu.y}
            onClose={() => setTaskMenu(null)}
          />
        )}
      </AnimatePresence>

      {/* modal boxes sit above the windows and below nothing */}
      <DialogLayer />

      {/* and the stars, when nobody has touched the machine for a while */}
      <ScreensaverLayer enabled={phase === 'on' && !away} />
    </div>
  )

  const screen =
    phase === 'post' ? (
      <BiosScreen />
    ) : phase === 'boot' ? (
      <BootScreen />
    ) : phase === 'login' ? (
      <LoginScreen
        notice={loginNotice}
        onLogin={(s) => {
          setLoginNotice('')
          setSession(s)
          // registered visitors get their name on subsequent events; it is
          // also how the server keeps my own testing out of the live feed
          setViewer(s.kind === 'user' ? s.name : null)
          track('os_login', { kind: s.kind, admin: Boolean(s.admin) })
          setPhase('on')
          const app = pendingAppRef.current
          pendingAppRef.current = null
          // let the desktop land before the requested window pops up
          if (app) setTimeout(() => openApp(app), 700)
        }}
        onShutdown={() => shutdown()}
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
          {downFrom === 'on' ? (
            desktop
          ) : downFrom === 'boot' ? (
            <BootScreen />
          ) : downFrom === 'post' ? (
            <BiosScreen />
          ) : (
            <LoginScreen onLogin={() => {}} onShutdown={() => {}} />
          )}
        </div>
      )
    ) : phase === 'room' ? (
      // the tube is cold; the room outside is the show now
      <div className="h-full bg-stone-950" />
    ) : (
      desktopReady ? desktop : <BootScreen />
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
          {/* the wait before the room exists is mostly the driver linking
              shaders, and it used to be a black rectangle. BootCover holds
              until CrtScene reports its first frame */}
          {/* two different waits, two different covers: a cold boot gets the
              honest progress bar, walking out of the front door gets a cut */}
          {loadStage === 'stepping' ? (
            <StepOutCover label="stepping outside" />
          ) : (
            <BootCover key={loadRun} stage={loadStage} />
          )}
          <Suspense fallback={null}>
            <CrtScene
              off={phase === 'down'}
              roam={phase === 'room' || away}
              screenLive={phase === 'on'}
              paperPlane={planeInRoom}
              // who the shared walk introduces you as; the desktop owns the
              // session, the room only borrows the name off it
              session={session}
              onInteract={away ? sitDown : wake}
              onLeave={leaveRoom}
              onFail={() => setMode('flat')}
              onStage={onLoadStage}
            >
              <div className="relative h-full w-full" onWheel={onScreenWheel}>
                {screen}
                {phase !== 'room' && <ScreenEffects />}
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
