import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { navigate } from '../../version'

/** real <a href> so middle/cmd-click and "open in new tab" work, but left-clicks
    are intercepted for in-app (pushState) navigation between simple pages */
export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
