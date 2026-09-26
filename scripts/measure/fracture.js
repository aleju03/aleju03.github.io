import { fractureStructure, unsupported, splitFrag } from '../../src/game/world/fracture.ts'
const tally = {}
let n = 0, ms = 0, worst = 0, worstId = ''
for (const [cx0, cz0] of [[-1, -6], [0, -2], [1, -5], [-2, -3]]) {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = buildChunk(cx0 + dx, cz0 + dz, 'full', MATS)
    const det = c.smash.meshes.detail?.geometry ?? null
    const gl = c.smash.meshes.glass?.geometry ?? null
    for (const s of c.structures) {
      const t0 = performance.now()
      const f = fractureStructure(s, det, gl)
      const dt = performance.now() - t0
      ms += dt; n++
      if (dt > worst) { worst = dt; worstId = s.id + ' ' + s.kind }
      if (!f) { console.log('null', s.id, s.kind); continue }
      const k = tally[s.kind] ??= { n: 0, pieces: 0, verts: 0, orig: 0, ms: 0 }
      k.n++; k.pieces += f.pieces.length; k.verts += f.detail.getAttribute('position').count; k.orig += s.det[1]; k.ms += dt
      const un = unsupported(f.pieces, () => true)
      if (un.length) console.log('  unsupported at rest:', s.id, s.kind, un.length, un.slice(0, 5).map(i => f.pieces[i].kind + '@' + f.pieces[i].min.y.toFixed(1) + '/' + f.pieces[i].max.y.toFixed(1)).join(' '))
    }
  }
}
for (const [k, v] of Object.entries(tally)) console.log(k.padEnd(10), v.n, 'pieces/b', (v.pieces / v.n).toFixed(0), 'verts', (v.verts / v.n).toFixed(0), 'orig', (v.orig / v.n).toFixed(0), 'ms', (v.ms / v.n).toFixed(1))
console.log(n, 'structures', (ms / n).toFixed(1), 'ms avg; worst', worst.toFixed(1), worstId)

globalThis.__fracDbg = []
{
  const c = buildChunk(1, -6, 'full', MATS)
  for (const s of c.structures) {
    globalThis.__fracDbg.length = 0
    const t0 = performance.now()
    fractureStructure(s, c.smash.meshes.detail.geometry, c.smash.meshes.glass?.geometry ?? null)
    const d = globalThis.__fracDbg
    console.log(s.kind, 'prep', (d[0] - t0).toFixed(1), 'cut', (d[1] - d[0]).toFixed(1), 'simp', (d[2] - d[1]).toFixed(1), 'group', (d[3] - d[2]).toFixed(1), 'geo', (d[4] - d[3]).toFixed(1), 'link', (d[5] - d[4]).toFixed(1))
  }
}

{
  const g = new THREE.BoxGeometry(10, 10, 1).toNonIndexed()
  const p = Array.from(g.getAttribute('position').array)
  const f = { p, n: Array.from(g.getAttribute('normal').array), c: p.map(() => 0.5), surf: 0, closed: true, core: [0.2, 0.2, 0.2], face: 0, glass: false }
  let frags = [f]
  for (const d of [-3, -1, 1, 3]) {
    const next = []
    for (const fr of frags) { const [a, b] = splitFrag(fr, { nx: 1, ny: 0, nz: 0, d }); if (a) next.push(a); if (b) next.push(b) }
    frags = next
    console.log('after x', d, frags.length, frags.map(fr => fr.p.length / 3).join(','))
  }
}
