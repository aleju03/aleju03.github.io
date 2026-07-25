import { SESSION_EXPIRED_EVENT } from '../../events'
import type { Session } from './osContext'

/*
  Where the AlejOS session lives between visits, and — more importantly — how
  it is given up.

  The login screen remembers a signed-in account so the welcome tile offers
  one-click entry. That is only ever a cache of something the server decides:
  the token in it may be expired, swept, or minted by a server process that has
  since been replaced. The admin case makes this sharp — its sessions used to
  live only in the server's memory, so every deploy left the browser holding a
  session it believed in and the server did not. The desktop said
  "administrator" while every socket it opened was an anonymous guest, which is
  how arcade scores ended up on the board under a guest name.

  So: every socket that resumes a token watches for `badToken` in the hello
  response and calls sessionExpired() when it sees it. AlejOS listens and drops
  to the login screen. The rule is that the client never claims an identity the
  server just refused.
*/

const SESSION_KEY = 'alejos-session'

export function loadStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Session
    if (v && v.kind === 'user' && typeof v.name === 'string' && typeof v.token === 'string') {
      return v
    }
  } catch {
    /* corrupted or unavailable */
  }
  return null
}

export function storeSession(session: Session | null) {
  try {
    if (session && session.kind === 'user') {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } else {
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {
    /* storage unavailable */
  }
}

export function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* storage unavailable */
  }
}

/**
 * The server did not recognise our token. Forget it and tell the OS, which
 * sends the visitor back to the login screen rather than leaving them in a
 * session that silently acts as a guest.
 *
 * Guests have nothing to expire, so this is a no-op unless something was
 * actually stored.
 */
export function sessionExpired() {
  if (!loadStoredSession()) return
  clearStoredSession()
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}
