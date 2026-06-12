import {
  ChatCircleDotsIcon,
  FileTextIcon,
  FolderOpenIcon,
  MonitorIcon,
  PaintBrushIcon,
  TargetIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { TerminalView } from '../Terminal'
import { ProjectsApp, AboutApp } from './appWindows'
import { MessengerApp } from './MessengerApp'
import { MinesweeperApp } from './MinesweeperApp'
import { PaintApp } from './PaintApp'
import { DisplayApp } from './DisplayApp'

// the AlejOS app registry: window defaults plus how each app renders

export type AppId =
  | 'projects'
  | 'about'
  | 'terminal'
  | 'messenger'
  | 'minesweeper'
  | 'paint'
  | 'display'

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
  messenger: {
    title: 'Messenger',
    icon: <ChatCircleDotsIcon size={15} weight="fill" />,
    big: <ChatCircleDotsIcon size={34} weight="duotone" />,
    w: 500,
    h: 460,
    render: () => <MessengerApp />,
  },
  minesweeper: {
    title: 'Minesweeper',
    icon: <TargetIcon size={15} weight="fill" />,
    big: <TargetIcon size={34} weight="duotone" />,
    w: 330,
    h: 470,
    render: () => <MinesweeperApp />,
  },
  paint: {
    title: 'Paint',
    icon: <PaintBrushIcon size={15} weight="fill" />,
    big: <PaintBrushIcon size={34} weight="duotone" />,
    w: 640,
    h: 490,
    render: () => <PaintApp />,
  },
  display: {
    title: 'Display Properties',
    icon: <MonitorIcon size={15} weight="fill" />,
    big: <MonitorIcon size={34} weight="duotone" />,
    w: 400,
    h: 480,
    render: (close) => <DisplayApp close={close} />,
  },
}
