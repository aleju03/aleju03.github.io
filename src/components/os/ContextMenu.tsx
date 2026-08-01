import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { CaretRightIcon } from '@phosphor-icons/react'

/*
  Shared right-click menu for AlejOS: the desktop, Explorer windows and icons
  all feed it their own items. Supports separators, disabled rows, a bold
  default action, keyboard hints, checkmarks and one level of hover submenus —
  everything the XP desktop menu needs. Position is relative to the surface
  that owns it; the menu flips up/left near the edges so it never runs off
  the screen.

  MenuBar drops the same item lists into a File/Edit/View strip, so a menu
  written once serves both the right-click and the window's own menus, and
  the two can never drift into disagreeing about what Paste is called or
  whether it is available.
*/

export interface MenuItem {
  label?: string
  icon?: ReactNode
  disabled?: boolean
  /** the double-click default action renders bold, like the real thing */
  bold?: boolean
  divider?: boolean
  /** right-aligned hint: "Ctrl+C", "F2", "Del" */
  shortcut?: string
  /** view modes and toggles carry a tick in the gutter */
  checked?: boolean
  sub?: MenuItem[]
  onClick?: () => void
}

interface ContextMenuProps {
  items: MenuItem[]
  x: number
  y: number
  onClose: () => void
}

/**
 * The box a popup is allowed to live in: the nearest ancestor that clips.
 * An Explorer pane scrolls, so a submenu that opens to the right near the
 * pane's edge is not merely ugly — it is cut off, and the half of it that
 * survives sits under the cursor looking clickable while the item you wanted
 * is gone. Menus flip to the other side rather than hang off the edge.
 */
function clipBox(el: HTMLElement): { left: number; right: number } {
  let p: HTMLElement | null = el.parentElement
  while (p) {
    const s = getComputedStyle(p)
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const r = p.getBoundingClientRect()
      return { left: r.left, right: r.right }
    }
    p = p.parentElement
  }
  return { left: 0, right: window.innerWidth }
}

function SubMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [flipped, setFlipped] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clip = clipBox(el)
    // only flip if the other side actually has room, or a narrow pane would
    // just move the problem to the opposite edge
    if (rect.right > clip.right && rect.left - rect.width > clip.left) setFlipped(true)
  }, [])

  return (
    <div
      ref={ref}
      className={`absolute top-[-5px] z-10 ${flipped ? 'right-full pr-0.5' : 'left-full pl-0.5'}`}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const gutter = items.some((i) => i.checked)
  return (
    <ul className="w-52 rounded-md border border-stone-300 bg-stone-50 py-1 shadow-xl shadow-stone-950/30">
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
                item.onClick?.()
                onClose()
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                item.disabled
                  ? 'cursor-default text-stone-400'
                  : 'cursor-pointer text-stone-700 hover:bg-blue-600/10'
              } ${item.bold ? 'font-semibold' : ''}`}
            >
              {gutter && <span className="w-2.5 shrink-0 text-blue-700">{item.checked ? '✓' : ''}</span>}
              {item.icon && <span className="text-blue-700 [&_svg]:size-3.5">{item.icon}</span>}
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="shrink-0 text-[10px] text-stone-400">{item.shortcut}</span>
              )}
              {item.sub && <CaretRightIcon size={11} className="text-stone-500" />}
            </button>
            {item.sub && openSub === i && <SubMenu items={item.sub} onClose={onClose} />}
          </li>
        ),
      )}
    </ul>
  )
}

export interface Menu {
  title: string
  items: MenuItem[]
}

/**
 * The window menu strip. Once one menu is open, hovering the next opens it
 * without a second click, which is the detail that separates a menu bar from
 * a row of dropdown buttons.
 */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="relative z-30 flex shrink-0 border-b border-stone-300 bg-stone-100 px-0.5 select-none">
      {open !== null && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setOpen(null)
          }}
          className="fixed inset-0 z-0 cursor-default"
        />
      )}
      {menus.map((m, i) => (
        <div key={m.title} className="relative">
          <button
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={() => open !== null && setOpen(i)}
            className={`cursor-pointer px-2.5 py-1 text-xs ${
              open === i ? 'bg-blue-600 text-white' : 'text-stone-700 hover:bg-blue-600/10'
            }`}
          >
            {m.title}
          </button>
          {open === i && (
            <div className="absolute top-full left-0 z-10">
              <MenuList items={m.items} onClose={() => setOpen(null)} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Flip away from the edges of the owning surface once we know our size.
  // The coordinates are in the surface's own content space, so on a surface
  // that scrolls (an Explorer pane) the visible edge is scroll offset plus
  // client size, not client size — otherwise every menu opened below the
  // fold flips upward for no reason.
  useLayoutEffect(() => {
    const el = ref.current
    const surface = el?.offsetParent as HTMLElement | null
    if (!el || !surface) return
    let nx = x
    let ny = y
    if (x + el.offsetWidth > surface.scrollLeft + surface.clientWidth) {
      nx = Math.max(surface.scrollLeft, x - el.offsetWidth)
    }
    if (y + el.offsetHeight > surface.scrollTop + surface.clientHeight) {
      ny = Math.max(surface.scrollTop, y - el.offsetHeight)
    }
    setPos({ x: nx, y: ny })
  }, [x, y])

  return (
    <>
      {/* data-menu marks both layers as "not the surface underneath": a pane
          that clears its selection on pointerdown would otherwise tear its own
          menu down before the click on it ever resolved */}
      <button
        type="button"
        data-menu
        aria-label="Close menu"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
        className="fixed inset-0 z-[4400] cursor-default"
      />
      <motion.div
        ref={ref}
        data-menu
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.1 }}
        className="absolute z-[4500]"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <MenuList items={items} onClose={onClose} />
      </motion.div>
    </>
  )
}
