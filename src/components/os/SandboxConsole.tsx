import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { argName, type Completion, type Msg, type Tone } from '../../game/sandbox/commands'
import { MARK, stockTexture } from './paper'

/*
  The console is a receipt printer.

  Garry's Mod's chat line is a translucent grey box with white text over the
  bottom left of the screen, and so is every game's. This world already has
  a language for interface: the pause screen is a sheet of paper taped to the
  bedroom wall, the portfolio is a paper cover over a computer. So what you
  type into is a little thermal till printer parked in the bottom left corner,
  and everything it answers comes out of it on a strip of till roll: your
  command printed in bold, the result under it, a spawn as an item line with
  a dotted leader running out to the quantity like the groceries on a real
  receipt, an error in the red that two-colour thermal paper prints, other
  people's chat as it arrives. Each new line feeds the paper up one line in a
  few hard steps, which is what a stepper motor does.

  It is the chat line too, and it works with nobody else around. `/` or text
  starting with it runs a command (commands.ts, bilingual at the source);
  anything else is said out loud when the world is shared and printed back
  with a note when it is not. T and Enter open it empty, `/` opens it with the
  slash already typed. Tab completes and cycles what it could be (pencilled on
  above the line you are typing, the chosen one swiped with the same marker
  as the pause sheet); while that list is up, up and down walk it and Enter
  takes the swiped one, and otherwise they recall what you typed before. Esc
  closes it.

  Closed, it keeps printing: fresh lines stay on the strip for a few seconds
  and then fade, and when nothing on it is fresh the paper and the printer go
  away altogether (the printer stays while the world is shared, because its
  little display is where the presence line lives: who is nearby, whether the
  microphone is live).

  The paper is `paper.ts`'s stock recipe with a thinner, whiter pulp, the ink
  is literal hex because a receipt does not follow the site's theme, and the
  torn top edge is a clip path generated once. Nothing here animates anything
  but transform and opacity.
*/

/** thermal print: nearly black, a little blue, never quite solid */
const THERMAL = '#2d3036'
const THERMAL_SOFT = '#7b7d80'
/** the second colour on two-colour till roll */
const THERMAL_RED = '#b3322b'
const ROLL = '#f4f2ec'
const WIDTH = 332
/** how long a line stays readable on a closed console, then how long it fades */
const HOLD_MS = 9000
const FADE_MS = 2400

export type FeedTone = Tone | 'chat' | 'system'

/** one line on the strip. `at` is `performance.now()` when it printed */
export interface FeedLine {
  key: number
  at: number
  tone: FeedTone
  text: Msg
  right?: Msg
  /** chat only */
  name?: string
  mine?: boolean
  admin?: boolean
}

export interface SandboxConsoleProps {
  /** null closed; otherwise what the line starts with ('' or '/') */
  open: string | null
  lines: FeedLine[]
  online: boolean
  /** the printer's little display: presence and the microphone */
  status?: ReactNode
  onSubmit: (text: string) => void
  onClose: () => void
  complete: (line: string) => Completion | null
}

/** everything submitted this session, newest last; outlives a close */
const sent: string[] = []

/** the torn top edge: a zigzag with a little randomness, generated once */
const TORN = (() => {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const pts: string[] = []
  const step = 7
  for (let x = 0; x <= WIDTH; x += step) {
    const up = (x / step) % 2 === 0
    pts.push(`${x}px ${(up ? 0 : 5) + rand() * 2.2}px`)
  }
  return `polygon(${pts.join(', ')}, ${WIDTH}px 100%, 0px 100%)`
})()

const STYLE = `
@keyframes receipt-feed { from { transform: translateY(15px) } to { transform: none } }
@keyframes receipt-fade { from { opacity: 1 } to { opacity: 0 } }
@keyframes receipt-blink { 50% { opacity: 0 } }
@keyframes receipt-rise { from { transform: translateY(14px) rotate(-0.8deg); opacity: 0 } to { transform: rotate(-0.8deg); opacity: 1 } }
.receipt-lines::-webkit-scrollbar { display: none }
`

type Say = (m: Msg | undefined) => string

/**
 * The line being typed, with its pencilled usage hint and suggestions. Its own
 * component so that it mounts fresh on every opening: the seed ('' or '/')
 * is simply its initial state, and closing the console throws it away.
 */
function Composer({
  seed, online, onSubmit, onClose, complete, say,
}: {
  seed: string
  online: boolean
  onSubmit: (text: string) => void
  onClose: () => void
  complete: (line: string) => Completion | null
  say: Say
}) {
  const { t, language } = useI18n()
  const s = t.sandbox.console
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(seed)
  const [sel, setSel] = useState(0)
  const recallAt = useRef(-1)
  // set once the arrows have moved through the list, so Enter takes the pick
  // rather than sending what is typed; typing hands Enter back to the line
  const [browsing, setBrowsing] = useState(false)

  // focus a frame late: the key that opened the line is still going down,
  // and focusing inside its own keydown would type it into the box
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [])

  const completion = value.startsWith('/') ? complete(value) : null
  const suggestions = completion?.suggestions ?? []
  const pick = Math.min(sel, Math.max(0, suggestions.length - 1))
  const listed = suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0].line === value)

  const accept = (dir: 1 | -1) => {
    if (!suggestions.length) return
    setBrowsing(false)
    // a second tab on a line that already reads as the pick moves to the next
    const cur = suggestions[pick]
    const next = cur && value === cur.line ? (pick + dir + suggestions.length) % suggestions.length : pick
    setSel(next)
    setValue(suggestions[next].line)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // the line owns every key while it is up; without this the OS shell's
    // window-level handlers see them too
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (browsing && listed && suggestions[pick].line !== value) {
        setValue(suggestions[pick].line)
        setBrowsing(false)
        return
      }
      const text = value.trim()
      if (text && sent[sent.length - 1] !== text) sent.push(text)
      if (sent.length > 80) sent.shift()
      onSubmit(text)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      accept(e.shiftKey ? -1 : 1)
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && listed) {
      // with the list up, the arrows walk it; the first press lands on the
      // pick already swiped rather than skipping past it
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setSel(browsing ? (pick + step + suggestions.length) % suggestions.length : pick)
      setBrowsing(true)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      if (!sent.length) return
      const i = recallAt.current < 0 ? sent.length : recallAt.current
      const j = e.key === 'ArrowUp' ? Math.max(0, i - 1) : i + 1
      if (j >= sent.length) {
        recallAt.current = -1
        setValue('')
      } else {
        recallAt.current = j
        setValue(sent[j])
      }
      setSel(0)
    }
  }

  const cmd = completion?.command
  return (
    <div className="mt-2">
      {/* the usage, pencilled over the line once the command is known, with
          the argument being typed in bold */}
      {cmd && (
        <div className="mb-1 text-[10.5px] leading-snug" style={{ color: THERMAL_SOFT }}>
          <span>/{cmd.name}</span>
          {(cmd.args ?? []).map((a, i) => (
            <span
              key={a.name}
              className={i === completion.argIndex ? 'font-semibold' : ''}
              style={i === completion.argIndex ? { color: THERMAL } : undefined}
            >
              {' '}
              {a.optional ? `[${argName(a, language)}]` : `<${argName(a, language)}>`}
            </span>
          ))}
          <span className="block italic">{say(cmd.help)}</span>
        </div>
      )}
      {listed && (
        <ul className="mb-1.5 space-y-px text-[11px]">
          {suggestions.map((sg, i) => (
            <li key={sg.line}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSel(i)
                  setValue(sg.line)
                  inputRef.current?.focus()
                }}
                className="relative flex w-full items-baseline gap-2 text-left"
                style={{ color: i === pick ? THERMAL : THERMAL_SOFT }}
              >
                {i === pick && (
                  <span
                    aria-hidden
                    className="absolute -inset-x-1.5 inset-y-0"
                    style={{
                      background: `${MARK}55`,
                      borderRadius: '8px 12px 7px 13px',
                      transform: 'rotate(-0.6deg)',
                    }}
                  />
                )}
                <span className="relative shrink-0">{say(sg.label)}</span>
                {sg.detail && <span className="relative min-w-0 truncate italic opacity-80">{say(sg.detail)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div aria-hidden className="mb-1 overflow-hidden whitespace-nowrap" style={{ color: `${THERMAL}55` }}>
        {'= '.repeat(40)}
      </div>
      <form className="flex items-baseline gap-1.5" onSubmit={(e) => e.preventDefault()}>
        <span className="font-semibold">&gt;</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSel(0)
            setBrowsing(false)
            recallAt.current = -1
          }}
          onKeyDown={onKey}
          onBlur={onClose}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12px] font-semibold outline-none placeholder:font-normal"
          style={{ color: THERMAL, caretColor: THERMAL_RED, outline: 'none', boxShadow: 'none' }}
          placeholder={online ? s.placeholder : s.placeholderOffline}
        />
      </form>
      <p className="mt-1.5 text-[9.5px] tracking-wide" style={{ color: THERMAL_SOFT }}>
        {s.keys}
      </p>
    </div>
  )
}

export default function SandboxConsole({
  open, lines, online, status, onSubmit, onClose, complete,
}: SandboxConsoleProps) {
  const { language, t } = useI18n()
  const say: Say = (m) => (m === undefined ? '' : typeof m === 'string' ? m : m[language])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stock = useMemo(
    () => stockTexture({ base: ROLL, seed: 0x51f15e, grain: 0.45, flecks: 24, fleck: '120,120,120' }),
    [],
  )
  // the clock the fades are measured against, ticked only while something
  // closed is still on the strip. Starts at 0, which reads every line as
  // fresh for the half second until the first tick
  const [now, setNow] = useState(0)
  const newest = lines.length ? lines[lines.length - 1].at : -Infinity
  useEffect(() => {
    if (open !== null || !lines.length) return
    const tick = () => setNow(performance.now())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 500)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [open, lines.length, newest])

  // the newest line always in view while it is open, and when older lines
  // have scrolled up past the top, they fade into the paper rather than
  // being sliced in half by the edge of the strip
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setOverflow(el.scrollHeight > el.clientHeight + 1)
  }, [lines, open])

  const isOpen = open !== null
  const shown = isOpen ? lines.slice(-40) : lines.filter((l) => now - l.at < HOLD_MS + FADE_MS).slice(-8)
  const paperUp = isOpen || shown.length > 0
  if (!paperUp && !(online && status)) return null

  const fadeFor = (at: number) =>
    isOpen
      ? undefined
      : { animation: `receipt-fade ${FADE_MS}ms linear ${Math.round(HOLD_MS - (now - at))}ms forwards` }

  const line = (l: FeedLine, i: number) => {
    const style = fadeFor(l.at)
    const sep = l.tone === 'echo' && i > 0
    if (l.tone === 'item' || (l.tone === 'help' && l.right !== undefined)) {
      const help = l.tone === 'help'
      return (
        <div key={l.key} style={style} className="flex items-baseline gap-1">
          <span className={help ? 'shrink-0 font-semibold' : 'min-w-0 truncate'}>{say(l.text)}</span>
          <span
            aria-hidden
            className="mx-0.5 min-w-3 flex-1 translate-y-[-3px] border-b-2 border-dotted"
            style={{ borderColor: `${THERMAL}66` }}
          />
          <span
            className={help ? 'min-w-0 truncate text-right text-[10.5px]' : 'shrink-0 tabular-nums'}
            style={help ? { color: THERMAL_SOFT } : undefined}
          >
            {say(l.right)}
          </span>
        </div>
      )
    }
    return (
      <div key={l.key} style={style}>
        {sep && (
          <div aria-hidden className="my-1 overflow-hidden whitespace-nowrap" style={{ color: `${THERMAL}55` }}>
            {'- '.repeat(40)}
          </div>
        )}
        {l.tone === 'chat' ? (
          <p className="break-words">
            <span className="font-semibold" style={{ color: l.admin ? THERMAL_RED : THERMAL }}>
              {l.name}
            </span>
            <span style={{ color: THERMAL_SOFT }}>: </span>
            {say(l.text)}
          </p>
        ) : (
          <p
            className={`break-words ${l.tone === 'echo' || l.tone === 'help' ? 'font-semibold' : ''} ${
              l.tone === 'system' ? 'italic' : ''
            }`}
            style={{
              color: l.tone === 'err' ? THERMAL_RED : l.tone === 'system' ? THERMAL_SOFT : THERMAL,
              paddingLeft: l.tone === 'out' || l.tone === 'ok' || l.tone === 'err' ? 10 : 0,
            }}
          >
            {l.tone === 'err' && '! '}
            {say(l.text)}
          </p>
        )}
      </div>
    )
  }

  const newestShown = shown.length ? shown[shown.length - 1].at : now
  const paperFade = isOpen ? undefined : fadeFor(newestShown)?.animation
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-4 z-30 font-mono"
      style={{ width: WIDTH + 24, filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.35))' }}
    >
      <style>{STYLE}</style>
      {paperUp && (
        <div
          className="relative mx-3 -mb-2"
          style={{
            transformOrigin: 'bottom left',
            transform: 'rotate(-0.8deg)',
            animation: isOpen ? 'receipt-rise 160ms steps(4)' : paperFade,
          }}
        >
          <div
            className={`relative px-4 pt-4 pb-4 text-[11.5px] leading-[1.35] ${isOpen ? 'pointer-events-auto' : ''}`}
            style={{
              width: WIDTH,
              clipPath: TORN,
              color: THERMAL,
              backgroundColor: ROLL,
              backgroundImage: `linear-gradient(90deg, rgba(0,0,0,0.05), rgba(0,0,0,0) 12%, rgba(0,0,0,0) 88%, rgba(0,0,0,0.06)), url(${stock})`,
            }}
          >
            <div
              ref={scrollRef}
              className="receipt-lines overflow-y-auto"
              style={{
                maxHeight: isOpen ? 'min(46vh, 380px)' : 'none',
                scrollbarWidth: 'none',
                maskImage: isOpen && overflow ? 'linear-gradient(to bottom, transparent, #000 34px)' : undefined,
              }}
            >
              {/* keyed by the newest line, so every print feeds the paper up */}
              <div key={lines.length ? lines[lines.length - 1].key : 0} style={{ animation: 'receipt-feed 150ms steps(3)' }}>
                {shown.map(line)}
              </div>
            </div>
            {isOpen && (
              <Composer
                seed={open}
                online={online}
                onSubmit={onSubmit}
                onClose={onClose}
                complete={complete}
                say={say}
              />
            )}
          </div>
        </div>
      )}
      {/* the printer: a cream plastic till printer, the paper coming out of
          the slot along its top edge past a serrated tear bar, with a feed
          button, a status lamp, a little lcd for the presence line and a
          strip of masking tape somebody wrote its job on */}
      <div
        className="relative flex h-[38px] items-center gap-2.5 px-3 pt-[9px]"
        style={{
          width: WIDTH + 24,
          borderRadius: '9px 9px 12px 12px',
          background: 'linear-gradient(#e4ddcd, #d3cab6 55%, #bdb39c)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -3px 0 rgba(90,74,52,0.35), 0 2px 0 rgba(40,32,20,0.35)',
          animation: online && status ? undefined : paperFade,
        }}
      >
        {/* the slot, and the tear bar's teeth along its lip */}
        <span
          aria-hidden
          className="absolute top-[4px] right-4 left-4 h-[4px] rounded-full"
          style={{ background: '#2a2620', boxShadow: '0 1px 0 rgba(255,255,255,0.5)' }}
        />
        <svg aria-hidden className="absolute top-[1px] left-5" width={WIDTH - 16} height="5" viewBox={`0 0 ${WIDTH - 16} 5`}>
          <path
            d={`M0 5 ${Array.from({ length: Math.floor((WIDTH - 16) / 4) }, (_, i) => `L${i * 4 + 2} 1 L${i * 4 + 4} 5`).join(' ')}`}
            fill="#a8a59c"
            stroke="#77736a"
            strokeWidth="0.6"
          />
        </svg>
        {/* the tape */}
        <span
          aria-hidden
          className="absolute -top-2 -right-3 rotate-[7deg] px-2 py-[1px] font-mono text-[10px] italic"
          style={{
            background: 'linear-gradient(90deg, rgba(247,236,205,0.92), rgba(238,224,190,0.95))',
            color: '#5a4a36',
            boxShadow: '0 1px 2px rgba(60,44,26,0.3)',
            clipPath: 'polygon(2% 8%, 98% 0, 100% 92%, 0 100%)',
          }}
        >
          {t.sandbox.console.tape}
        </span>
        <span
          aria-hidden
          className="size-[7px] shrink-0 rounded-full"
          style={{
            background: online ? '#58c46a' : '#e0a236',
            boxShadow: `0 0 5px ${online ? '#58c46a' : '#e0a236'}, inset 0 -1px 1px rgba(0,0,0,0.3)`,
            animation: isOpen ? 'receipt-blink 1.1s steps(1) infinite' : undefined,
          }}
        />
        <span
          aria-hidden
          className="shrink-0 rounded-[3px] px-1.5 py-[1px] text-[7.5px] font-bold tracking-[0.12em] uppercase"
          style={{ background: '#8f877a', color: '#ece6d8', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.35)' }}
        >
          {t.sandbox.console.feed}
        </span>
        <span className="shrink-0 text-[8px] font-semibold tracking-[0.22em] uppercase" style={{ color: '#8a8070' }}>
          thermo 80
        </span>
        {status && (
          <span
            className="ml-auto truncate rounded-[3px] px-1.5 py-[1px] text-[10px]"
            style={{ background: '#a9b89c', color: '#27301f', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.35)' }}
          >
            {status}
          </span>
        )}
      </div>
    </div>
  )
}
