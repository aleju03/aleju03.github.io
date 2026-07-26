import * as THREE from 'three'
import { makeGlowTexture } from '../core/textures'
import { seeded } from '../core/rand'

/*
  Dust, spray, wake and downwash — the half of a vehicle that isn't the model.

  A car crossing a meadow at speed with nothing coming off its wheels does not
  read as fast; it reads as sliding on ice. The same car with two low tan
  plumes trailing its rear tyres reads as *quick* at half the actual velocity.
  Particles are the cheapest speed in graphics and there is no substitute for
  them, so all four vehicles' effects come out of one pooled system here.

  One `THREE.Points`, one material, one draw call, a fixed pool that never
  allocates after construction. Slots are recycled oldest-first when the pool
  is full, which means a burst of spray can eat a dust trail — and that is
  correct behaviour: whatever is being emitted right now is what the player is
  looking at.

  Two details that matter more than they sound:

  - **Normal blending, not additive.** Dust is grey powder in daylight, not
    light. Additive was the first cut and every plume glowed like a flare
    against the grass. Foam and spray get away with being bright because they
    are painted nearly white and lifted by the sun anyway.
  - **Per-particle size and alpha.** Size comes from an `aSize` attribute
    injected into the point shader the same way sky.ts sizes its stars, and
    alpha rides in a four-component colour attribute (three's own
    USE_COLOR_ALPHA path). A plume that does not grow and fade as it drifts is
    a spray of confetti.

  The pool is seeded (`core/rand.ts`) rather than using Math.random, even
  though this is cosmetic: it costs nothing and it keeps the one rule this
  runtime has about randomness unambiguous.
*/

const POOL = 320

export interface VehicleEffects {
  root: THREE.Object3D
  /**
   * Throw one particle. Velocity is world units per second, `size` is its
   * starting diameter in world units and `grow` how much it swells over its
   * life. `drag` 0..1 is how quickly it gives up its velocity, `rise` the
   * buoyancy that makes dust hang and spray fall.
   */
  emit: (
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: THREE.Color, alpha: number,
    size: number, grow: number, life: number,
    drag: number, rise: number,
  ) => void
  update: (dt: number) => void
  /** stop everything instantly (level cut, sitting down) */
  clear: () => void
  dispose: () => void
}

export function createVehicleEffects(track: {
  texture: <T extends THREE.Texture>(t: T) => T
  add: <D extends { dispose: () => void }>(d: D) => D
}): VehicleEffects {
  const pos = new Float32Array(POOL * 3)
  const col = new Float32Array(POOL * 4)
  const siz = new Float32Array(POOL)

  const vel = new Float32Array(POOL * 3)
  const life = new Float32Array(POOL)
  const maxLife = new Float32Array(POOL)
  const size0 = new Float32Array(POOL)
  const size1 = new Float32Array(POOL)
  const alpha0 = new Float32Array(POOL)
  const drag = new Float32Array(POOL)
  const rise = new Float32Array(POOL)
  let next = 0
  const rand = seeded(0x5ee6)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4))
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1))
  // the pool lives wherever the vehicles are; culling it against a bounding
  // sphere computed once at the origin would blink the whole system out
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
  track.add(geo)

  const tex = track.texture(
    makeGlowTexture('rgba(255,255,255,0.95)', 'rgba(255,255,255,0)'),
  )
  const mat = new THREE.PointsMaterial({
    map: tex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
    size: 1,
    fog: true,
  })
  // per-particle size, the same injection sky.ts uses for its stars
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n attribute float aSize;')
      .replace('gl_PointSize = size;', 'gl_PointSize = aSize;')
  }
  mat.customProgramCacheKey = () => 'vehicle-dust'
  track.add(mat)

  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 6
  points.userData.dynamic = true
  points.matrixAutoUpdate = false

  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute
  const colAttr = geo.getAttribute('color') as THREE.BufferAttribute
  const sizAttr = geo.getAttribute('aSize') as THREE.BufferAttribute

  return {
    root: points,
    emit: (x, y, z, vx, vy, vz, color, alpha, size, grow, ttl, dr, ri) => {
      const i = next
      next = (next + 1) % POOL
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
      vel[i * 3] = vx
      vel[i * 3 + 1] = vy
      vel[i * 3 + 2] = vz
      // a little per-particle spread in life keeps a steady emitter from
      // pulsing as slots retire in the order they were filled
      maxLife[i] = ttl * (0.75 + rand() * 0.5)
      life[i] = maxLife[i]
      size0[i] = size
      size1[i] = size + grow
      alpha0[i] = alpha
      drag[i] = dr
      rise[i] = ri
      col[i * 4] = color.r
      col[i * 4 + 1] = color.g
      col[i * 4 + 2] = color.b
      col[i * 4 + 3] = alpha
      siz[i] = size
    },
    update: (dt) => {
      let live = false
      for (let i = 0; i < POOL; i++) {
        if (life[i] <= 0) {
          if (siz[i] !== 0) siz[i] = 0
          continue
        }
        live = true
        life[i] -= dt
        if (life[i] <= 0) {
          life[i] = 0
          siz[i] = 0
          col[i * 4 + 3] = 0
          continue
        }
        const k = 1 - life[i] / maxLife[i] // 0 fresh .. 1 spent
        const d = Math.exp(-drag[i] * dt)
        vel[i * 3] *= d
        vel[i * 3 + 2] *= d
        vel[i * 3 + 1] = vel[i * 3 + 1] * d + rise[i] * dt
        pos[i * 3] += vel[i * 3] * dt
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt
        siz[i] = size0[i] + (size1[i] - size0[i]) * k
        // hold the plume up for its first third, then let it go: a linear
        // fade from the instant of birth reads as steam, not as dust kicked up
        col[i * 4 + 3] = alpha0[i] * (k < 0.3 ? 1 : 1 - (k - 0.3) / 0.7)
      }
      if (!live) {
        points.visible = false
        return
      }
      points.visible = true
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
      sizAttr.needsUpdate = true
    },
    clear: () => {
      life.fill(0)
      siz.fill(0)
      col.fill(0)
      posAttr.needsUpdate = true
      colAttr.needsUpdate = true
      sizAttr.needsUpdate = true
      points.visible = false
    },
    dispose: () => {
      geo.dispose()
      mat.dispose()
    },
  }
}
