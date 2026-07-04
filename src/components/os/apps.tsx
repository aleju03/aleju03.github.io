import type { ReactNode } from 'react'
import { TerminalView } from '../Terminal'
import { isXpIconName, xpIcon } from './xpIcon'
import { ExplorerApp } from './ExplorerApp'
import { NotepadApp } from './NotepadApp'
import { ImageViewerApp } from './ImageViewerApp'
import { BrowserApp } from './BrowserApp'
import { ChatApp } from './ChatApp'
import { MinesweeperApp } from './MinesweeperApp'
import { PaintApp } from './PaintApp'
import { DisplayApp } from './DisplayApp'
import { PongApp } from './games/PongApp'
import { SnakeApp } from './games/SnakeApp'
import { MemoryApp } from './games/MemoryApp'
import { Game2048App } from './games/Game2048App'
import { WhackApp } from './games/WhackApp'
import { FlappyApp } from './games/FlappyApp'
import { VsrgApp } from './games/VsrgApp'
import { MineDuelApp } from './games/MineDuelApp'
import type { FsNode } from './fs'

/*
  The AlejOS app registry: window defaults plus how each app renders. Apps
  receive an AppCtx so they can close their window, retitle it (Explorer
  shows the current folder, Notepad the open file) and read launch props —
  which path to open, which url to load. single marks apps that focus their
  existing window instead of spawning another.
*/

export type AppId =
  | 'explorer'
  | 'notepad'
  | 'viewer'
  | 'browser'
  | 'chat'
  | 'terminal'
  | 'minesweeper'
  | 'paint'
  | 'display'
  | 'pong'
  | 'snake'
  | 'memory'
  | '2048'
  | 'whack'
  | 'flappy'
  | 'vsrg'
  | 'mineduel'

export interface AppCtx {
  winId: string
  props: Record<string, unknown>
  close: () => void
  setTitle: (title: string) => void
}

export interface AppDef {
  name: string
  glyph: (size: number) => ReactNode
  w: number
  h: number
  /** focus the running instance instead of opening another window */
  single?: boolean
  render: (ctx: AppCtx) => ReactNode
}

export const APPS: Record<AppId, AppDef> = {
  explorer: {
    name: 'File Explorer',
    glyph: (s) => xpIcon('folder-open', s),
    w: 680,
    h: 470,
    render: (ctx) => (
      <ExplorerApp
        winId={ctx.winId}
        initialPath={typeof ctx.props.path === 'string' ? ctx.props.path : undefined}
        setTitle={ctx.setTitle}
      />
    ),
  },
  notepad: {
    name: 'Notepad',
    glyph: (s) => xpIcon('notepad', s),
    w: 500,
    h: 420,
    render: (ctx) => (
      <NotepadApp
        path={typeof ctx.props.path === 'string' ? ctx.props.path : undefined}
        setTitle={ctx.setTitle}
      />
    ),
  },
  viewer: {
    name: 'Image Viewer',
    glyph: (s) => xpIcon('image-file', s),
    w: 560,
    h: 440,
    render: (ctx) => (
      <ImageViewerApp
        path={typeof ctx.props.path === 'string' ? ctx.props.path : undefined}
        setTitle={ctx.setTitle}
      />
    ),
  },
  browser: {
    name: 'Internet Explorer',
    glyph: (s) => xpIcon('ie', s),
    w: 760,
    h: 540,
    render: (ctx) => (
      <BrowserApp
        url={typeof ctx.props.url === 'string' ? ctx.props.url : undefined}
        setTitle={ctx.setTitle}
      />
    ),
  },
  chat: {
    name: 'Chat Rooms',
    glyph: (s) => xpIcon('messenger', s),
    w: 640,
    h: 480,
    single: true,
    render: () => <ChatApp />,
  },
  terminal: {
    name: 'Terminal',
    glyph: (s) => xpIcon('cmd', s),
    w: 560,
    h: 380,
    single: true,
    render: (ctx) => (
      <div className="h-full bg-stone-950">
        <TerminalView insideOS onExit={ctx.close} />
      </div>
    ),
  },
  minesweeper: {
    name: 'Minesweeper',
    glyph: (s) => xpIcon('minesweeper', s),
    w: 740,
    h: 620,
    single: true,
    render: () => <MinesweeperApp />,
  },
  paint: {
    name: 'Paint',
    glyph: (s) => xpIcon('paint', s),
    w: 750,
    h: 580,
    single: true,
    render: (ctx) => <PaintApp close={ctx.close} setTitle={ctx.setTitle} />,
  },
  display: {
    name: 'Display Properties',
    glyph: (s) => xpIcon('display', s),
    w: 400,
    h: 480,
    single: true,
    render: (ctx) => <DisplayApp close={ctx.close} />,
  },
  pong: {
    name: 'Pong',
    glyph: (s) => xpIcon('pong', s),
    w: 560,
    h: 460,
    single: true,
    render: () => <PongApp />,
  },
  snake: {
    name: 'Snake',
    glyph: (s) => xpIcon('snake', s),
    w: 460,
    h: 520,
    single: true,
    render: () => <SnakeApp />,
  },
  memory: {
    name: 'Memory Match',
    glyph: (s) => xpIcon('memory', s),
    w: 480,
    h: 540,
    single: true,
    render: () => <MemoryApp />,
  },
  '2048': {
    name: '2048',
    glyph: (s) => xpIcon('2048', s),
    w: 420,
    h: 540,
    single: true,
    render: () => <Game2048App />,
  },
  whack: {
    name: 'Whack-A-Mole',
    glyph: (s) => xpIcon('whack', s),
    w: 480,
    h: 500,
    single: true,
    render: () => <WhackApp />,
  },
  flappy: {
    name: 'Tappy Plane',
    glyph: (s) => xpIcon('flappy', s),
    w: 420,
    h: 560,
    single: true,
    render: () => <FlappyApp />,
  },
  vsrg: {
    name: 'Rhythm Keys',
    glyph: (s) => xpIcon('vsrg', s),
    w: 540,
    h: 580,
    single: true,
    render: () => <VsrgApp />,
  },
  mineduel: {
    name: 'Mine Duel',
    glyph: (s) => xpIcon('mine-duel', s),
    w: 540,
    h: 600,
    single: true,
    render: () => <MineDuelApp />,
  },
}

export function isAppId(id: string | undefined): id is AppId {
  return Boolean(id && id in APPS)
}

/** icon for a filesystem node, shared by the desktop and Explorer */
export function glyphFor(node: FsNode | null, size: number): ReactNode {
  const folder = xpIcon('folder', size)
  if (!node) return folder
  switch (node.kind) {
    case 'folder':
      return isXpIconName(node.icon) ? xpIcon(node.icon, size) : folder
    case 'text':
      return xpIcon('text-file', size)
    case 'image':
      return xpIcon('image-file', size)
    case 'link':
      return xpIcon('url', size)
    case 'app':
      return isAppId(node.app) ? APPS[node.app].glyph(size) : folder
  }
}
