import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { CaretRightIcon } from '@phosphor-icons/react'

/*
  Shared right-click menu for AlejOS: the desktop, Explorer windows and icons
  all feed it their own items. Supports separators, disabled rows, a bold
  default action and one level of hover submenus — everything the XP desktop
  menu needs. Position is relative to the surface that owns it; the menu
  flips up/left near the edges so it never runs off the screen.
*/

export interface MenuItem {
  label?: string
  icon?: ReactNode
  disabled?: boolean
  /** the double-click default action renders bold, like the real thing */
  bold?: boolean
  divider?: boolean
  sub?: MenuItem[]
  onClick?: () => void
}

interface ContextMenuProps {
  items: MenuItem[]
  x: number
  y: number
  onClose: () => void
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null)
  return (
    <ul className="w-48 rounded-md border border-stone-300 bg-stone-50 py-1 shadow-xl shadow-stone-950/30">
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
              {item.icon && <span className="text-blue-700 [&_svg]:size-3.5">{item.icon}</span>}
              <span className="flex-1 truncate">{item.label}</span>
              {item.sub && <CaretRightIcon size={11} className="text-stone-500" />}
            </button>
            {item.sub && openSub === i && (
              <div className="absolute top-[-5px] left-full z-10 pl-0.5">
                <MenuList items={item.sub} onClose={onClose} />
              </div>
            )}
          </li>
        ),
      )}
    </ul>
  )
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // flip away from the edges of the owning surface once we know our size
  useLayoutEffect(() => {
    const el = ref.current
    const surface = el?.offsetParent as HTMLElement | null
    if (!el || !surface) return
    let nx = x
    let ny = y
    if (x + el.offsetWidth > surface.clientWidth) nx = Math.max(0, x - el.offsetWidth)
    if (y + el.offsetHeight > surface.clientHeight) ny = Math.max(0, y - el.offsetHeight)
    setPos({ x: nx, y: ny })
  }, [x, y])

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
        className="absolute inset-0 z-[4400] cursor-default"
      />
      <motion.div
        ref={ref}
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
