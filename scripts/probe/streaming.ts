import * as THREE from 'three'
import { buildWorld } from '../../src/game/world/streamer'
import type { Chunk } from '../../src/game/world/chunk'
import { CHUNK, originX, originZ } from '../../src/game/world/grid'
import { windUniforms } from '../../src/game/world/wind'
import { PREBORN } from '../../src/game/world/fade'
import { setGfxTier } from '../../src/game/world/quality'

const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

const verify = () => {
  setGfxTier('medium')
  const disposable: { dispose(): void }[] = []
  const scene = new THREE.Scene()
  const published = new Map<string, Chunk>()
  const publishedGeometry = new Set<THREE.BufferGeometry>()
  const allocated = new Set<THREE.BufferGeometry>()
  const freed = new Set<THREE.BufferGeometry>()
  const times: number[] = []
  let watchBirths = false
  const setAttribute = THREE.BufferGeometry.prototype.setAttribute
  THREE.BufferGeometry.prototype.setAttribute = function (name, attribute) {
    if (name === 'aBirth' && !allocated.has(this)) {
      allocated.add(this)
      this.addEventListener('dispose', () => freed.add(this))
    }
    return setAttribute.call(this, name, attribute)
  }
  const world = buildWorld({
    scene, obstacles: [],
    trackTexture: t => { disposable.push(t) },
    trackDisposable: d => { disposable.push(d) },
    onChunk: c => {
      check(world.solidsIn(c.cx, c.cz) === c.boxes, 'collision must publish with geometry')
      published.set(`${c.cx},${c.cz}`, c)
      for (const g of c.geos) {
        publishedGeometry.add(g)
        if (!watchBirths) continue
        const birth = g.getAttribute('aBirth')
        if (birth) for (let i = 0; i < birth.count; i++) {
          const at = birth.getX(i)
          check(at === PREBORN || Math.abs(at - windUniforms.uTime.value) < 0.001,
            'fade must begin at publication, preserving previously visible vertices')
        }
      }
    },
  })
  const x = originX(0) + CHUNK / 2
  const z = originZ(0) + CHUNK / 2
  const realNow = performance.now.bind(performance)
  // Deliberately exhaust the deadline after one generator step, independent
  // of CPU speed. The real clock still measures the cost of that update.
  let clock = realNow()
  const singleStep = (atX = x) => {
    performance.now = () => (clock += 100)
    const before = realNow()
    try { world.update(atX, z, 1 / 60) }
    finally { performance.now = realNow }
    times.push(realNow() - before)
  }
  try {
    world.prime(x, z)
    check(published.size === 25, 'boot must still supply the complete inner rings')
    const pending = world.pending
    singleStep()
    check(published.size === 25 && world.pending === pending, 'partial chunks remain private and pending')
    world.prime(x, z, 5000)
    check(world.pending === 0, 'covered prime must drain sliced work to completion')
    const old = published.get('2,0')!
    check(old.tier === 'flora', 'upgrade fixture starts in flora ring')
    watchBirths = true
    let steps = 0
    do {
      check(old.group.parent === world.root, 'old geometry must survive until replacement is complete')
      check(world.solidsIn(2, 0) === old.boxes, 'old collision must survive until replacement is complete')
      singleStep(x + CHUNK)
      check(++steps < 5000, 'streamer must make progress within the budget')
    } while (published.get('2,0') === old)
    const upgraded = published.get('2,0')!
    check(upgraded.tier === 'full' && old.group.parent === null, 'completed upgrade replaces old chunk atomically')
    check(upgraded.geos.some(g => [...g.getAttribute('aBirth').array].includes(PREBORN)), 'upgrade retains pre-existing surfaces')

    // Capture actual private geometry, then teleport beyond its requested ring.
    let partial: THREE.BufferGeometry[] = []
    for (let i = 0; i < 150 && !partial.length; i++) {
      singleStep(x + CHUNK)
      partial = [...allocated].filter(g => !publishedGeometry.has(g) && !freed.has(g))
    }
    check(partial.length > 0, 'cancellation fixture must own a partial mesh')
    world.prime(x + CHUNK * 30, z)
    check(partial.every(g => freed.has(g)), 'teleport must release cancelled construction geometry')
    check(world.solidsIn(2,0) === null, 'teleport retires old collision ring')

    const sorted = times.slice().sort((a,b)=>a-b)
    return {
      innerChunks: 25, upgradeSteps: steps,
      cancelledGeometries: partial.length,
      medianUpdateMs: sorted[Math.floor(sorted.length / 2)],
      p99UpdateMs: sorted[Math.floor(sorted.length * .99)],
      assertions: 'partial publication, prime completion, atomic upgrade, birth stamps, cancellation, teleport collision',
    }
  } finally {
    performance.now = realNow
    THREE.BufferGeometry.prototype.setAttribute = setAttribute
    for (const d of disposable) d.dispose()
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose() })
  }
}
Object.assign(window, { __streamingProbe: { verify } })
