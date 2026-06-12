import { cloneElement, isValidElement } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'

/*
  Icons carry their own fixed colors like a real OS instead of inheriting the
  desktop ink. The stroke comes from `color`; the .icon-tone rule in index.css
  brings the duotone fill layer to full opacity and paints it with --tone.
  Duotone glyphs are not closed shapes, though: the folder flap, the front
  chat bubble, the page body are holes in the outline path, so the wallpaper
  shows through them. A fill-weight copy of the same glyph sits underneath,
  painted with --tone, to give the icon a solid body.

  Lives in its own module because Explorer calls it at module top level while
  apps.tsx (the registry) imports Explorer; keeping it inside apps.tsx made
  that cycle crash on load.
*/
export function tinted(stroke: string, tone: string, icon: ReactNode): ReactNode {
  const backing = isValidElement(icon)
    ? cloneElement(icon as ReactElement<Record<string, unknown>>, {
        weight: 'fill',
        'aria-hidden': true,
      })
    : null
  return (
    <span
      className="icon-tone relative inline-flex"
      style={{ color: stroke, '--tone': tone } as CSSProperties}
    >
      {backing && <span className="icon-tone-back absolute inset-0">{backing}</span>}
      {icon}
    </span>
  )
}
