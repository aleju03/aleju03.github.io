import {
  EnvelopeSimpleIcon,
  FileTextIcon,
  FolderOpenIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { TerminalView } from '../Terminal'
import { ProjectsApp, AboutApp, ContactApp } from './appWindows'

// the AlejOS app registry: window defaults plus how each app renders

export type AppId = 'projects' | 'about' | 'terminal' | 'contact'

export interface AppDef {
  title: string
  /** small glyph for title bar + taskbar */
  icon: ReactNode
  /** large glyph for the desktop icon */
  big: ReactNode
  w: number
  h: number
  render: (close: () => void) => ReactNode
}

export const APPS: Record<AppId, AppDef> = {
  projects: {
    title: 'My Projects',
    icon: <FolderOpenIcon size={15} weight="fill" />,
    big: <FolderOpenIcon size={34} weight="duotone" />,
    w: 620,
    h: 440,
    render: () => <ProjectsApp />,
  },
  about: {
    title: 'about.txt — Notepad',
    icon: <FileTextIcon size={15} weight="fill" />,
    big: <FileTextIcon size={34} weight="duotone" />,
    w: 480,
    h: 420,
    render: () => <AboutApp />,
  },
  terminal: {
    title: 'Terminal',
    icon: <TerminalWindowIcon size={15} weight="fill" />,
    big: <TerminalWindowIcon size={34} weight="duotone" />,
    w: 560,
    h: 380,
    render: (close) => (
      <div className="h-full bg-stone-950">
        <TerminalView insideOS onExit={close} />
      </div>
    ),
  },
  contact: {
    title: 'New Message',
    icon: <EnvelopeSimpleIcon size={15} weight="fill" />,
    big: <EnvelopeSimpleIcon size={34} weight="duotone" />,
    w: 460,
    h: 380,
    render: () => <ContactApp />,
  },
}
