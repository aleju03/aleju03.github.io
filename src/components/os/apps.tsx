import {
  ArrowSquareOutIcon,
  ChatsCircleIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  ImageSquareIcon,
  MonitorIcon,
  NotePencilIcon,
  PaintBrushIcon,
  TargetIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { TerminalView } from '../Terminal'
import { tinted } from './tinted'
import { ExplorerApp } from './ExplorerApp'
import { NotepadApp } from './NotepadApp'
import { ImageViewerApp } from './ImageViewerApp'
import { BrowserApp } from './BrowserApp'
import { ChatApp } from './ChatApp'
import { MinesweeperApp } from './MinesweeperApp'
import { PaintApp } from './PaintApp'
import { DisplayApp } from './DisplayApp'
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
    glyph: (s) => tinted('#a16207', '#fbbf24', <FolderOpenIcon size={s} weight="duotone" />),
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
    glyph: (s) => tinted('#1d4ed8', '#bfdbfe', <NotePencilIcon size={s} weight="duotone" />),
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
    glyph: (s) => tinted('#15803d', '#86efac', <ImageSquareIcon size={s} weight="duotone" />),
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
    glyph: (s) => tinted('#1d4ed8', '#93c5fd', <GlobeIcon size={s} weight="duotone" />),
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
    glyph: (s) => tinted('#7c3aed', '#ddd6fe', <ChatsCircleIcon size={s} weight="duotone" />),
    w: 640,
    h: 480,
    single: true,
    render: () => <ChatApp />,
  },
  terminal: {
    name: 'Terminal',
    glyph: (s) => tinted('#a8a29e', '#1c1917', <TerminalWindowIcon size={s} weight="duotone" />),
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
    glyph: (s) => tinted('#b91c1c', '#fca5a5', <TargetIcon size={s} weight="duotone" />),
    w: 330,
    h: 470,
    single: true,
    render: () => <MinesweeperApp />,
  },
  paint: {
    name: 'Paint',
    glyph: (s) => tinted('#c2410c', '#fdba74', <PaintBrushIcon size={s} weight="duotone" />),
    w: 640,
    h: 490,
    single: true,
    render: () => <PaintApp />,
  },
  display: {
    name: 'Display Properties',
    glyph: (s) => tinted('#44403c', '#7dd3fc', <MonitorIcon size={s} weight="duotone" />),
    w: 400,
    h: 480,
    single: true,
    render: (ctx) => <DisplayApp close={ctx.close} />,
  },
}

export function isAppId(id: string | undefined): id is AppId {
  return Boolean(id && id in APPS)
}

/** icon for a filesystem node, shared by the desktop and Explorer */
export function glyphFor(node: FsNode | null, size: number): ReactNode {
  const folder = tinted('#a16207', '#fbbf24', <FolderIcon size={size} weight="duotone" />)
  if (!node) return folder
  switch (node.kind) {
    case 'folder':
      return folder
    case 'text':
      return tinted('#57534e', '#ffffff', <FileTextIcon size={size} weight="duotone" />)
    case 'image':
      return tinted('#15803d', '#86efac', <ImageSquareIcon size={size} weight="duotone" />)
    case 'link':
      return node.embed
        ? tinted('#1d4ed8', '#93c5fd', <GlobeIcon size={size} weight="duotone" />)
        : tinted('#1d4ed8', '#93c5fd', <ArrowSquareOutIcon size={size} weight="duotone" />)
    case 'app':
      return isAppId(node.app) ? APPS[node.app].glyph(size) : folder
  }
}
