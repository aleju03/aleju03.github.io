/*
  The footsteps, rendered offline: scripts/steps.mjs drives this page.

  One render per page load. core/sfx.ts keeps the first AudioContext it is
  handed for good, so the page swaps `window.AudioContext` for a single
  OfflineAudioContext, fires every event of a plan at its own time by
  suspending the render there (the offline clock only moves while it
  renders, so a sound fired from a suspend lands exactly on that sample) and
  hands the whole take back as raw float32. The harness reloads the page for
  the next plan. The same trick as film.ts's sounds table, stretched to a
  sequence.

  Everything is called through the modules the game calls, so a take is what
  the walk would have played: the footsteps through sfx.ts's `footstep`, the
  references (doors, the landing, a prop snap, the car) through their own
  entry points, all into the same destination with no master bus in between,
  which is exactly how the game mixes them.
*/
import * as sfx from '../../src/game/core/sfx'
import * as steps from '../../src/game/core/footsteps'
import * as V from '../../src/game/vehicles/sfx'
import type { StepSurface } from '../../src/game/core/sfx'

export interface PlanEvent {
  t: number
  fn: string
  args?: unknown[]
}

const SR = 44100

const table: Record<string, (...a: never[]) => void> = {
  step: (s: StepSurface, w: number, run: boolean) => sfx.footstep(s, w, run),
  land: (s: StepSurface, k: number) => sfx.landThump(s, k),
  set: (id: steps.StepSet) => steps.setStepSet(id, false),
  doorOpen: () => sfx.doorCreak(true),
  doorClose: () => sfx.doorCreak(false),
  latch: () => sfx.doorLatch(),
  spawnPop: (m: number) => sfx.spawnPop(m),
  propSnap: (h: number) => sfx.propSnap(h),
  carDoor: () => V.vehicleDoor(true),
  carImpact: (k: number) => V.vehicleImpact(k),
  horn: () => V.vehicleHorn(),
  engine: (secs: number) => {
    const v = V.createVehicleVoice('car')
    v.start()
    v.set(0.2, 0.2, 0, 0)
    engines.push([v, secs])
  },
}
const engines: Array<[V.VehicleVoice, number]> = []

/** render a plan; resolves to base64 float32, stereo interleaved */
export const render = async (seconds: number, events: PlanEvent[]) => {
  const off = new OfflineAudioContext(2, Math.round(SR * seconds), SR)
  const resume = off.resume.bind(off)
  ;(off as unknown as { resume: () => Promise<void> }).resume = () => Promise.resolve()
  const W = window as unknown as { AudioContext: unknown }
  W.AudioContext = function () {
    return off
  } as unknown
  // bind the context and start the door clips and the recorded steps
  // decoding before the clock starts, so a take never hears a fallback
  sfx.sharedAudio()
  await steps.preloadSteps(off)
  await new Promise((r) => setTimeout(r, 800))
  const byT = new Map<number, PlanEvent[]>()
  for (const e of events) {
    const q = Math.round(e.t * SR / 128) * 128 / SR
    byT.set(q, [...(byT.get(q) ?? []), e])
  }
  for (const [t, es] of byT) {
    void off.suspend(t).then(() => {
      // a throw here would leave the render suspended for good
      for (const e of es) {
        try {
          ;(table[e.fn] as (...a: unknown[]) => void)(...(e.args ?? []))
        } catch (err) {
          console.error(`${e.fn}(${JSON.stringify(e.args ?? [])}): ${String(err)}`)
        }
      }
      for (const [v, secs] of engines.splice(0)) {
        void off.suspend(Math.round((t + secs) * SR / 128) * 128 / SR).then(() => {
          v.stop()
          void resume()
        })
      }
      void resume()
    })
  }
  const buf = await off.startRendering()
  const L = buf.getChannelData(0)
  const R = buf.getChannelData(1)
  const out = new Float32Array(L.length * 2)
  for (let i = 0; i < L.length; i++) {
    out[2 * i] = L[i]
    out[2 * i + 1] = R[i]
  }
  const bytes = new Uint8Array(out.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
