import { useEffect, useRef, useState } from 'react'
import type { Icon } from '@phosphor-icons/react'
import {
  ArrowCounterClockwiseIcon,
  CircleIcon,
  EraserIcon,
  EyedropperIcon,
  FloppyDiskIcon,
  LineSegmentIcon,
  PaintBrushIcon,
  PaintBucketIcon,
  PencilSimpleIcon,
  RectangleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { sounds } from './sounds'

/*
  Paint for AlejOS. A fixed 880x560 logical canvas, CSS-scaled to fit the
  window, with the classic toolbox on the left and the 16 VGA colors at the
  bottom. Pointer handlers draw straight to the 2d context through refs;
  React state only tracks tool, color, width and undo availability.
*/

const CW = 880
const CH = 560
const MAX_UNDO = 20

type Tool = 'pencil' | 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'fill' | 'picker'

const TOOLS: { id: Tool; label: string; icon: Icon }[] = [
  { id: 'pencil', label: 'Pencil', icon: PencilSimpleIcon },
  { id: 'brush', label: 'Brush', icon: PaintBrushIcon },
  { id: 'eraser', label: 'Eraser', icon: EraserIcon },
  { id: 'line', label: 'Line', icon: LineSegmentIcon },
  { id: 'rect', label: 'Rectangle', icon: RectangleIcon },
  { id: 'ellipse', label: 'Ellipse', icon: CircleIcon },
  { id: 'fill', label: 'Fill', icon: PaintBucketIcon },
  { id: 'picker', label: 'Pick color', icon: EyedropperIcon },
]

const PALETTE = [
  '#000000',
  '#808080',
  '#c0c0c0',
  '#ffffff',
  '#800000',
  '#ff0000',
  '#808000',
  '#ffff00',
  '#008000',
  '#00ff00',
  '#008080',
  '#00ffff',
  '#000080',
  '#0000ff',
  '#800080',
  '#ff00ff',
]

const WIDTHS: { value: number; label: string; dot: string }[] = [
  { value: 2, label: 'Small stroke', dot: 'size-1' },
  { value: 4, label: 'Medium stroke', dot: 'size-2' },
  { value: 8, label: 'Large stroke', dot: 'size-3' },
]

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** queue-based flood fill on raw ImageData, no recursion */
function floodFill(ctx: CanvasRenderingContext2D, x: number, y: number, hex: string) {
  const px = Math.floor(x)
  const py = Math.floor(y)
  if (px < 0 || py < 0 || px >= CW || py >= CH) return
  const img = ctx.getImageData(0, 0, CW, CH)
  const data = img.data
  const start = (py * CW + px) * 4
  const tr = data[start]
  const tg = data[start + 1]
  const tb = data[start + 2]
  const ta = data[start + 3]
  const [r, g, b] = hexToRgb(hex)
  if (tr === r && tg === g && tb === b && ta === 255) return
  const stack: number[] = [py * CW + px]
  while (stack.length > 0) {
    const i = stack.pop() as number
    const o = i * 4
    if (data[o] !== tr || data[o + 1] !== tg || data[o + 2] !== tb || data[o + 3] !== ta) continue
    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
    data[o + 3] = 255
    const cx = i % CW
    if (cx > 0) stack.push(i - 1)
    if (cx < CW - 1) stack.push(i + 1)
    if (i >= CW) stack.push(i - CW)
    if (i < CW * (CH - 1)) stack.push(i + CW)
  }
  ctx.putImageData(img, 0, 0)
}

interface Stroke {
  active: boolean
  startX: number
  startY: number
  lastX: number
  lastY: number
  snapshot: ImageData | null
}

export function PaintApp() {
  const [tool, setTool] = useState<Tool>('pencil')
  const [color, setColor] = useState('#000000')
  const [width, setWidth] = useState(2)
  const [canUndo, setCanUndo] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokeRef = useRef<Stroke>({
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    snapshot: null,
  })
  const undoRef = useRef<ImageData[]>([])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CW, CH)
  }, [])

  const getCtx = () => canvasRef.current?.getContext('2d') ?? null

  /** pointer position mapped from the CSS-scaled element to canvas pixels */
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const rect = c.getBoundingClientRect()
    const innerW = c.clientWidth || rect.width
    const innerH = c.clientHeight || rect.height
    return {
      x: ((e.clientX - rect.left - c.clientLeft) / innerW) * CW,
      y: ((e.clientY - rect.top - c.clientTop) / innerH) * CH,
    }
  }

  const strokeWidth = () => (tool === 'brush' ? width + 4 : tool === 'eraser' ? 14 : width)

  const pushUndo = (ctx: CanvasRenderingContext2D) => {
    const stack = undoRef.current
    stack.push(ctx.getImageData(0, 0, CW, CH))
    if (stack.length > MAX_UNDO) stack.shift()
    setCanUndo(true)
  }

  const drawSegment = (
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color
    ctx.lineWidth = strokeWidth()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }

  const drawShape = (
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (tool === 'line') {
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
    } else if (tool === 'rect') {
      ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    } else {
      ctx.ellipse(
        (x0 + x1) / 2,
        (y0 + y1) / 2,
        Math.abs(x1 - x0) / 2,
        Math.abs(y1 - y0) / 2,
        0,
        0,
        Math.PI * 2,
      )
    }
    ctx.stroke()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const ctx = getCtx()
    if (!ctx) return
    const { x, y } = pos(e)

    if (tool === 'picker') {
      const d = ctx.getImageData(
        Math.max(0, Math.min(CW - 1, Math.floor(x))),
        Math.max(0, Math.min(CH - 1, Math.floor(y))),
        1,
        1,
      ).data
      setColor(rgbToHex(d[0], d[1], d[2]))
      sounds.click()
      return
    }

    pushUndo(ctx)

    if (tool === 'fill') {
      floodFill(ctx, x, y, color)
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    const s = strokeRef.current
    s.active = true
    s.startX = x
    s.startY = y
    s.lastX = x
    s.lastY = y
    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      s.snapshot = ctx.getImageData(0, 0, CW, CH)
    } else {
      s.snapshot = null
      drawSegment(ctx, x, y, x, y)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = strokeRef.current
    if (!s.active) return
    const ctx = getCtx()
    if (!ctx) return
    const { x, y } = pos(e)
    if (s.snapshot) {
      ctx.putImageData(s.snapshot, 0, 0)
      drawShape(ctx, s.startX, s.startY, x, y)
    } else {
      drawSegment(ctx, s.lastX, s.lastY, x, y)
      s.lastX = x
      s.lastY = y
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = strokeRef.current
    if (!s.active) return
    const ctx = getCtx()
    if (ctx) {
      const { x, y } = pos(e)
      if (s.snapshot) {
        ctx.putImageData(s.snapshot, 0, 0)
        drawShape(ctx, s.startX, s.startY, x, y)
      } else {
        drawSegment(ctx, s.lastX, s.lastY, x, y)
      }
    }
    s.active = false
    s.snapshot = null
  }

  const onPointerCancel = () => {
    const s = strokeRef.current
    s.active = false
    s.snapshot = null
  }

  const undo = () => {
    const ctx = getCtx()
    const snap = undoRef.current.pop()
    if (ctx && snap) ctx.putImageData(snap, 0, 0)
    setCanUndo(undoRef.current.length > 0)
    sounds.click()
  }

  const clear = () => {
    const ctx = getCtx()
    if (!ctx) return
    pushUndo(ctx)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CW, CH)
    sounds.close()
  }

  const save = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'untitled.png'
      a.click()
      URL.revokeObjectURL(url)
    })
    sounds.open()
  }

  const raised =
    'flex size-7 cursor-pointer items-center justify-center rounded-sm border border-stone-400 bg-stone-200 text-stone-700 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 disabled:cursor-default disabled:opacity-40 disabled:hover:border-stone-400'

  const toolBtn = (active: boolean) =>
    `flex size-8 cursor-pointer items-center justify-center rounded-sm border shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] ${
      active
        ? 'border-blue-600 bg-blue-600/15 text-blue-700'
        : 'border-stone-400 bg-stone-200 text-stone-700 hover:border-blue-600'
    }`

  return (
    <div className="flex h-full flex-col bg-stone-100">
      <div className="flex items-center gap-1.5 border-b border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-600">
        <button type="button" aria-label="Undo" title="Undo" disabled={!canUndo} onClick={undo} className={raised}>
          <ArrowCounterClockwiseIcon size={14} />
        </button>
        <button type="button" aria-label="Clear canvas" title="Clear" onClick={clear} className={raised}>
          <TrashIcon size={14} />
        </button>
        <button type="button" aria-label="Save image" title="Save" onClick={save} className={raised}>
          <FloppyDiskIcon size={14} />
        </button>
        <span aria-hidden className="mx-1.5 h-4 w-px bg-stone-400/60" />
        {WIDTHS.map((w) => (
          <button
            key={w.value}
            type="button"
            aria-label={w.label}
            title={w.label}
            onClick={() => {
              sounds.click()
              setWidth(w.value)
            }}
            className={toolBtn(width === w.value).replace('size-8', 'size-7')}
          >
            <span className={`${w.dot} rounded-full bg-current`} />
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-stone-300 bg-stone-200 p-1.5">
          {TOOLS.map((t) => {
            const ToolIcon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                aria-label={t.label}
                aria-pressed={tool === t.id}
                title={t.label}
                onClick={() => {
                  sounds.click()
                  setTool(t.id)
                }}
                className={toolBtn(tool === t.id)}
              >
                <ToolIcon size={16} />
              </button>
            )
          })}
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-stone-300/50 p-3">
          <canvas
            ref={canvasRef}
            width={CW}
            height={CH}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            className="max-h-full max-w-full cursor-crosshair touch-none rounded-sm border border-stone-400 bg-white shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
          />
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-stone-300 bg-stone-200 px-3 py-1.5">
        <span
          aria-label="Current color"
          title="Current color"
          className="size-6 shrink-0 rounded-sm border border-stone-400 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
          style={{ backgroundColor: color }}
        />
        <div className="grid grid-flow-col grid-rows-2 gap-1">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Use color ${c}`}
              title={c}
              onClick={() => {
                sounds.click()
                setColor(c)
              }}
              className={`size-3.5 cursor-pointer rounded-[2px] border transition hover:border-blue-600 ${
                color === c ? 'border-blue-600' : 'border-stone-400'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <p className="border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        untitled.png · {CW} x {CH}
      </p>
    </div>
  )
}
