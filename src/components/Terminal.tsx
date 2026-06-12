import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { XIcon } from '@phosphor-icons/react'
import { showcase, secondary, more, github, linkedin, email } from '../data/projects'
import { toggleTheme } from '../theme'
import { BOOT_OS_EVENT, OPEN_TERMINAL_EVENT } from '../events'

/*
  A small typeable terminal. TerminalView is the reusable core (it also runs
  inside an AlejOS window); Terminal is the standalone overlay, opened from
  the command palette or with ctrl+`. Always dark, like a terminal should be.
*/

type AnyProject = { name: string; repo: string; live?: string }
const allProjects: AnyProject[] = [...showcase, ...secondary, ...more]
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')

const NEOFETCH_ART = String.raw`        _
  __ _ (_)
 / _' || |
| (_| || |
 \__,_|/ |
      |__/`

function Accent({ children }: { children: ReactNode }) {
  return <span className="text-blue-400">{children}</span>
}

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target={href.startsWith('mailto:') ? undefined : '_blank'}
      rel="noreferrer"
      className="text-blue-400 underline decoration-dotted underline-offset-4 hover:text-blue-300"
    >
      {children}
    </a>
  )
}

const HELP: [string, string][] = [
  ['help', 'this list'],
  ['whoami', 'who am i'],
  ['ls', 'list projects'],
  ['open <name>', 'open a project'],
  ['contact', 'how to reach me'],
  ['socials', 'github / linkedin'],
  ['neofetch', 'system info'],
  ['theme', 'toggle light/dark'],
  ['boot', 'start AlejOS'],
  ['sudo hire-me', 'try it'],
  ['clear', 'clear screen (ctrl+l)'],
  ['exit', 'close terminal'],
]

interface TerminalViewProps {
  onExit?: () => void
  /** hide the boot command when the terminal already lives inside AlejOS */
  insideOS?: boolean
}

export function TerminalView({ onExit, insideOS }: TerminalViewProps) {
  const idRef = useRef(1)
  const [lines, setLines] = useState<{ id: number; node: ReactNode }[]>(() => [
    { id: 0, node: <p className="text-stone-500">aleju shell — type <Accent>help</Accent> to get started</p> },
  ])
  const [input, setInput] = useState('')
  const historyRef = useRef<string[]>([])
  const histIdxRef = useRef(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const print = (...nodes: ReactNode[]) =>
    setLines((prev) => [...prev, ...nodes.map((node) => ({ id: idRef.current++, node }))])

  useEffect(() => {
    // focus lands after the opening animation has mounted the input
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const run = (raw: string) => {
    const cmd = raw.trim()
    print(
      <p>
        <span className="text-blue-400">aleju@portfolio</span>
        <span className="text-stone-500">:~$ </span>
        <span className="text-stone-200">{cmd}</span>
      </p>,
    )
    if (!cmd) return
    historyRef.current.push(cmd)
    histIdxRef.current = historyRef.current.length

    const [head, ...rest] = cmd.toLowerCase().split(/\s+/)
    const arg = rest.join(' ')

    switch (head) {
      case 'help':
        print(
          <div className="grid grid-cols-[10rem_1fr] gap-x-4">
            {HELP.filter(([c]) => !(insideOS && c === 'boot')).map(([c, desc]) => (
              <div key={c} className="contents">
                <span className="text-blue-400">{c}</span>
                <span className="text-stone-400">{desc}</span>
              </div>
            ))}
          </div>,
        )
        break
      case 'whoami':
      case 'about':
        print(
          <p className="max-w-prose text-stone-300">
            Alejandro Jiménez — full-stack developer from Costa Rica. React frontends, Node
            backends, and the server they run on.
          </p>,
        )
        break
      case 'ls':
      case 'projects':
        print(
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            {allProjects.map((p) => (
              <span key={p.repo} className="text-stone-300">
                {slugOf(p.name)}
                {'live' in p && p.live ? <Accent>*</Accent> : null}
              </span>
            ))}
          </p>,
          <p className="text-stone-500">
            <Accent>*</Accent> live — try <Accent>open mania-tracker</Accent>
          </p>,
        )
        break
      case 'open': {
        if (!arg) {
          print(<p className="text-stone-400">usage: open &lt;name&gt; — run <Accent>ls</Accent> to see what exists</p>)
          break
        }
        const target = allProjects.find((p) => slugOf(p.name).includes(slugOf(arg)))
        if (!target) {
          print(<p className="text-stone-400">no project matches "{arg}"</p>)
          break
        }
        const url = target.live ?? target.repo
        print(
          <p className="text-stone-300">
            opening <OutLink href={url}>{url.replace(/^https?:\/\//, '')}</OutLink>
          </p>,
        )
        window.open(url, '_blank', 'noreferrer')
        break
      }
      case 'contact':
      case 'email':
        print(
          <p className="text-stone-300">
            <OutLink href={`mailto:${email}`}>{email}</OutLink> — or run{' '}
            <Accent>sudo hire-me</Accent>
          </p>,
        )
        break
      case 'socials':
        print(
          <p className="flex gap-5">
            <OutLink href={github}>github/aleju03</OutLink>
            <OutLink href={linkedin}>linkedin</OutLink>
          </p>,
        )
        break
      case 'neofetch':
        print(
          <div className="flex gap-6">
            <pre className="text-blue-400">{NEOFETCH_ART}</pre>
            <div className="text-stone-300">
              <p>
                <Accent>aleju</Accent>@<Accent>portfolio</Accent>
              </p>
              <p className="text-stone-600">----------------</p>
              <p>name: Alejandro Jiménez</p>
              <p>role: full-stack developer</p>
              <p>location: Costa Rica</p>
              <p>stack: react / node / docker</p>
              <p>hosting: vercel + own server</p>
              <p>
                card: <Accent>npx aleju</Accent>
              </p>
            </div>
          </div>,
        )
        break
      case 'theme':
        toggleTheme()
        print(<p className="text-stone-400">theme toggled (the terminal stays dark, obviously)</p>)
        break
      case 'boot':
      case 'alejos':
        if (insideOS) {
          print(<p className="text-stone-400">AlejOS is already running</p>)
          break
        }
        print(<p className="text-stone-300">booting AlejOS...</p>)
        setTimeout(() => {
          window.dispatchEvent(new Event(BOOT_OS_EVENT))
          onExit?.()
        }, 500)
        break
      case 'sudo':
        if (arg === 'hire-me' || arg === 'hire me') {
          print(
            <p className="text-stone-500">[sudo] password for visitor: ********</p>,
            <p className="text-stone-300">
              access granted. → <OutLink href={`mailto:${email}`}>{email}</OutLink>
            </p>,
          )
        } else {
          print(
            <p className="text-stone-400">
              visitor is not in the sudoers file. this incident will be reported.
            </p>,
          )
        }
        break
      case 'clear':
        setLines([])
        break
      case 'exit':
      case 'quit':
        onExit?.()
        break
      default:
        print(
          <p className="text-stone-400">
            command not found: {head} — try <Accent>help</Accent>
          </p>,
        )
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      run(input)
      setInput('')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const h = historyRef.current
      if (h.length === 0) return
      histIdxRef.current = Math.max(0, histIdxRef.current - 1)
      setInput(h[histIdxRef.current] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const h = historyRef.current
      histIdxRef.current = Math.min(h.length, histIdxRef.current + 1)
      setInput(h[histIdxRef.current] ?? '')
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      setLines([])
    }
  }

  return (
    <div
      className="flex h-full flex-col font-mono text-[13px] leading-relaxed"
      onClick={() => {
        if (!window.getSelection()?.toString()) inputRef.current?.focus()
      }}
    >
      <div ref={scrollRef} className="flex-1 space-y-1.5 overflow-y-auto p-4">
        {lines.map((line) => (
          <div key={line.id}>{line.node}</div>
        ))}
        <div className="flex items-center gap-0">
          <span className="shrink-0 text-blue-400">aleju@portfolio</span>
          <span className="shrink-0 text-stone-500">:~$&nbsp;</span>
          <input
            ref={inputRef}
            data-no-focus-ring
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="Terminal input"
            className="w-full bg-transparent text-stone-200 caret-blue-400 outline-none focus-visible:outline-none"
          />
        </div>
      </div>
    </div>
  )
}

export function Terminal() {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_TERMINAL_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_TERMINAL_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12dvh]"
        >
          <button
            type="button"
            aria-label="Close terminal"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-stone-950/30 backdrop-blur-sm dark:bg-stone-950/60"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Terminal"
            initial={reduce ? false : { opacity: 0, scale: 0.97, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -10 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="relative flex h-[26rem] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-stone-700 bg-stone-950 shadow-2xl shadow-stone-950/40"
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stone-800 px-4">
              <span className="size-2.5 rounded-full bg-stone-700" />
              <span className="size-2.5 rounded-full bg-stone-700" />
              <span className="size-2.5 rounded-full bg-blue-500" />
              <p className="flex-1 text-center font-mono text-xs text-stone-500">
                aleju@portfolio: ~
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close terminal"
                className="cursor-pointer rounded-sm p-1 text-stone-500 hover:text-stone-200"
              >
                <XIcon size={14} weight="bold" />
              </button>
            </div>
            <TerminalView onExit={() => setOpen(false)} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
