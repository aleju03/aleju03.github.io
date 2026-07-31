/*
  A sheet of paper you can grab and rip, simulated with Verlet integration —
  positions and their previous positions, no velocities, constraints relaxed a
  few times per step. The classic tearable-cloth toy, re-cut as paper: pinned
  along its top edge like a sheet taped to the page, sagging under its own
  weight, and shedding constraints the moment you stretch one past its tear
  distance so a hard drag opens a real hole.

  Everything lives in typed arrays and the whole thing is React-free and
  renderer-free: it takes a 2D context to draw into and knows nothing else
  about the page. That keeps the hot loop free of allocation — a torn sheet is
  a few thousand constraints relaxed five times a frame, and object churn at
  that rate is what turns a toy into a stutter.

  Drawing is two calls, not two thousand: every intact cell is accumulated as a
  subpath into one Path2D and filled in a single pass, then every surviving
  link is stroked in a single pass on top. Torn cells simply never join the
  fill, which is what makes the hole read as a ragged edge instead of a gap.
*/

export interface ClothColors {
  /** the sheet's face */
  paper: string
  /** the crease grid drawn over it */
  ink: string
}

const GRAVITY = 900
const DRAG = 0.99
const ITERATIONS = 5
/**
 * How far a link stretches before the fibres give, and how wide your grip is —
 * both as MULTIPLES OF THE GRID SPACING, not pixels. Spacing changes with the
 * viewport, so absolute thresholds would make the paper tear like tissue at one
 * breakpoint and like canvas at another.
 */
const TEAR_RATIO = 1.75
const GRIP_RATIO = 2.1
const STEP = 1 / 60
/**
 * Ceiling on the sideways wind, in px/s². The sheet is stirred by scroll
 * velocity, and an unbounded gust does not billow the paper — it stretches
 * every link past its tear distance inside three substeps and disintegrates the
 * sheet before it has been on screen for a frame. Tearing must come from a
 * hand, never from the page moving.
 */
const MAX_GUST = 140

export interface Cloth {
  resize(width: number, height: number): void
  step(dtSeconds: number): void
  draw(ctx: CanvasRenderingContext2D, colors: ClothColors): void
  /** pointer went down at canvas coords */
  grab(x: number, y: number): void
  move(x: number, y: number): void
  release(): void
  /** 0..1 — how much of the sheet has been ripped open */
  tornFraction(): number
  /** shove the whole sheet sideways, so scrolling stirs it */
  gust(strength: number): void
  /**
   * Punch a hole outright. A drag is the good interaction, but a drag on a
   * touch screen is the page scrolling — so coarse pointers get a tap that
   * bursts the sheet locally instead of a grip that would fight the scroll.
   */
  punch(x: number, y: number, radius: number): void
}

export function createCloth(): Cloth {
  let cols = 0
  let rows = 0
  let spacing = 0
  let originX = 0
  let tearDist = 0
  let influence = 0

  // point state: current, previous, pinned
  let px = new Float32Array(0)
  let py = new Float32Array(0)
  let ox = new Float32Array(0)
  let oy = new Float32Array(0)
  let pinned = new Uint8Array(0)

  // constraints: index pairs plus their rest length and liveness
  let ca = new Int32Array(0)
  let cb = new Int32Array(0)
  let crest = new Float32Array(0)
  let calive = new Uint8Array(0)
  let constraintCount = 0
  let aliveCount = 0
  // point index -> the constraint joining it to its right/below neighbour, or
  // -1 at the far edges. Built once so the draw loop can ask "is this cell
  // still whole?" with four array reads and no arithmetic to get wrong.
  let hLink = new Int32Array(0)
  let vLink = new Int32Array(0)

  let holding = false
  let handX = 0
  let handY = 0
  let prevHandX = 0
  let prevHandY = 0
  let accumulator = 0
  let gustX = 0

  function resize(width: number, height: number) {
    // a coarse grid on a small screen: the sheet should feel like paper, not
    // gauze, and the constraint count is the whole cost of the simulation
    spacing = width < 700 ? 26 : 22
    cols = Math.max(4, Math.floor(width / spacing))
    rows = Math.max(3, Math.floor(height / spacing))
    const count = (cols + 1) * (rows + 1)
    // center the sheet: the grid is a whole number of cells, so it rarely
    // spans the canvas exactly and a left-aligned sheet looks like a mistake
    originX = (width - cols * spacing) / 2
    // the last row lands on `rows * spacing`, which is up to one cell short of
    // the band; stretch the row pitch so the sheet reaches the bottom edge
    const pitchY = height / rows
    tearDist = spacing * TEAR_RATIO
    influence = spacing * GRIP_RATIO

    px = new Float32Array(count)
    py = new Float32Array(count)
    ox = new Float32Array(count)
    oy = new Float32Array(count)
    pinned = new Uint8Array(count)

    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= cols; x++) {
        const i = y * (cols + 1) + x
        px[i] = ox[i] = originX + x * spacing
        py[i] = oy[i] = y * pitchY
        // Taped down the whole way round. Pinning only the top edge makes a
        // curtain: the sheet drapes, narrows, and leaves the band half empty,
        // which is not what a page taped over a section looks like. All four
        // edges held means it stays taut and flat, and a hole you tear in the
        // middle is unmistakably a hole rather than a hem.
        if (y === 0 || y === rows || x === 0 || x === cols) pinned[i] = 1
      }
    }

    const maxConstraints = count * 2
    ca = new Int32Array(maxConstraints)
    cb = new Int32Array(maxConstraints)
    crest = new Float32Array(maxConstraints)
    calive = new Uint8Array(maxConstraints)
    hLink = new Int32Array(count).fill(-1)
    vLink = new Int32Array(count).fill(-1)
    constraintCount = 0
    const link = (a: number, b: number, rest: number, table: Int32Array) => {
      ca[constraintCount] = a
      cb[constraintCount] = b
      crest[constraintCount] = rest
      calive[constraintCount] = 1
      table[a] = constraintCount
      constraintCount++
    }
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= cols; x++) {
        const i = y * (cols + 1) + x
        // rows are pitched to fill the band, so vertical links rest longer
        // than horizontal ones — one shared rest length would pre-tension the
        // sheet and leave it visibly bowed before anyone touched it
        if (x < cols) link(i, i + 1, spacing, hLink)
        if (y < rows) link(i, i + cols + 1, pitchY, vLink)
      }
    }
    aliveCount = constraintCount
  }

  /** a cell survives only while all four of its edges do — that is what makes a hole ragged */
  function cellIntact(topLeft: number, stride: number): boolean {
    const h1 = hLink[topLeft]
    const h2 = hLink[topLeft + stride]
    const v1 = vLink[topLeft]
    const v2 = vLink[topLeft + 1]
    return (
      h1 >= 0 &&
      h2 >= 0 &&
      v1 >= 0 &&
      v2 >= 0 &&
      calive[h1] === 1 &&
      calive[h2] === 1 &&
      calive[v1] === 1 &&
      calive[v2] === 1
    )
  }

  function integrate(dt: number) {
    const g = GRAVITY * dt * dt
    for (let i = 0; i < px.length; i++) {
      if (pinned[i]) continue
      const vx = (px[i] - ox[i]) * DRAG + gustX * dt
      const vy = (py[i] - oy[i]) * DRAG
      ox[i] = px[i]
      oy[i] = py[i]
      px[i] += vx
      py[i] += vy + g
    }
    gustX *= 0.86
  }

  function satisfy() {
    // Paper tears from a HAND, never from gravity.
    //
    // Verlet with a handful of relaxation passes is soft, so a sheet this size
    // sags under its own weight until the middle links stretch past their tear
    // distance all on their own — the sheet then opened itself while nobody was
    // touching it, which is the opposite of a toy. Gating the break on an active
    // grip near the link makes the hole strictly something you did. Everything
    // else still behaves: scraps you have already freed keep falling, because
    // that is integration, not tearing.
    const grip = holding ? influence * 1.6 : 0
    const grip2 = grip * grip
    for (let k = 0; k < ITERATIONS; k++) {
      for (let c = 0; c < constraintCount; c++) {
        if (!calive[c]) continue
        const a = ca[c]
        const b = cb[c]
        const dx = px[b] - px[a]
        const dy = py[b] - py[a]
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d === 0) continue
        if (d > tearDist && grip > 0) {
          const hx = (px[a] + px[b]) * 0.5 - handX
          const hy = (py[a] + py[b]) * 0.5 - handY
          if (hx * hx + hy * hy <= grip2) {
            calive[c] = 0
            aliveCount--
            continue
          }
        }
        const diff = ((crest[c] - d) / d) * 0.5
        const mx = dx * diff
        const my = dy * diff
        if (!pinned[a]) {
          px[a] -= mx
          py[a] -= my
        }
        if (!pinned[b]) {
          px[b] += mx
          py[b] += my
        }
      }
    }
  }

  function drag() {
    if (!holding) return
    const dx = handX - prevHandX
    const dy = handY - prevHandY
    const r2 = influence * influence
    for (let i = 0; i < px.length; i++) {
      if (pinned[i]) continue
      const ex = px[i] - handX
      const ey = py[i] - handY
      const d2 = ex * ex + ey * ey
      if (d2 > r2) continue
      // a soft falloff, so the grip pulls a handful of the sheet rather than
      // one point — a single dragged vertex just tears itself free instantly
      const falloff = 1 - Math.sqrt(d2) / influence
      px[i] += dx * falloff
      py[i] += dy * falloff
    }
    prevHandX = handX
    prevHandY = handY
  }

  function step(dtSeconds: number) {
    if (cols === 0) return
    // fixed timestep: a variable one makes constraint relaxation explode the
    // first time the tab is backgrounded and hands back a 2-second delta
    accumulator = Math.min(accumulator + dtSeconds, 0.1)
    while (accumulator >= STEP) {
      drag()
      integrate(STEP)
      satisfy()
      accumulator -= STEP
    }
  }

  function draw(ctx: CanvasRenderingContext2D, colors: ClothColors) {
    if (cols === 0) return
    const stride = cols + 1

    // pass one: every cell whose four corners are still linked, as one path
    const face = new Path2D()
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const tl = y * stride + x
        if (!cellIntact(tl, stride)) continue
        const tr = tl + 1
        const bl = tl + stride
        const br = bl + 1
        face.moveTo(px[tl], py[tl])
        face.lineTo(px[tr], py[tr])
        face.lineTo(px[br], py[br])
        face.lineTo(px[bl], py[bl])
        face.closePath()
      }
    }
    ctx.fillStyle = colors.paper
    ctx.fill(face)

    // pass two: the crease grid, one stroke over the lot
    const links = new Path2D()
    for (let c = 0; c < constraintCount; c++) {
      if (!calive[c]) continue
      links.moveTo(px[ca[c]], py[ca[c]])
      links.lineTo(px[cb[c]], py[cb[c]])
    }
    ctx.strokeStyle = colors.ink
    ctx.lineWidth = 1
    ctx.stroke(links)
  }

  return {
    resize,
    step,
    draw,
    grab(x, y) {
      holding = true
      handX = prevHandX = x
      handY = prevHandY = y
    },
    move(x, y) {
      handX = x
      handY = y
    },
    release() {
      holding = false
    },
    tornFraction() {
      return constraintCount === 0 ? 0 : 1 - aliveCount / constraintCount
    },
    gust(strength) {
      gustX = Math.max(-MAX_GUST, Math.min(MAX_GUST, gustX + strength))
    },
    punch(x, y, radius) {
      const r2 = radius * radius
      for (let c = 0; c < constraintCount; c++) {
        if (!calive[c]) continue
        const a = ca[c]
        const dx = px[a] - x
        const dy = py[a] - y
        if (dx * dx + dy * dy > r2) continue
        calive[c] = 0
        aliveCount--
      }
      // kick the freed scraps outward so the hole opens instead of just existing
      for (let i = 0; i < px.length; i++) {
        if (pinned[i]) continue
        const dx = px[i] - x
        const dy = py[i] - y
        const d2 = dx * dx + dy * dy
        if (d2 > r2 * 2.2 || d2 === 0) continue
        const push = (1 - Math.sqrt(d2) / (radius * 1.5)) * 6
        ox[i] -= (dx / Math.sqrt(d2)) * push
        oy[i] -= (dy / Math.sqrt(d2)) * push
      }
    },
  }
}
