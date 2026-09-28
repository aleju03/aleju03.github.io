#!/usr/bin/env node
// The real streamer needs canvas materials. Exercise its lifecycle in Chrome;
// geometry parity and per-step CPU measurements also run in `measure streaming`.
import { openProbe } from './probe/cdp.mjs'
const probe = await openProbe({
  port: Number(process.env.PROBE_PORT ?? 5210),
  cdp: Number(process.env.PROBE_CDP ?? 9370),
  page: 'scripts/probe/streaming.html', ready: '!!window.__streamingProbe', width: 16, height: 16,
})
try {
  console.log(await probe.evaluate('window.__streamingProbe.verify()'))
  if (probe.errors.length) throw new Error(probe.errors.join('\n'))
} finally { probe.close() }
