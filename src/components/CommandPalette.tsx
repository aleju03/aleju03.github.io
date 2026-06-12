import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowUpRightIcon,
  BriefcaseIcon,
  ChatCircleIcon,
  EnvelopeSimpleIcon,
  GithubLogoIcon,
  HouseIcon,
  DesktopIcon,
  LinkedinLogoIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
  UserIcon,
} from '@phosphor-icons/react'
import { showcase, secondary, more, github, linkedin, email } from '../data/projects'
import type { SecondaryProject, ShowcaseProject, SmallProject } from '../data/projects'
import { shouldAutoFocusTextInput } from '../device'
import { lockPageForOverlay } from '../overlay'
import { toggleTheme } from '../theme'

import { BOOT_OS_EVENT, OPEN_PALETTE_EVENT, OPEN_TERMINAL_EVENT } from '../events'

type AnyProject = ShowcaseProject | SecondaryProject | SmallProject
const isShowcase = (p: AnyProject): p is ShowcaseProject => 'imageKind' in p

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

function goTo(hash: string) {
  if (hash === '#') {
    window.scrollTo({ top: 0 })
    return
  }
  document.querySelector(hash)?.scrollIntoView()
}

export function CommandPalette() {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const openPalette = useCallback(() => {
    setQuery('')
    setActive(0)
    setOpen(true)
  }, [])

  const closePalette = useCallback(() => {
    setOpen(false)
  }, [])

  const togglePalette = useCallback(() => {
    if (open) {
      closePalette()
    } else {
      openPalette()
    }
  }, [closePalette, open, openPalette])

  const items = useMemo<Item[]>(() => {
    const nav: Item[] = [
      { id: 'top', group: 'Navigate', label: 'Top', icon: <HouseIcon size={16} />, run: () => goTo('#') },
      { id: 'work', group: 'Navigate', label: 'Selected work', icon: <SquaresFourIcon size={16} />, run: () => goTo('#work') },
      { id: 'experience', group: 'Navigate', label: 'Experience', icon: <BriefcaseIcon size={16} />, run: () => goTo('#experience') },
      { id: 'about', group: 'Navigate', label: 'About', icon: <UserIcon size={16} />, run: () => goTo('#about') },
      { id: 'contact', group: 'Navigate', label: 'Contact', icon: <ChatCircleIcon size={16} />, run: () => goTo('#contact') },
    ]
    const projects: Item[] = [...showcase, ...secondary, ...more].map((p: AnyProject) => {
      const live = isShowcase(p) ? p.live : undefined
      const liveLabel = isShowcase(p) ? p.liveLabel : undefined
      return {
        id: p.repo,
        group: 'Projects',
        label: p.name,
        hint: live ? liveLabel : 'GitHub',
        icon: <ArrowUpRightIcon size={16} />,
        run: () => window.open(live ?? p.repo, '_blank', 'noreferrer'),
      }
    })
    const actions: Item[] = [
      { id: 'theme', group: 'Actions', label: 'Toggle theme', icon: <MoonIcon size={16} />, run: () => toggleTheme() },
      { id: 'terminal', group: 'Actions', label: 'Open terminal', hint: 'ctrl `', icon: <TerminalWindowIcon size={16} />, run: () => window.dispatchEvent(new Event(OPEN_TERMINAL_EVENT)) },
      { id: 'alejos', group: 'Actions', label: 'Boot AlejOS', hint: 'desktop mode', icon: <DesktopIcon size={16} />, run: () => window.dispatchEvent(new Event(BOOT_OS_EVENT)) },
      { id: 'email', group: 'Actions', label: 'Send an email', hint: email, icon: <EnvelopeSimpleIcon size={16} />, run: () => { location.href = `mailto:${email}` } },
      { id: 'github', group: 'Actions', label: 'Open GitHub profile', hint: 'aleju03', icon: <GithubLogoIcon size={16} />, run: () => window.open(github, '_blank', 'noreferrer') },
      { id: 'linkedin', group: 'Actions', label: 'Open LinkedIn profile', hint: 'Alejandro Jiménez', icon: <LinkedinLogoIcon size={16} />, run: () => window.open(linkedin, '_blank', 'noreferrer') },
    ]
    return [...nav, ...projects, ...actions]
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.group.toLowerCase().includes(q) ||
        i.hint?.toLowerCase().includes(q),
    )
  }, [items, query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        togglePalette()
      } else if (e.key === 'Escape') {
        closePalette()
      }
    }
    const onOpen = () => openPalette()
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen)
    }
  }, [closePalette, openPalette, togglePalette])

  useLayoutEffect(() => {
    if (!open) return

    const unlock = lockPageForOverlay()
    const raf = shouldAutoFocusTextInput()
      ? requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
      : 0

    return () => {
      if (raf) cancelAnimationFrame(raf)
      unlock()
    }
  }, [open])

  const select = (item: Item) => {
    closePalette()
    item.run()
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && filtered[active]) {
      select(filtered[active])
    }
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let lastGroup = ''

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14dvh]"
        >
          <button
            type="button"
            aria-label="Close command palette"
            onClick={closePalette}
            className="absolute inset-0 cursor-default bg-stone-950/35 dark:bg-stone-950/60 sm:backdrop-blur-sm"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={reduce ? false : { opacity: 0, scale: 0.97, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -10 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            style={{ willChange: 'transform, opacity' }}
            className="relative w-full max-w-lg overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl shadow-stone-950/20 dark:border-stone-700 dark:bg-stone-900"
          >
            <div className="flex items-center gap-3 border-b border-stone-200 px-4 dark:border-stone-800">
              <MagnifyingGlassIcon size={17} className="shrink-0 text-stone-400" />
              <input
                ref={inputRef}
                data-no-focus-ring
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onInputKey}
                placeholder="Search projects, sections, actions"
                aria-label="Search projects, sections, actions"
                className="h-12 w-full bg-transparent text-sm text-stone-900 outline-none placeholder:text-stone-400 focus-visible:outline-none dark:text-stone-100 dark:placeholder:text-stone-500"
              />
              <button
                type="button"
                aria-label="Close command palette"
                onClick={closePalette}
                className="rounded-sm border border-stone-200 px-1.5 py-0.5 font-mono text-[10px] text-stone-400 transition-colors hover:border-stone-300 hover:text-stone-600 dark:border-stone-700 dark:hover:border-stone-600 dark:hover:text-stone-200"
              >
                esc
              </button>
            </div>
            <ul ref={listRef} className="max-h-[19rem] overflow-y-auto p-2">
              {filtered.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-stone-500">
                  Nothing matches "{query}"
                </li>
              )}
              {filtered.map((item, i) => {
                const showGroup = item.group !== lastGroup
                lastGroup = item.group
                return (
                  <li key={item.id}>
                    {showGroup && (
                      <p className="px-3 pt-3 pb-1 font-mono text-xs text-stone-400 dark:text-stone-500">
                        {item.group}
                      </p>
                    )}
                    <button
                      type="button"
                      data-index={i}
                      onClick={() => select(item)}
                      onMouseMove={() => {
                        if (active !== i) setActive(i)
                      }}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                        i === active
                          ? 'bg-stone-100 text-stone-900 dark:bg-stone-800 dark:text-stone-100'
                          : 'text-stone-600 dark:text-stone-400'
                      }`}
                    >
                      <span className="text-stone-400 dark:text-stone-500">{item.icon}</span>
                      <span className="flex-1">{item.label}</span>
                      {item.hint && (
                        <span className="max-w-40 truncate font-mono text-xs text-stone-400 dark:text-stone-500">
                          {item.hint}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
