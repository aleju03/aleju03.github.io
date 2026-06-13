import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sounds } from './sounds'
import { createNode, getNode, joinPath, listDir, writeImage } from './fs'
import { xpIcon } from './xpIcon'

/*
  Paint for AlejOS, rebuilt to match Windows XP Paint feature for feature:
  the sixteen-tool toolbox (with the real mspaint toolbar bitmaps, sliced
  from the original resources in public/os/paint), the per-tool options box
  under it, the File/Edit/View/Image/Colors/Help menus, foreground and
  background colors with right-button drawing, the 28-color palette and the
  status bar. Pointer handlers draw straight to the 2d context through an
  op ref; React state only tracks what the chrome needs to render.
*/

type C2D = CanvasRenderingContext2D
type Pt = { x: number; y: number }
type Rect = { x: number; y: number; w: number; h: number }

type Tool =
  | 'free-select'
  | 'select'
  | 'eraser'
  | 'fill'
  | 'picker'
  | 'magnifier'
  | 'pencil'
  | 'brush'
  | 'airbrush'
  | 'text'
  | 'line'
  | 'curve'
  | 'rect'
  | 'polygon'
  | 'ellipse'
  | 'rounded-rect'

// the real XP status bar hints, one per tool
const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'free-select', label: 'Free-Form Select', hint: 'Selects a free-form part of the picture to move, copy, or edit.' },
  { id: 'select', label: 'Select', hint: 'Selects a rectangular part of the picture to move, copy, or edit.' },
  { id: 'eraser', label: 'Eraser', hint: 'Erases a portion of the picture, using the selected eraser shape.' },
  { id: 'fill', label: 'Fill With Color', hint: 'Fills an area with the current drawing color.' },
  { id: 'picker', label: 'Pick Color', hint: 'Picks up a color from the picture for drawing.' },
  { id: 'magnifier', label: 'Magnifier', hint: 'Changes the magnification.' },
  { id: 'pencil', label: 'Pencil', hint: 'Draws a free-form line one pixel wide.' },
  { id: 'brush', label: 'Brush', hint: 'Draws using a brush with the selected shape and size.' },
  { id: 'airbrush', label: 'Airbrush', hint: 'Draws using an airbrush of the selected size.' },
  { id: 'text', label: 'Text', hint: 'Inserts text into the picture.' },
  { id: 'line', label: 'Line', hint: 'Draws a straight line with the selected line width.' },
  { id: 'curve', label: 'Curve', hint: 'Draws a curved line with the selected line width.' },
  { id: 'rect', label: 'Rectangle', hint: 'Draws a rectangle with the selected fill style.' },
  { id: 'polygon', label: 'Polygon', hint: 'Draws a polygon with the selected fill style.' },
  { id: 'ellipse', label: 'Ellipse', hint: 'Draws an ellipse with the selected fill style.' },
  { id: 'rounded-rect', label: 'Rounded Rectangle', hint: 'Draws a rounded rectangle with the selected fill style.' },
]

const HINTS = Object.fromEntries(TOOLS.map((t) => [t.id, t.hint])) as Record<Tool, string>
const DEFAULT_HINT = 'For Help, click Help Topics on the Help Menu.'

// the classic 28-color palette, column-major so white sits under black
const DEFAULT_PALETTE = [
  '#000000', '#ffffff', '#808080', '#c0c0c0', '#800000', '#ff0000', '#808000', '#ffff00',
  '#008000', '#00ff00', '#008080', '#00ffff', '#000080', '#0000ff', '#800080', '#ff00ff',
  '#808040', '#ffff80', '#004040', '#00ff80', '#0080ff', '#80ffff', '#004080', '#8080ff',
  '#4000ff', '#ff0080', '#804000', '#ff8040',
]

type FillMode = 'outline' | 'both' | 'fill'
type BrushShape = 'round' | 'square' | 'slash' | 'backslash'

const BRUSH_SHAPES: BrushShape[] = ['round', 'square', 'slash', 'backslash']
const BRUSH_SIZES = [8, 5, 2]
const ERASER_SIZES = [4, 6, 8, 10]
const AIR_SIZES = [4, 8, 12]
const LINE_WIDTHS = [1, 2, 3, 4, 5]
const MAG_LEVELS = [1, 2, 6, 8]
const TEXT_SIZES = [8, 10, 12, 16, 20, 24, 32, 48]
const SHAPE_TOOLS: Tool[] = ['rect', 'polygon', 'ellipse', 'rounded-rect']

const DEFAULT_W = 600
const DEFAULT_H = 380
const MAX_W = 1024
const MAX_H = 768
const MAX_UNDO = 30

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** queue-based flood fill on raw ImageData, no recursion */
function floodFill(ctx: C2D, x: number, y: number, hex: string) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  const px = Math.floor(x)
  const py = Math.floor(y)
  if (px < 0 || py < 0 || px >= W || py >= H) return
  const img = ctx.getImageData(0, 0, W, H)
  const data = img.data
  const start = (py * W + px) * 4
  const tr = data[start]
  const tg = data[start + 1]
  const tb = data[start + 2]
  const ta = data[start + 3]
  const [r, g, b] = hexToRgb(hex)
  if (tr === r && tg === g && tb === b && ta === 255) return
  const stack: number[] = [py * W + px]
  while (stack.length > 0) {
    const i = stack.pop() as number
    const o = i * 4
    if (data[o] !== tr || data[o + 1] !== tg || data[o + 2] !== tb || data[o + 3] !== ta) continue
    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
    data[o + 3] = 255
    const cx = i % W
    if (cx > 0) stack.push(i - 1)
    if (cx < W - 1) stack.push(i + 1)
    if (i >= W) stack.push(i - W)
    if (i < W * (H - 1)) stack.push(i + W)
  }
  ctx.putImageData(img, 0, 0)
}

function pathFrom(pts: Pt[], offX = 0, offY = 0): Path2D {
  const p = new Path2D()
  pts.forEach((pt, i) => (i === 0 ? p.moveTo(pt.x - offX, pt.y - offY) : p.lineTo(pt.x - offX, pt.y - offY)))
  p.closePath()
  return p
}

/** pixels matching the background color become see-through, XP transparent paste */
function knockOutColor(c: HTMLCanvasElement, hex: string) {
  const ctx = c.getContext('2d')
  if (!ctx) return
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const [r, g, b] = hexToRgb(hex)
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b) img.data[i + 3] = 0
  }
  ctx.putImageData(img, 0, 0)
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  c.getContext('2d')?.drawImage(src, 0, 0)
  return c
}

// ---------------------------------------------------------------- menu bar

interface PMenuItem {
  label?: string
  shortcut?: string
  action?: () => void
  disabled?: boolean
  checked?: boolean
  divider?: boolean
  sub?: PMenuItem[]
}

interface PMenu {
  title: string
  items: PMenuItem[]
}

function MenuDrop({ items, onClose }: { items: PMenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null)
  return (
    <ul className="max-h-72 min-w-44 overflow-y-auto rounded-md border border-stone-300 bg-stone-50 py-1 shadow-xl shadow-stone-950/30">
      {items.map((item, i) =>
        item.divider ? (
          <li key={i} aria-hidden className="mx-2 my-1 border-t border-stone-200" />
        ) : (
          <li key={i} className="relative" onPointerEnter={() => setOpenSub(item.sub ? i : null)}>
            <button
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.sub) return
                item.action?.()
                onClose()
              }}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                item.disabled
                  ? 'cursor-default text-stone-400'
                  : 'cursor-pointer text-stone-700 hover:bg-blue-600/10'
              }`}
            >
              <span className="w-3 shrink-0 text-blue-700">{item.checked ? '✓' : ''}</span>
              <span className="flex-1 whitespace-nowrap">{item.label}</span>
              {item.shortcut && <span className="ml-4 text-[10px] text-stone-400">{item.shortcut}</span>}
              {item.sub && <span className="text-stone-500">▸</span>}
            </button>
            {item.sub && openSub === i && (
              <div className="absolute top-[-5px] left-full z-10 pl-0.5">
                <MenuDrop items={item.sub} onClose={onClose} />
              </div>
            )}
          </li>
        ),
      )}
    </ul>
  )
}

function MenuBar({ menus }: { menus: PMenu[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="relative z-40 flex shrink-0 border-b border-stone-300 bg-stone-100 px-0.5 select-none">
      {open !== null && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(null)}
          className="fixed inset-0 cursor-default"
        />
      )}
      {menus.map((m, i) => (
        <div key={m.title} className="relative">
          <button
            type="button"
            onClick={() => {
              sounds.click()
              setOpen(open === i ? null : i)
            }}
            onPointerEnter={() => open !== null && setOpen(i)}
            className={`cursor-pointer px-2.5 py-1 text-xs ${
              open === i ? 'bg-blue-600 text-white' : 'text-stone-700 hover:bg-blue-600/10'
            }`}
          >
            {m.title}
          </button>
          {open === i && (
            <div className="absolute top-full left-0 z-10">
              <MenuDrop items={m.items} onClose={() => setOpen(null)} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- dialogs

function PaintDialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-stone-900/20">
      <div className="w-72 overflow-hidden rounded-md border border-blue-800 bg-stone-100 shadow-2xl shadow-stone-950/40">
        <div className="flex items-center bg-gradient-to-b from-blue-600 to-blue-700 px-2.5 py-1.5">
          <p className="flex-1 text-xs font-semibold text-white">{title}</p>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="flex size-4.5 cursor-pointer items-center justify-center rounded-sm bg-white/15 text-[10px] text-white hover:bg-white/30"
          >
            ✕
          </button>
        </div>
        <div className="p-3 text-xs text-stone-700">{children}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the app

type Op =
  | { kind: 'marquee'; start: Pt }
  | { kind: 'textbox'; start: Pt }
  | { kind: 'lasso'; pts: Pt[]; snapshot: ImageData }
  | { kind: 'float'; dx: number; dy: number }
  | { kind: 'stroke'; last: Pt; draw: (ctx: C2D, x0: number, y0: number, x1: number, y1: number) => void }
  | { kind: 'shape'; start: Pt; snapshot: ImageData; stroke: string; fill: string }
  | { kind: 'curve' }
  | { kind: 'poly' }
  | { kind: 'air' }

interface CurveState {
  p0: Pt
  p1: Pt
  cp1: Pt | null
  cp2: Pt | null
  stroke: string
  lw: number
  snapshot: ImageData
  phase: 'line' | 'c1' | 'c2'
}

interface PolyState {
  pts: Pt[]
  snapshot: ImageData
  stroke: string
  fill: string
  lw: number
  mode: FillMode
}

interface PaintProps {
  close: () => void
  setTitle: (t: string) => void
}

export function PaintApp({ close, setTitle }: PaintProps) {
  const [tool, setToolState] = useState<Tool>('pencil')
  const [fg, setFg] = useState('#000000')
  const [bg, setBg] = useState('#ffffff')
  const [palette, setPalette] = useState(DEFAULT_PALETTE)
  const [lineW, setLineW] = useState(1)
  const [brushShape, setBrushShape] = useState<BrushShape>('round')
  const [brushSize, setBrushSize] = useState(5)
  const [eraserSize, setEraserSize] = useState(6)
  const [airSize, setAirSize] = useState(8)
  const [fillMode, setFillMode] = useState<FillMode>('outline')
  const [opaqueMode, setOpaqueMode] = useState(true)
  const [textSize, setTextSize] = useState(12)
  const [zoom, setZoom] = useState(1)
  const [magLevel, setMagLevel] = useState(2)
  const [canvasSize, setCanvasSize] = useState({ w: DEFAULT_W, h: DEFAULT_H })
  const [sel, setSel] = useState<Rect | null>(null)
  const [textBox, setTextBox] = useState<Rect | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [fileName, setFileName] = useState('untitled.png')
  const [hasClip, setHasClip] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [dialog, setDialog] = useState<null | 'attributes' | 'about' | 'help'>(null)
  const [attrW, setAttrW] = useState(String(DEFAULT_W))
  const [attrH, setAttrH] = useState(String(DEFAULT_H))
  const [showTools, setShowTools] = useState(true)
  const [showColors, setShowColors] = useState(true)
  const [showStatus, setShowStatus] = useState(true)

  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const coordsRef = useRef<HTMLSpanElement>(null)
  const dimsRef = useRef<HTMLSpanElement>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)
  const colorTargetRef = useRef<number | 'fg'>('fg')

  const opRef = useRef<Op | null>(null)
  const curveRef = useRef<CurveState | null>(null)
  const polyRef = useRef<PolyState | null>(null)
  const lassoRef = useRef<Pt[] | null>(null)
  const floatRef = useRef<{ canvas: HTMLCanvasElement; base: ImageData } | null>(null)
  const selRef = useRef<Rect | null>(null)
  const clipRef = useRef<HTMLCanvasElement | null>(null)
  const undoRef = useRef<ImageData[]>([])
  const redoRef = useRef<ImageData[]>([])
  const savedPathRef = useRef<string | null>(null)
  const airTimerRef = useRef<number | null>(null)
  const airPosRef = useRef<Pt>({ x: 0, y: 0 })
  const zoomCenterRef = useRef<Pt | null>(null)
  const saveMsgTimer = useRef<number | null>(null)

  useEffect(() => {
    selRef.current = sel
  }, [sel])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, DEFAULT_W, DEFAULT_H)
  }, [])

  useEffect(() => {
    setTitle(`${fileName.replace(/\.[a-z0-9]+$/i, '')} - Paint`)
  }, [fileName, setTitle])

  // keep the clicked point under the viewport center when the zoom changes
  useLayoutEffect(() => {
    const center = zoomCenterRef.current
    const sc = scrollRef.current
    if (!center || !sc) return
    zoomCenterRef.current = null
    sc.scrollLeft = center.x * zoom - sc.clientWidth / 2
    sc.scrollTop = center.y * zoom - sc.clientHeight / 2
  }, [zoom])

  useEffect(
    () => () => {
      if (airTimerRef.current !== null) window.clearInterval(airTimerRef.current)
      if (saveMsgTimer.current !== null) window.clearTimeout(saveMsgTimer.current)
    },
    [],
  )

  const getCtx = () =>
    canvasRef.current?.getContext('2d', { willReadFrequently: true }) ?? null

  /** pointer position mapped from the zoomed element to canvas pixels */
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const rect = c.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    }
  }

  const clampPt = (p: Pt): Pt => {
    const c = canvasRef.current
    if (!c) return p
    return { x: Math.max(0, Math.min(c.width, p.x)), y: Math.max(0, Math.min(c.height, p.y)) }
  }

  const normRect = (a: Pt, b: Pt): Rect => {
    const p0 = clampPt(a)
    const p1 = clampPt(b)
    return {
      x: Math.round(Math.min(p0.x, p1.x)),
      y: Math.round(Math.min(p0.y, p1.y)),
      w: Math.round(Math.abs(p1.x - p0.x)),
      h: Math.round(Math.abs(p1.y - p0.y)),
    }
  }

  const setCoords = (text: string) => {
    if (coordsRef.current) coordsRef.current.textContent = text
  }
  const setDims = (text: string) => {
    if (dimsRef.current) dimsRef.current.textContent = text
  }

  const flashStatus = (msg: string) => {
    setSaveMsg(msg)
    if (saveMsgTimer.current !== null) window.clearTimeout(saveMsgTimer.current)
    saveMsgTimer.current = window.setTimeout(() => setSaveMsg(''), 3000)
  }

  // ---------------------------------------------------------------- undo

  const pushUndo = (ctx: C2D) => {
    const stack = undoRef.current
    stack.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height))
    if (stack.length > MAX_UNDO) stack.shift()
    redoRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }

  const restoreSnap = (snap: ImageData) => {
    const c = canvasRef.current
    const ctx = getCtx()
    if (!c || !ctx) return
    if (c.width !== snap.width || c.height !== snap.height) {
      c.width = snap.width
      c.height = snap.height
      setCanvasSize({ w: snap.width, h: snap.height })
    }
    ctx.putImageData(snap, 0, 0)
  }

  const dropFloating = () => {
    floatRef.current = null
    lassoRef.current = null
    setSel(null)
  }

  const undo = () => {
    dropFloating()
    const ctx = getCtx()
    const snap = undoRef.current.pop()
    if (!ctx || !snap) return
    redoRef.current.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height))
    restoreSnap(snap)
    setCanUndo(undoRef.current.length > 0)
    setCanRedo(true)
    sounds.click()
  }

  const redo = () => {
    dropFloating()
    const ctx = getCtx()
    const snap = redoRef.current.pop()
    if (!ctx || !snap) return
    undoRef.current.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height))
    restoreSnap(snap)
    setCanRedo(redoRef.current.length > 0)
    setCanUndo(true)
    sounds.click()
  }

  // ---------------------------------------------------------------- selection

  const insideSel = (p: Pt) => {
    const s = selRef.current
    return Boolean(s && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h)
  }

  /** lift the selected pixels off the canvas into a floating buffer */
  const liftSelection = () => {
    const c = canvasRef.current
    const ctx = getCtx()
    const s = selRef.current
    if (!c || !ctx || !s || s.w < 1 || s.h < 1) return
    pushUndo(ctx)
    const f = document.createElement('canvas')
    f.width = s.w
    f.height = s.h
    const fctx = f.getContext('2d')
    if (!fctx) return
    const lasso = lassoRef.current
    if (lasso) {
      fctx.save()
      fctx.clip(pathFrom(lasso, s.x, s.y))
      fctx.drawImage(c, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h)
      fctx.restore()
    } else {
      fctx.drawImage(c, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h)
    }
    if (!opaqueMode) knockOutColor(f, bg)
    ctx.fillStyle = bg
    if (lasso) ctx.fill(pathFrom(lasso))
    else ctx.fillRect(s.x, s.y, s.w, s.h)
    const base = ctx.getImageData(0, 0, c.width, c.height)
    floatRef.current = { canvas: f, base }
    ctx.drawImage(f, s.x, s.y)
  }

  const commitFloating = () => {
    floatRef.current = null
    lassoRef.current = null
  }

  const deleteSelection = () => {
    const ctx = getCtx()
    const s = selRef.current
    if (!ctx || !s) return
    if (floatRef.current) {
      ctx.putImageData(floatRef.current.base, 0, 0)
      dropFloating()
    } else {
      pushUndo(ctx)
      ctx.fillStyle = bg
      if (lassoRef.current) ctx.fill(pathFrom(lassoRef.current))
      else ctx.fillRect(s.x, s.y, s.w, s.h)
      lassoRef.current = null
      setSel(null)
    }
  }

  const copySelection = () => {
    const s = selRef.current
    const c = canvasRef.current
    if (!s || !c || s.w < 1 || s.h < 1) return
    if (floatRef.current) {
      clipRef.current = cloneCanvas(floatRef.current.canvas)
      setHasClip(true)
      return
    }
    const f = document.createElement('canvas')
    f.width = s.w
    f.height = s.h
    const fctx = f.getContext('2d')
    if (!fctx) return
    if (lassoRef.current) {
      fctx.save()
      fctx.clip(pathFrom(lassoRef.current, s.x, s.y))
      fctx.drawImage(c, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h)
      fctx.restore()
    } else {
      fctx.drawImage(c, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h)
    }
    clipRef.current = f
    setHasClip(true)
  }

  const cutSelection = () => {
    copySelection()
    deleteSelection()
  }

  const paste = () => {
    const clip = clipRef.current
    const c = canvasRef.current
    const ctx = getCtx()
    if (!clip || !c || !ctx) return
    commitText()
    commitFloating()
    pushUndo(ctx)
    const f = cloneCanvas(clip)
    if (!opaqueMode) knockOutColor(f, bg)
    const base = ctx.getImageData(0, 0, c.width, c.height)
    floatRef.current = { canvas: f, base }
    lassoRef.current = null
    ctx.drawImage(f, 0, 0)
    setSel({ x: 0, y: 0, w: f.width, h: f.height })
    setToolState('select')
  }

  const selectAll = () => {
    const c = canvasRef.current
    if (!c) return
    commitText()
    commitFloating()
    lassoRef.current = null
    setSel({ x: 0, y: 0, w: c.width, h: c.height })
    setToolState('select')
  }

  // ---------------------------------------------------------------- text

  const commitText = () => {
    const box = textBox
    const ta = textRef.current
    if (!box) return
    setTextBox(null)
    const value = ta?.value ?? ''
    if (!value.trim()) return
    const ctx = getCtx()
    if (!ctx) return
    pushUndo(ctx)
    if (opaqueMode) {
      ctx.fillStyle = bg
      ctx.fillRect(box.x, box.y, box.w, box.h)
    }
    ctx.fillStyle = fg
    ctx.font = `${textSize}px Arial, sans-serif`
    ctx.textBaseline = 'top'
    value.split('\n').forEach((line, i) => {
      ctx.fillText(line, box.x + 2, box.y + 2 + i * Math.round(textSize * 1.2), Math.max(8, box.w - 4))
    })
  }

  // ---------------------------------------------------------------- curve & polygon

  const drawCurvePreview = (ctx: C2D, cv: CurveState, cp1?: Pt | null, cp2?: Pt | null) => {
    ctx.putImageData(cv.snapshot, 0, 0)
    ctx.strokeStyle = cv.stroke
    ctx.lineWidth = cv.lw
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cv.p0.x, cv.p0.y)
    const c1 = cp1 ?? cv.cp1
    const c2 = cp2 ?? cv.cp2
    if (c1 && c2) ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, cv.p1.x, cv.p1.y)
    else if (c1) ctx.quadraticCurveTo(c1.x, c1.y, cv.p1.x, cv.p1.y)
    else ctx.lineTo(cv.p1.x, cv.p1.y)
    ctx.stroke()
  }

  const fillAndStroke = (ctx: C2D, path: Path2D, stroke: string, fill: string, lw: number, mode: FillMode) => {
    ctx.lineWidth = lw
    ctx.lineJoin = 'miter'
    if (mode !== 'outline') {
      ctx.fillStyle = mode === 'fill' ? stroke : fill
      ctx.fill(path)
    }
    if (mode !== 'fill') {
      ctx.strokeStyle = stroke
      ctx.stroke(path)
    }
  }

  const drawPolyPreview = (ctx: C2D, poly: PolyState, cursor?: Pt) => {
    ctx.putImageData(poly.snapshot, 0, 0)
    ctx.strokeStyle = poly.stroke
    ctx.lineWidth = poly.lw
    ctx.lineCap = 'round'
    ctx.beginPath()
    poly.pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)))
    if (cursor) ctx.lineTo(cursor.x, cursor.y)
    ctx.stroke()
  }

  const closePolygon = () => {
    const poly = polyRef.current
    const ctx = getCtx()
    if (!poly || !ctx) return
    polyRef.current = null
    if (poly.pts.length < 3) return
    ctx.putImageData(poly.snapshot, 0, 0)
    fillAndStroke(ctx, pathFrom(poly.pts), poly.stroke, poly.fill, poly.lw, poly.mode)
  }

  // ---------------------------------------------------------------- stamps

  const stampSegment = (x0: number, y0: number, x1: number, y1: number, stamp: (x: number, y: number) => void) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let i = 0; i <= steps; i++) {
      stamp(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)
    }
  }

  const makeBrushDraw = (color: string, shape: BrushShape, size: number) => {
    return (ctx: C2D, x0: number, y0: number, x1: number, y1: number) => {
      ctx.fillStyle = color
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      stampSegment(x0, y0, x1, y1, (x, y) => {
        if (shape === 'round') {
          ctx.beginPath()
          ctx.arc(x, y, size / 2, 0, Math.PI * 2)
          ctx.fill()
        } else if (shape === 'square') {
          ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size)
        } else {
          const d = size / 2
          ctx.beginPath()
          if (shape === 'slash') {
            ctx.moveTo(x + d, y - d)
            ctx.lineTo(x - d, y + d)
          } else {
            ctx.moveTo(x - d, y - d)
            ctx.lineTo(x + d, y + d)
          }
          ctx.stroke()
        }
      })
    }
  }

  const makeEraserDraw = (color: string, size: number) => {
    return (ctx: C2D, x0: number, y0: number, x1: number, y1: number) => {
      ctx.fillStyle = color
      stampSegment(x0, y0, x1, y1, (x, y) => {
        ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size)
      })
    }
  }

  const makePencilDraw = (color: string) => {
    return (ctx: C2D, x0: number, y0: number, x1: number, y1: number) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
  }

  const startAirbrush = (color: string, radius: number) => {
    const ctx = getCtx()
    if (!ctx) return
    const tick = () => {
      const { x, y } = airPosRef.current
      ctx.fillStyle = color
      const dots = radius * 2
      for (let i = 0; i < dots; i++) {
        const ang = Math.random() * Math.PI * 2
        const r = Math.sqrt(Math.random()) * radius
        ctx.fillRect(Math.round(x + Math.cos(ang) * r), Math.round(y + Math.sin(ang) * r), 1, 1)
      }
    }
    tick()
    airTimerRef.current = window.setInterval(tick, 40)
  }

  const stopAirbrush = () => {
    if (airTimerRef.current !== null) {
      window.clearInterval(airTimerRef.current)
      airTimerRef.current = null
    }
  }

  // ---------------------------------------------------------------- shapes

  const shapePath = (t: Tool, a: Pt, b: Pt): Path2D => {
    const p = new Path2D()
    const r = normRect(a, b)
    if (t === 'rect') p.rect(r.x, r.y, r.w, r.h)
    else if (t === 'rounded-rect') p.roundRect(r.x, r.y, r.w, r.h, Math.min(8, r.w / 2, r.h / 2))
    else p.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)
    return p
  }

  const drawShapeTo = (ctx: C2D, op: Extract<Op, { kind: 'shape' }>, to: Pt) => {
    ctx.putImageData(op.snapshot, 0, 0)
    if (tool === 'line') {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = lineW
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(op.start.x, op.start.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    } else {
      fillAndStroke(ctx, shapePath(tool, op.start, to), op.stroke, op.fill, lineW, fillMode)
    }
  }

  // ---------------------------------------------------------------- cancel / tool switch

  const cancelOp = () => {
    const ctx = getCtx()
    if (textBox) {
      setTextBox(null)
      return
    }
    if (floatRef.current && ctx) {
      const snap = undoRef.current.pop()
      floatRef.current = null
      lassoRef.current = null
      setSel(null)
      if (snap) restoreSnap(snap)
      setCanUndo(undoRef.current.length > 0)
      return
    }
    if (curveRef.current && ctx) {
      ctx.putImageData(curveRef.current.snapshot, 0, 0)
      curveRef.current = null
      undoRef.current.pop()
      setCanUndo(undoRef.current.length > 0)
      return
    }
    if (polyRef.current && ctx) {
      ctx.putImageData(polyRef.current.snapshot, 0, 0)
      polyRef.current = null
      undoRef.current.pop()
      setCanUndo(undoRef.current.length > 0)
      return
    }
    setSel(null)
    lassoRef.current = null
  }

  const pickTool = (t: Tool) => {
    sounds.click()
    commitText()
    commitFloating()
    curveRef.current = null
    polyRef.current = null
    setSel(null)
    setToolState(t)
  }

  // ---------------------------------------------------------------- pointer handlers

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return
    rootRef.current?.focus({ preventScroll: true })
    const right = e.button === 2
    const ctx = getCtx()
    if (!ctx) return
    const p = pos(e)
    const stroke = right ? bg : fg
    const fill = right ? fg : bg

    if (textBox) {
      commitText()
      return
    }

    if (tool === 'picker') {
      const cp = clampPt(p)
      const d = ctx.getImageData(
        Math.min(ctx.canvas.width - 1, Math.floor(cp.x)),
        Math.min(ctx.canvas.height - 1, Math.floor(cp.y)),
        1,
        1,
      ).data
      const hex = rgbToHex(d[0], d[1], d[2])
      if (right) setBg(hex)
      else setFg(hex)
      sounds.click()
      return
    }

    if (tool === 'magnifier') {
      sounds.click()
      if (right || zoom !== 1) {
        zoomCenterRef.current = p
        setZoom(1)
      } else {
        zoomCenterRef.current = p
        setZoom(magLevel === 1 ? 2 : magLevel)
      }
      return
    }

    if (tool === 'fill') {
      pushUndo(ctx)
      floodFill(ctx, p.x, p.y, stroke)
      sounds.click()
      return
    }

    if (tool === 'select' || tool === 'free-select') {
      if (right) return
      if (insideSel(p)) {
        if (!floatRef.current) liftSelection()
        const s = selRef.current
        if (s) opRef.current = { kind: 'float', dx: p.x - s.x, dy: p.y - s.y }
      } else {
        commitFloating()
        setSel(null)
        if (tool === 'free-select') {
          opRef.current = {
            kind: 'lasso',
            pts: [clampPt(p)],
            snapshot: ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height),
          }
        } else {
          opRef.current = { kind: 'marquee', start: p }
        }
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    if (tool === 'text') {
      if (right) return
      opRef.current = { kind: 'textbox', start: p }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    if (tool === 'curve') {
      const cv = curveRef.current
      if (!cv) {
        pushUndo(ctx)
        curveRef.current = {
          p0: p,
          p1: p,
          cp1: null,
          cp2: null,
          stroke,
          lw: lineW,
          snapshot: ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height),
          phase: 'line',
        }
      } else if (cv.phase === 'c1') {
        cv.cp1 = p
        drawCurvePreview(ctx, cv)
      } else if (cv.phase === 'c2') {
        cv.cp2 = p
        drawCurvePreview(ctx, cv)
      }
      opRef.current = { kind: 'curve' }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    if (tool === 'polygon') {
      if (!polyRef.current) {
        pushUndo(ctx)
        polyRef.current = {
          pts: [clampPt(p)],
          snapshot: ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height),
          stroke,
          fill,
          lw: lineW,
          mode: fillMode,
        }
      }
      opRef.current = { kind: 'poly' }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    if (tool === 'line' || SHAPE_TOOLS.includes(tool)) {
      pushUndo(ctx)
      opRef.current = {
        kind: 'shape',
        start: p,
        snapshot: ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height),
        stroke,
        fill,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    if (tool === 'airbrush') {
      pushUndo(ctx)
      airPosRef.current = p
      opRef.current = { kind: 'air' }
      startAirbrush(stroke, airSize)
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }

    // pencil, brush, eraser
    pushUndo(ctx)
    const draw =
      tool === 'brush'
        ? makeBrushDraw(stroke, brushShape, brushSize)
        : tool === 'eraser'
          ? makeEraserDraw(right ? fg : bg, eraserSize)
          : makePencilDraw(stroke)
    draw(ctx, p.x, p.y, p.x, p.y)
    opRef.current = { kind: 'stroke', last: p, draw }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pos(e)
    const cp = clampPt(p)
    setCoords(`${Math.round(cp.x)},${Math.round(cp.y)}`)
    const ctx = getCtx()
    const op = opRef.current
    if (!ctx) return
    if (!op) {
      // rubber-band the next polygon edge between clicks
      const poly = polyRef.current
      if (poly && tool === 'polygon') drawPolyPreview(ctx, poly, cp)
      return
    }
    switch (op.kind) {
      case 'marquee':
      case 'textbox': {
        const r = normRect(op.start, p)
        setSel(r)
        setDims(`${r.w}x${r.h}`)
        break
      }
      case 'lasso': {
        op.pts.push(cp)
        ctx.putImageData(op.snapshot, 0, 0)
        ctx.save()
        ctx.setLineDash([4, 3])
        ctx.strokeStyle = '#404040'
        ctx.lineWidth = 1
        ctx.beginPath()
        op.pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)))
        ctx.stroke()
        ctx.restore()
        break
      }
      case 'float': {
        const f = floatRef.current
        const s = selRef.current
        if (!f || !s) break
        const nx = Math.round(p.x - op.dx)
        const ny = Math.round(p.y - op.dy)
        ctx.putImageData(f.base, 0, 0)
        ctx.drawImage(f.canvas, nx, ny)
        setSel({ ...s, x: nx, y: ny })
        break
      }
      case 'stroke': {
        op.draw(ctx, op.last.x, op.last.y, p.x, p.y)
        op.last = p
        break
      }
      case 'shape': {
        drawShapeTo(ctx, op, p)
        const r = normRect(op.start, p)
        setDims(`${r.w}x${r.h}`)
        break
      }
      case 'curve': {
        const cv = curveRef.current
        if (!cv) break
        if (cv.phase === 'line') {
          cv.p1 = p
          drawCurvePreview(ctx, cv)
        } else if (cv.phase === 'c1') {
          cv.cp1 = p
          drawCurvePreview(ctx, cv)
        } else {
          cv.cp2 = p
          drawCurvePreview(ctx, cv)
        }
        break
      }
      case 'poly': {
        const poly = polyRef.current
        if (poly) drawPolyPreview(ctx, poly, cp)
        break
      }
      case 'air': {
        airPosRef.current = cp
        break
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = getCtx()
    const op = opRef.current
    opRef.current = null
    setDims('')
    if (!ctx || !op) return
    const p = pos(e)
    switch (op.kind) {
      case 'marquee': {
        const r = normRect(op.start, p)
        lassoRef.current = null
        setSel(r.w > 1 && r.h > 1 ? r : null)
        break
      }
      case 'textbox': {
        const r = normRect(op.start, p)
        setSel(null)
        if (r.w > 7 && r.h > 7) setTextBox(r)
        break
      }
      case 'lasso': {
        ctx.putImageData(op.snapshot, 0, 0)
        if (op.pts.length > 2) {
          const xs = op.pts.map((q) => q.x)
          const ys = op.pts.map((q) => q.y)
          const r = {
            x: Math.round(Math.min(...xs)),
            y: Math.round(Math.min(...ys)),
            w: Math.round(Math.max(...xs) - Math.min(...xs)),
            h: Math.round(Math.max(...ys) - Math.min(...ys)),
          }
          if (r.w > 1 && r.h > 1) {
            lassoRef.current = op.pts
            setSel(r)
          } else setSel(null)
        } else setSel(null)
        break
      }
      case 'shape': {
        drawShapeTo(ctx, op, p)
        break
      }
      case 'curve': {
        const cv = curveRef.current
        if (!cv) break
        if (cv.phase === 'line') {
          if (Math.hypot(cv.p1.x - cv.p0.x, cv.p1.y - cv.p0.y) < 2) {
            // a click with no drag starts nothing, XP wants a dragged baseline
            ctx.putImageData(cv.snapshot, 0, 0)
            curveRef.current = null
            undoRef.current.pop()
            setCanUndo(undoRef.current.length > 0)
          } else cv.phase = 'c1'
        } else if (cv.phase === 'c1') {
          cv.phase = 'c2'
        } else {
          drawCurvePreview(ctx, cv)
          curveRef.current = null
        }
        break
      }
      case 'poly': {
        const poly = polyRef.current
        if (!poly) break
        const cp = clampPt(p)
        const first = poly.pts[0]
        if (poly.pts.length > 2 && Math.hypot(cp.x - first.x, cp.y - first.y) < 5) {
          closePolygon()
        } else {
          poly.pts.push(cp)
          drawPolyPreview(ctx, poly)
        }
        break
      }
      case 'air': {
        stopAirbrush()
        break
      }
      default:
        break
    }
  }

  const onPointerCancel = () => {
    opRef.current = null
    stopAirbrush()
    setDims('')
  }

  const onDoubleClick = () => {
    if (tool === 'polygon' && polyRef.current) closePolygon()
  }

  // ---------------------------------------------------------------- file ops

  const finishPending = () => {
    commitText()
    commitFloating()
    setSel(null)
  }

  const resizeCanvasTo = (nw: number, nh: number, paint?: (ctx: C2D) => void) => {
    const c = canvasRef.current
    const ctx = getCtx()
    if (!c || !ctx) return
    c.width = nw
    c.height = nh
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, nw, nh)
    paint?.(ctx)
    setCanvasSize({ w: nw, h: nh })
  }

  const fileNew = () => {
    finishPending()
    const ctx = getCtx()
    if (!ctx) return
    pushUndo(ctx)
    resizeCanvasTo(DEFAULT_W, DEFAULT_H)
    setFileName('untitled.png')
    savedPathRef.current = null
    setZoom(1)
    sounds.open()
  }

  const fileSave = () => {
    finishPending()
    const c = canvasRef.current
    if (!c) return
    const data = c.toDataURL('image/png')
    const saved = savedPathRef.current
    if (saved && writeImage(saved, data).ok) {
      flashStatus(`Saved ${saved}`)
      sounds.open()
      return
    }
    const r = createNode('C:\\Pictures', { name: fileName, kind: 'image', src: data })
    if (r.ok) {
      savedPathRef.current = `C:\\Pictures\\${r.name}`
      setFileName(r.name)
      flashStatus(`Saved to C:\\Pictures\\${r.name}`)
    } else flashStatus(r.error)
    sounds.open()
  }

  const fileOpen = (path: string) => {
    const node = getNode(path)
    if (!node?.src) return
    finishPending()
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_W / img.width, MAX_H / img.height)
      const nw = Math.max(1, Math.round(img.width * scale))
      const nh = Math.max(1, Math.round(img.height * scale))
      undoRef.current = []
      redoRef.current = []
      setCanUndo(false)
      setCanRedo(false)
      resizeCanvasTo(nw, nh, (ctx) => ctx.drawImage(img, 0, 0, nw, nh))
      setFileName(node.name)
      savedPathRef.current = node.user ? path : null
      setZoom(1)
    }
    img.src = node.src
    sounds.open()
  }

  // ---------------------------------------------------------------- image ops

  const withClone = (fn: (tmp: HTMLCanvasElement, ctx: C2D) => void) => {
    const c = canvasRef.current
    const ctx = getCtx()
    if (!c || !ctx) return
    finishPending()
    pushUndo(ctx)
    fn(cloneCanvas(c), ctx)
  }

  const flip = (horizontal: boolean) => {
    withClone((tmp, ctx) => {
      ctx.save()
      if (horizontal) ctx.setTransform(-1, 0, 0, 1, tmp.width, 0)
      else ctx.setTransform(1, 0, 0, -1, 0, tmp.height)
      ctx.drawImage(tmp, 0, 0)
      ctx.restore()
    })
  }

  const rotate = (deg: 90 | 180 | 270) => {
    withClone((tmp) => {
      const nw = deg === 180 ? tmp.width : tmp.height
      const nh = deg === 180 ? tmp.height : tmp.width
      resizeCanvasTo(nw, nh, (ctx) => {
        ctx.save()
        if (deg === 90) {
          ctx.translate(nw, 0)
          ctx.rotate(Math.PI / 2)
        } else if (deg === 270) {
          ctx.translate(0, nh)
          ctx.rotate(-Math.PI / 2)
        } else {
          ctx.translate(nw, nh)
          ctx.rotate(Math.PI)
        }
        ctx.drawImage(tmp, 0, 0)
        ctx.restore()
      })
    })
  }

  const invertColors = () => {
    const ctx = getCtx()
    if (!ctx) return
    finishPending()
    pushUndo(ctx)
    const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255 - img.data[i]
      img.data[i + 1] = 255 - img.data[i + 1]
      img.data[i + 2] = 255 - img.data[i + 2]
    }
    ctx.putImageData(img, 0, 0)
  }

  const clearImage = () => {
    const ctx = getCtx()
    if (!ctx) return
    finishPending()
    pushUndo(ctx)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    sounds.close()
  }

  const applyAttributes = () => {
    const nw = Math.max(1, Math.min(MAX_W, Math.round(Number(attrW) || 0)))
    const nh = Math.max(1, Math.min(MAX_H, Math.round(Number(attrH) || 0)))
    setDialog(null)
    if (nw === canvasSize.w && nh === canvasSize.h) return
    withClone((tmp) => {
      resizeCanvasTo(nw, nh, (ctx) => ctx.drawImage(tmp, 0, 0))
    })
  }

  const editColor = (target: number | 'fg') => {
    colorTargetRef.current = target
    const input = colorInputRef.current
    if (!input) return
    input.value = target === 'fg' ? fg : palette[target]
    input.click()
  }

  // ---------------------------------------------------------------- keyboard

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inText = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement
    if (e.key === 'Escape') {
      cancelOp()
      return
    }
    if (inText) return
    const k = e.key.toLowerCase()
    if (e.ctrlKey || e.metaKey) {
      const handled = ['z', 'y', 'a', 's', 'x', 'c', 'v', 'e', 'i', 'n']
      if (!handled.includes(k)) return
      e.preventDefault()
      if (k === 'z') undo()
      else if (k === 'y') redo()
      else if (k === 'a') selectAll()
      else if (k === 's') fileSave()
      else if (k === 'x') cutSelection()
      else if (k === 'c') copySelection()
      else if (k === 'v') paste()
      else if (k === 'i') invertColors()
      else if (k === 'n') fileNew()
      else if (k === 'e') {
        setAttrW(String(canvasSize.w))
        setAttrH(String(canvasSize.h))
        setDialog('attributes')
      }
    } else if (e.key === 'Delete') {
      deleteSelection()
    }
  }

  // ---------------------------------------------------------------- menus

  const pictureItems: PMenuItem[] = (['C:\\Pictures', 'C:\\Pictures\\Wallpapers'] as const).flatMap(
    (dir) =>
      listDir(dir)
        .filter((n) => n.kind === 'image' && n.src)
        .map((n) => ({ label: n.name, action: () => fileOpen(joinPath(dir, n.name)) })),
  )

  const menus: PMenu[] = [
    {
      title: 'File',
      items: [
        { label: 'New', shortcut: 'Ctrl+N', action: fileNew },
        {
          label: 'Open From Pictures',
          sub: pictureItems.length ? pictureItems : [{ label: 'No pictures yet', disabled: true }],
        },
        { label: 'Save', shortcut: 'Ctrl+S', action: fileSave },
        { divider: true },
        { label: 'Exit', action: close },
      ],
    },
    {
      title: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: undo, disabled: !canUndo },
        { label: 'Repeat', shortcut: 'Ctrl+Y', action: redo, disabled: !canRedo },
        { divider: true },
        { label: 'Cut', shortcut: 'Ctrl+X', action: cutSelection, disabled: !sel },
        { label: 'Copy', shortcut: 'Ctrl+C', action: copySelection, disabled: !sel },
        { label: 'Paste', shortcut: 'Ctrl+V', action: paste, disabled: !hasClip },
        { label: 'Clear Selection', shortcut: 'Del', action: deleteSelection, disabled: !sel },
        { label: 'Select All', shortcut: 'Ctrl+A', action: selectAll },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Tool Box', checked: showTools, action: () => setShowTools((v) => !v) },
        { label: 'Color Box', checked: showColors, action: () => setShowColors((v) => !v) },
        { label: 'Status Bar', checked: showStatus, action: () => setShowStatus((v) => !v) },
        { divider: true },
        {
          label: 'Zoom',
          sub: [100, 200, 400, 600, 800].map((pct) => ({
            label: `${pct}%`,
            checked: zoom === pct / 100,
            action: () => setZoom(pct / 100),
          })),
        },
      ],
    },
    {
      title: 'Image',
      items: [
        { label: 'Flip Horizontal', action: () => flip(true) },
        { label: 'Flip Vertical', action: () => flip(false) },
        {
          label: 'Rotate',
          sub: [
            { label: '90° clockwise', action: () => rotate(90) },
            { label: '180°', action: () => rotate(180) },
            { label: '90° counterclockwise', action: () => rotate(270) },
          ],
        },
        { divider: true },
        { label: 'Invert Colors', shortcut: 'Ctrl+I', action: invertColors },
        {
          label: 'Attributes',
          shortcut: 'Ctrl+E',
          action: () => {
            setAttrW(String(canvasSize.w))
            setAttrH(String(canvasSize.h))
            setDialog('attributes')
          },
        },
        { label: 'Clear Image', action: clearImage },
        { divider: true },
        { label: 'Draw Opaque', checked: opaqueMode, action: () => setOpaqueMode((v) => !v) },
      ],
    },
    {
      title: 'Colors',
      items: [{ label: 'Edit Colors', action: () => editColor('fg') }],
    },
    {
      title: 'Help',
      items: [
        { label: 'Help Topics', action: () => setDialog('help') },
        { divider: true },
        { label: 'About Paint', action: () => setDialog('about') },
      ],
    },
  ]

  // ---------------------------------------------------------------- options box

  const optBtn = (active: boolean) =>
    `flex cursor-pointer items-center justify-center rounded-[2px] transition ${
      active ? 'bg-blue-600/25 ring-1 ring-blue-600' : 'hover:bg-blue-600/10'
    }`

  const transparencyOptions = (
    <div className="flex flex-col gap-1">
      {(
        [
          { opaque: true, src: '/os/paint/opt-opaque.png', label: 'Opaque background' },
          { opaque: false, src: '/os/paint/opt-transparent.png', label: 'Transparent background' },
        ] as const
      ).map((o) => (
        <button
          key={o.label}
          type="button"
          aria-label={o.label}
          title={o.label}
          onClick={() => {
            sounds.click()
            setOpaqueMode(o.opaque)
          }}
          className={`${optBtn(opaqueMode === o.opaque)} p-0.5`}
        >
          <img src={o.src} width={35} height={22} alt="" draggable={false} className="[image-rendering:pixelated] select-none" />
        </button>
      ))}
    </div>
  )

  const options = (() => {
    switch (tool) {
      case 'free-select':
      case 'select':
        return transparencyOptions
      case 'text':
        return (
          <div className="flex flex-col items-center gap-1.5">
            {transparencyOptions}
            <select
              aria-label="Text size"
              value={textSize}
              onChange={(e) => setTextSize(Number(e.target.value))}
              className="w-12 rounded-sm border border-stone-400 bg-white px-0.5 py-px text-[10px] text-stone-700"
            >
              {TEXT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}pt
                </option>
              ))}
            </select>
          </div>
        )
      case 'eraser':
        return (
          <div className="flex flex-col gap-0.5">
            {ERASER_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                aria-label={`Eraser size ${s}`}
                onClick={() => {
                  sounds.click()
                  setEraserSize(s)
                }}
                className={`${optBtn(eraserSize === s)} h-4 w-10`}
              >
                <span className="bg-stone-800" style={{ width: s, height: s }} />
              </button>
            ))}
          </div>
        )
      case 'magnifier':
        return (
          <div className="flex flex-col gap-0.5">
            {MAG_LEVELS.map((z) => (
              <button
                key={z}
                type="button"
                aria-label={`Magnify ${z}x`}
                onClick={() => {
                  sounds.click()
                  setMagLevel(z)
                  setZoom(z)
                }}
                className={`${optBtn(zoom === z)} h-4 w-10 font-mono text-[10px] text-stone-700`}
              >
                {z}x
              </button>
            ))}
          </div>
        )
      case 'brush':
        return (
          <div className="grid grid-cols-3 gap-px">
            {BRUSH_SHAPES.flatMap((shape) =>
              BRUSH_SIZES.map((size) => {
                const active = brushShape === shape && brushSize === size
                return (
                  <button
                    key={`${shape}-${size}`}
                    type="button"
                    aria-label={`${shape} brush, size ${size}`}
                    onClick={() => {
                      sounds.click()
                      setBrushShape(shape)
                      setBrushSize(size)
                    }}
                    className={`${optBtn(active)} size-4`}
                  >
                    {shape === 'round' && (
                      <span className="rounded-full bg-stone-800" style={{ width: size, height: size }} />
                    )}
                    {shape === 'square' && <span className="bg-stone-800" style={{ width: size, height: size }} />}
                    {(shape === 'slash' || shape === 'backslash') && (
                      <svg width={12} height={12} aria-hidden>
                        <line
                          x1={shape === 'slash' ? 6 + size / 2 : 6 - size / 2}
                          y1={6 - size / 2}
                          x2={shape === 'slash' ? 6 - size / 2 : 6 + size / 2}
                          y2={6 + size / 2}
                          stroke="#292524"
                          strokeWidth={1.4}
                        />
                      </svg>
                    )}
                  </button>
                )
              }),
            )}
          </div>
        )
      case 'airbrush':
        return (
          <div className="flex flex-col gap-0.5">
            {AIR_SIZES.map((r, i) => (
              <button
                key={r}
                type="button"
                aria-label={`Airbrush size ${r}`}
                onClick={() => {
                  sounds.click()
                  setAirSize(r)
                }}
                className={`${optBtn(airSize === r)} p-px`}
              >
                <img
                  src={`/os/paint/opt-air-${i}.png`}
                  width={24}
                  height={24}
                  alt=""
                  draggable={false}
                  className="[image-rendering:pixelated] select-none"
                />
              </button>
            ))}
          </div>
        )
      case 'line':
      case 'curve':
        return (
          <div className="flex w-full flex-col gap-0.5 px-1">
            {LINE_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`Line width ${w}`}
                onClick={() => {
                  sounds.click()
                  setLineW(w)
                }}
                className={`${optBtn(lineW === w)} h-3.5 w-full`}
              >
                <span className="w-8 bg-stone-800" style={{ height: w }} />
              </button>
            ))}
          </div>
        )
      case 'rect':
      case 'polygon':
      case 'ellipse':
      case 'rounded-rect':
        return (
          <div className="flex flex-col gap-1">
            {(
              [
                { mode: 'outline', label: 'Outline only' },
                { mode: 'both', label: 'Outline with fill' },
                { mode: 'fill', label: 'Fill only' },
              ] as const
            ).map((o) => (
              <button
                key={o.mode}
                type="button"
                aria-label={o.label}
                title={o.label}
                onClick={() => {
                  sounds.click()
                  setFillMode(o.mode)
                }}
                className={`${optBtn(fillMode === o.mode)} h-5 w-10`}
              >
                <span
                  className={`h-3 w-7 ${
                    o.mode === 'outline'
                      ? 'border border-stone-700 bg-white'
                      : o.mode === 'both'
                        ? 'border border-stone-700 bg-stone-400'
                        : 'bg-stone-700'
                  }`}
                />
              </button>
            ))}
          </div>
        )
      default:
        return null
    }
  })()

  // ---------------------------------------------------------------- render

  const toolBtn = (active: boolean) =>
    `flex size-7 cursor-pointer items-center justify-center rounded-sm border shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] ${
      active
        ? 'border-blue-600 bg-blue-600/15'
        : 'border-stone-400 bg-stone-200 hover:border-blue-600'
    }`

  const cursor =
    tool === 'text' ? 'text' : tool === 'magnifier' ? (zoom === 1 ? 'zoom-in' : 'zoom-out') : 'crosshair'

  const CANVAS_PAD = 6

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex h-full flex-col bg-stone-100 outline-none"
    >
      <MenuBar menus={menus} />

      <div className="flex min-h-0 flex-1">
        {showTools && (
          <div className="flex w-[74px] shrink-0 flex-col items-center overflow-y-auto border-r border-stone-300 bg-stone-200 p-1.5">
            <div className="grid grid-cols-2 gap-1">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-label={t.label}
                  aria-pressed={tool === t.id}
                  title={t.label}
                  onClick={() => pickTool(t.id)}
                  className={toolBtn(tool === t.id)}
                >
                  <img
                    src={`/os/paint/tool-${t.id}.png`}
                    width={16}
                    height={16}
                    alt=""
                    draggable={false}
                    className="[image-rendering:pixelated] select-none"
                  />
                </button>
              ))}
            </div>
            <div className="mt-2 flex min-h-20 w-full items-center justify-center rounded-sm border border-stone-400 bg-stone-200 p-1 shadow-[inset_0_1px_2px_rgba(0,0,0,0.15)]">
              {options}
            </div>
          </div>
        )}

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto bg-stone-300/60">
          <div className="relative inline-block" style={{ padding: CANVAS_PAD }}>
            <canvas
              ref={canvasRef}
              width={DEFAULT_W}
              height={DEFAULT_H}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onPointerLeave={() => setCoords('')}
              onDoubleClick={onDoubleClick}
              onContextMenu={(e) => e.preventDefault()}
              className="block touch-none bg-white shadow-[2px_2px_0_rgba(0,0,0,0.15)]"
              style={{
                width: canvasSize.w * zoom,
                height: canvasSize.h * zoom,
                imageRendering: zoom > 1 ? 'pixelated' : undefined,
                cursor,
              }}
            />
            {sel && !textBox && (
              <div
                aria-hidden
                className="pointer-events-none absolute border border-dashed border-stone-700"
                style={{
                  left: CANVAS_PAD + sel.x * zoom,
                  top: CANVAS_PAD + sel.y * zoom,
                  width: sel.w * zoom,
                  height: sel.h * zoom,
                }}
              />
            )}
            {textBox && (
              <textarea
                ref={textRef}
                autoFocus
                spellCheck={false}
                data-no-focus-ring
                aria-label="Text"
                onBlur={commitText}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setTextBox(null)
                  }
                }}
                className="absolute resize-none border border-dashed border-stone-600 p-px leading-[1.2] text-current outline-none"
                style={{
                  left: CANVAS_PAD + textBox.x * zoom,
                  top: CANVAS_PAD + textBox.y * zoom,
                  width: textBox.w * zoom,
                  height: textBox.h * zoom,
                  fontFamily: 'Arial, sans-serif',
                  fontSize: textSize * zoom,
                  color: fg,
                  background: opaqueMode ? bg : 'transparent',
                }}
              />
            )}
          </div>
        </div>
      </div>

      {showColors && (
        <div className="flex shrink-0 items-center gap-2.5 border-t border-stone-300 bg-stone-200 px-2.5 py-1.5">
          <div
            aria-label="Drawing colors"
            title="Left color draws, right color erases. Right-click the palette to set it."
            className="relative size-8 shrink-0 rounded-sm border border-stone-400 bg-stone-100 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
          >
            <span className="absolute right-1 bottom-1 size-3.5 border border-stone-500" style={{ background: bg }} />
            <span className="absolute top-1 left-1 size-3.5 border border-stone-500" style={{ background: fg }} />
          </div>
          <div className="grid grid-flow-col grid-rows-2 gap-0.5">
            {palette.map((c, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Color ${c}`}
                title={`${c} (left sets drawing color, right sets background, double-click edits)`}
                onClick={() => {
                  sounds.click()
                  setFg(c)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  sounds.click()
                  setBg(c)
                }}
                onDoubleClick={() => editColor(i)}
                className={`size-3.5 cursor-pointer rounded-[2px] border transition hover:border-blue-600 ${
                  fg === c || bg === c ? 'border-blue-600' : 'border-stone-400'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      )}

      {showStatus && (
        <div className="flex shrink-0 items-center border-t border-stone-300 bg-stone-200 text-[11px] text-stone-500">
          <span className="min-w-0 flex-1 truncate px-2.5 py-1">{saveMsg || HINTS[tool] || DEFAULT_HINT}</span>
          <span ref={coordsRef} className="w-20 shrink-0 border-l border-stone-300 px-2 py-1" />
          <span ref={dimsRef} className="w-20 shrink-0 border-l border-stone-300 px-2 py-1">
            {canvasSize.w} x {canvasSize.h}
          </span>
        </div>
      )}

      <input
        ref={colorInputRef}
        type="color"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const hex = e.target.value
          const target = colorTargetRef.current
          if (target !== 'fg') {
            setPalette((prev) => prev.map((c, i) => (i === target ? hex : c)))
          }
          setFg(hex)
        }}
        className="pointer-events-none absolute size-0 opacity-0"
      />

      {dialog === 'attributes' && (
        <PaintDialog title="Attributes" onClose={() => setDialog(null)}>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              Width
              <input
                value={attrW}
                onChange={(e) => setAttrW(e.target.value)}
                data-no-focus-ring
                inputMode="numeric"
                className="w-16 rounded-sm border border-stone-400 bg-white px-1.5 py-0.5 text-xs"
              />
            </label>
            <label className="flex items-center gap-1.5">
              Height
              <input
                value={attrH}
                onChange={(e) => setAttrH(e.target.value)}
                data-no-focus-ring
                inputMode="numeric"
                className="w-16 rounded-sm border border-stone-400 bg-white px-1.5 py-0.5 text-xs"
              />
            </label>
          </div>
          <p className="mt-2 text-[11px] text-stone-500">Pixels, up to {MAX_W} x {MAX_H}.</p>
          <div className="mt-3 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={applyAttributes}
              className="cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-4 py-1 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
            >
              OK
            </button>
            <button
              type="button"
              onClick={() => setDialog(null)}
              className="cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-3 py-1 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
            >
              Cancel
            </button>
          </div>
        </PaintDialog>
      )}

      {dialog === 'about' && (
        <PaintDialog title="About Paint" onClose={() => setDialog(null)}>
          <div className="flex items-start gap-3">
            {xpIcon('paint', 32)}
            <div>
              <p className="font-semibold text-stone-800">Paint</p>
              <p className="mt-0.5">AlejOS version 5.1, build 2600.</p>
              <p className="mt-2 text-[11px] text-stone-500">
                Anything you save lands in C:\Pictures and survives a reboot.
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setDialog(null)}
              className="cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-4 py-1 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
            >
              OK
            </button>
          </div>
        </PaintDialog>
      )}

      {dialog === 'help' && (
        <PaintDialog title="Help Topics" onClose={() => setDialog(null)}>
          <ul className="list-disc space-y-1 pl-4">
            <li>The right mouse button draws with the background color.</li>
            <li>The curve tool wants a dragged line first, then two pulls to bend it.</li>
            <li>Double-click closes a polygon.</li>
            <li>Pick transparent in the options box to move selections without their background.</li>
          </ul>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setDialog(null)}
              className="cursor-pointer rounded-sm border border-stone-400 bg-stone-100 px-4 py-1 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-blue-600"
            >
              OK
            </button>
          </div>
        </PaintDialog>
      )}
    </div>
  )
}
