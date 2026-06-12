import { createContext, useContext } from 'react'

/*
  The surface AlejOS exposes to the apps running inside it: open another app
  or a filesystem path, know who is logged in, log off or shut down. Provided
  by AlejOS.tsx; apps read it with useOs().
*/

export interface Session {
  kind: 'guest' | 'user'
  name: string
  /** auth token for registered users, presented to the chat server */
  token?: string
  /** the site owner, logged in with the reserved username */
  admin?: boolean
}

export interface OsApi {
  session: Session
  openApp: (app: string, props?: Record<string, unknown>) => void
  /** open a filesystem path with whatever app handles that node */
  openPath: (path: string) => void
  logOff: () => void
  shutdown: () => void
}

export const OsContext = createContext<OsApi | null>(null)

export function useOs(): OsApi {
  const api = useContext(OsContext)
  if (!api) throw new Error('useOs must be used inside AlejOS')
  return api
}
