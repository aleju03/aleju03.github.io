/*
  A private vite and a headless Chrome, driven over the DevTools protocol.

  The same recipe scripts/shoot.mjs runs inline, lifted out so the film
  harness (scripts/film.mjs) does not grow a second copy of it. The two rules
  from shoot.mjs's header hold here too: it takes its own ports (PROBE_PORT,
  PROBE_CDP) and kills only the processes it spawned, because :5173 belongs
  to whoever started it; and Chrome renders on the real GPU, because
  SwiftShader distorts every ratio worth measuring. The profile directory is
  per debugging port, so two harnesses on two ports never collide on Chrome's
  single-instance lock (a second Chrome on a shared profile silently hands its
  window to the first and connects you to the wrong page).
*/
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const waitFor = async (fn, tries, gap, what) => {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* not up yet */ }
    await sleep(gap)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Start vite on `port` and Chrome on `cdp`, open `page` and wait for `ready`
 * (an expression that turns truthy when the page is set up); `before(send)`
 * runs ahead of the navigation. Returns the
 * protocol handle and a `close()` that kills exactly what was spawned.
 */
export const openProbe = async ({ port, cdp, page, ready, width, height, keep = false, before = null }) => {
  const origin = `http://localhost:${port}`
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    stdio: 'ignore',
    env: { ...process.env, VITE_CACHE_DIR: `node_modules/.vite-probe-${port}` },
  })
  let chrome = null
  const close = () => {
    if (keep) return
    chrome?.kill()
    vite.kill()
  }
  process.on('exit', close)
  process.on('SIGINT', () => {
    close()
    process.exit(130)
  })
  await waitFor(async () => (await fetch(`${origin}/${page}`)).ok, 80, 250, 'vite')
  chrome = spawn('google-chrome-stable', [
    '--headless=new',
    `--remote-debugging-port=${cdp}`,
    '--use-angle=gl',
    '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`,
    '--no-first-run',
    `--user-data-dir=/tmp/world-probe-chrome-${cdp}`,
  ], { stdio: 'ignore' })
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()
    return list.find((t) => t.type === 'page')
  }, 80, 250, 'chrome')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const en = m.params.entry
      if (!/favicon/.test(`${en.url ?? ''} ${en.text}`)) errors.push(en.text)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push(d.exception?.description ?? d.text)
    }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval threw')
    }
    return r.result?.result?.value
  }
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  // anything that must be in place before the page's first script (a
  // matchMedia shim, an emulated media feature) goes here
  if (before) await before(send)
  await send('Page.navigate', { url: `${origin}/${page}` })
  await waitFor(() => evaluate(ready), 160, 250, 'the probe page')
  const screenshot = async (w, h) => {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
    })
    return Buffer.from(shot.result.data, 'base64')
  }
  return {
    origin,
    send,
    evaluate,
    screenshot,
    errors,
    close: () => {
      ws.close()
      close()
    },
  }
}
