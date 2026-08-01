import { useEffect, useRef, useState } from 'react'
import { useOs } from './osContext'
import { sounds } from './sounds'
import { APPS, isAppId } from './apps'
import { confirmBox } from './dialogs'

/*
  Task Manager, reached the way it always was: right-click the taskbar, or
  Ctrl+Shift+Esc. Applications lists the real windows and really ends them,
  Processes invents the rest of the machine around them, and Performance is
  the part that is not pretending.

  That graph is fed by actual frame timing. A screen full of numbers that a
  random walk generated is a picture of a task manager; a screen fed by
  requestAnimationFrame deltas is a task manager, because dragging a window
  across the desktop or opening the paint app visibly costs something on it.
  The mapping is deliberately generous — a frame budget missed by half counts
  for a lot of percent — since the honest reading on an idle machine is a
  flat 2% and a flat line is not what anyone opens this for.
*/

interface HeapPerformance extends Performance {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
}

const SYSTEM_PROCESSES = [
  { name: 'alejos.exe', mem: 14_212 },
  { name: 'explorer.exe', mem: 9_540 },
  { name: 'csrss.exe', mem: 3_180 },
  { name: 'winlogon.exe', mem: 2_744 },
  { name: 'services.exe', mem: 4_016 },
  { name: 'crt.sys', mem: 1_908 },
]

const HISTORY = 90

function Bar({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] text-stone-500">{label}</p>
      <div className="h-3 w-full overflow-hidden rounded-sm border border-stone-400 bg-stone-950">
        <div
          className="h-full bg-gradient-to-b from-lime-400 to-green-600 transition-[width] duration-300"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-600 tabular-nums">{sub}</p>
    </div>
  )
}

/** the XP CPU history plot: green trace on a scrolling grid */
function Graph({ history }: { history: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const w = (canvas.width = canvas.clientWidth)
    const h = (canvas.height = canvas.clientHeight)
    ctx.fillStyle = '#0a0f0a'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(74,222,128,0.16)'
    ctx.lineWidth = 1
    for (let i = 1; i < 6; i++) {
      const y = Math.round((h / 6) * i) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    for (let i = 1; i < 10; i++) {
      const x = Math.round((w / 10) * i) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    if (history.length < 2) return
    const step = w / (HISTORY - 1)
    const at = (i: number) => ({
      x: (i + (HISTORY - history.length)) * step,
      y: h - (Math.min(100, history[i]) / 100) * h,
    })
    ctx.beginPath()
    ctx.moveTo(at(0).x, h)
    history.forEach((_, i) => {
      const p = at(i)
      ctx.lineTo(p.x, p.y)
    })
    ctx.lineTo(at(history.length - 1).x, h)
    ctx.closePath()
    ctx.fillStyle = 'rgba(74,222,128,0.22)'
    ctx.fill()
    ctx.beginPath()
    history.forEach((_, i) => {
      const p = at(i)
      if (i) ctx.lineTo(p.x, p.y)
      else ctx.moveTo(p.x, p.y)
    })
    ctx.strokeStyle = '#4ade80'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }, [history])
  return <canvas ref={ref} className="block h-28 w-full rounded-sm border border-stone-400" />
}

export function TaskManagerApp() {
  const os = useOs()
  const [tab, setTab] = useState<'apps' | 'processes' | 'performance'>('apps')
  const [picked, setPicked] = useState<string | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [cpu, setCpu] = useState(0)
  // `last` is stamped by the first frame rather than at construction: reading
  // the clock during render is a side effect, and the first delta is thrown
  // away anyway
  const frames = useRef({ count: 0, worst: 0, last: 0 })

  // sample the main thread: how many frames arrived in the last second, and
  // how bad the worst one was. Both matter — a stall shows up in the worst
  // frame long before it shows up in the count.
  useEffect(() => {
    let raf = 0
    frames.current.last = performance.now()
    const tick = (now: number) => {
      const dt = now - frames.current.last
      frames.current.last = now
      frames.current.count += 1
      frames.current.worst = Math.max(frames.current.worst, dt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const id = window.setInterval(() => {
      const { count, worst } = frames.current
      frames.current.count = 0
      frames.current.worst = 0
      const dropped = Math.max(0, 1 - count / 60)
      const stall = Math.max(0, worst - 17) / 17
      const load = Math.min(100, Math.round(dropped * 90 + stall * 12 + 2))
      setCpu(load)
      setHistory((prev) => [...prev, load].slice(-HISTORY))
    }, 1000)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(id)
    }
  }, [])

  const heap = (performance as HeapPerformance).memory
  const memUsedMb = heap ? heap.usedJSHeapSize / 1_048_576 : 128 + os.tasks.length * 11
  const memTotalMb = 512
  const appProcesses = os.tasks.map((t) => ({
    name: `${isAppId(t.app) ? t.app : 'app'}.exe`,
    mem: 6_000 + t.title.length * 137 + t.id.length * 211,
    task: t,
  }))

  const endTask = async (id: string, title: string) => {
    const ok = await confirmBox(
      'End Program',
      `${title} is not responding.\nEnd this program now? Anything unsaved in it will be lost.`,
      { icon: 'warn', yes: 'End Now', no: 'Cancel' },
    )
    if (ok) os.closeWindow(id)
  }

  const tabBtn = (id: typeof tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => {
        sounds.click()
        setTab(id)
      }}
      className={`cursor-pointer rounded-t-sm border border-b-0 px-3 py-1 text-xs ${
        tab === id
          ? 'border-stone-300 bg-stone-100 text-stone-800'
          : 'border-transparent text-stone-500 hover:text-stone-700'
      }`}
    >
      {label}
    </button>
  )

  const btn =
    'cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-3 py-1 text-xs text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50 disabled:cursor-default disabled:opacity-50 disabled:hover:border-stone-400 disabled:hover:bg-stone-200'

  return (
    <div className="flex h-full flex-col bg-stone-100">
      <div className="flex shrink-0 gap-1 border-b border-stone-300 bg-stone-200 px-2 pt-2">
        {tabBtn('apps', 'Applications')}
        {tabBtn('processes', 'Processes')}
        {tabBtn('performance', 'Performance')}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'apps' && (
          <div className="overflow-hidden rounded-sm border border-stone-400 bg-white">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-stone-300 bg-stone-200 text-stone-600">
                  <th className="px-2 py-1 text-left font-normal">Task</th>
                  <th className="w-28 px-2 py-1 text-left font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {os.tasks.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-2 py-3 text-stone-400">
                      No tasks are running.
                    </td>
                  </tr>
                ) : (
                  os.tasks.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => setPicked(t.id)}
                      onDoubleClick={() => os.focusWindow(t.id)}
                      className={`cursor-pointer ${
                        picked === t.id ? 'bg-blue-600 text-white' : 'hover:bg-blue-600/10'
                      }`}
                    >
                      <td className="px-2 py-1">{t.title}</td>
                      <td className="px-2 py-1">{t.minimized ? 'Minimized' : 'Running'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'processes' && (
          <div className="overflow-hidden rounded-sm border border-stone-400 bg-white">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-stone-300 bg-stone-200 text-stone-600">
                  <th className="px-2 py-1 text-left font-normal">Image Name</th>
                  <th className="w-20 px-2 py-1 text-left font-normal">User</th>
                  <th className="w-16 px-2 py-1 text-right font-normal">CPU</th>
                  <th className="w-24 px-2 py-1 text-right font-normal">Mem Usage</th>
                </tr>
              </thead>
              <tbody>
                {SYSTEM_PROCESSES.map((p, i) => (
                  <tr key={p.name} className="text-stone-700">
                    <td className="px-2 py-1">{p.name}</td>
                    <td className="px-2 py-1 text-stone-500">SYSTEM</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {i === 0 ? `${String(Math.max(1, cpu - 2)).padStart(2, '0')}` : '00'}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {p.mem.toLocaleString()} K
                    </td>
                  </tr>
                ))}
                {appProcesses.map((p) => (
                  <tr key={p.task.id} className="text-stone-700">
                    <td className="px-2 py-1">{p.name}</td>
                    <td className="px-2 py-1 text-stone-500">{os.session.name}</td>
                    <td className="px-2 py-1 text-right tabular-nums">00</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {p.mem.toLocaleString()} K
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'performance' && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-[11px] text-stone-500">CPU Usage History</p>
              <Graph history={history} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Bar label="CPU Usage" value={cpu} sub={`${cpu}%`} />
              <Bar
                label="Memory"
                value={(memUsedMb / memTotalMb) * 100}
                sub={`${Math.round(memUsedMb)} MB / ${memTotalMb} MB`}
              />
            </div>
            <div className="rounded-sm border border-stone-300 bg-white p-2 text-[11px] text-stone-500">
              <p>
                Processes: {SYSTEM_PROCESSES.length + appProcesses.length} · Windows:{' '}
                {os.tasks.length} · Apps installed: {Object.keys(APPS).length}
              </p>
              <p className="mt-1">
                The graph is this tab's own frame timing, so it really does climb when the machine
                is working.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-stone-300 bg-stone-200 px-3 py-2">
        <span className="mr-auto font-mono text-[11px] text-stone-500 tabular-nums">
          CPU {cpu}% · Processes {SYSTEM_PROCESSES.length + appProcesses.length}
        </span>
        {tab === 'apps' && (
          <>
            <button
              type="button"
              className={btn}
              disabled={!picked}
              onClick={() => {
                const t = os.tasks.find((x) => x.id === picked)
                if (t) void endTask(t.id, t.title)
              }}
            >
              End Task
            </button>
            <button
              type="button"
              className={btn}
              disabled={!picked}
              onClick={() => picked && os.focusWindow(picked)}
            >
              Switch To
            </button>
          </>
        )}
      </div>
    </div>
  )
}
