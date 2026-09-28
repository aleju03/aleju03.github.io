#!/usr/bin/env node
// Bake the procedural vehicle reflection once, outside the game's load path.
import { mkdirSync, writeFileSync } from 'node:fs'
import { openProbe } from './probe/cdp.mjs'
const probe = await openProbe({
  port: Number(process.env.PROBE_PORT ?? 5194),
  cdp: Number(process.env.PROBE_CDP ?? 9354),
  page: 'scripts/probe/vehicle-env.html', ready: '!!window.__vehicleEnv', width: 16, height: 16,
})
try {
  if (probe.errors.length) throw new Error(probe.errors.join('\n'))
  const data = await probe.evaluate('window.__vehicleEnv')
  const png = Buffer.from(data.split(',')[1], 'base64')
  mkdirSync('public/os/textures', { recursive: true })
  writeFileSync('public/os/textures/vehicle-env.png', png)
  console.log(`Baked vehicle-env.png (${png.length} bytes)`)
} finally { probe.close() }
