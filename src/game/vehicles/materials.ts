import * as THREE from 'three'
import { canvasTexture } from '../core/textures'
import type { Slot } from './parts'

/*
  What makes a shape read as a vehicle rather than as a shape.

  Geometry gets you the silhouette and nothing else. A car is recognisable
  because of what its surfaces *do* with light: paint has a coloured base
  under a clear lacquer, so it carries two highlights of different sharpness;
  glass is dark, nearly smooth and reflects the sky harder than the paint
  does; chrome is a mirror; tyres are the one thing in the frame that reflects
  nothing at all. Give every one of those the same MeshStandardMaterial and
  the result looks like a toy however good the loft was.

  So this module hands out a small family of MeshPhysicalMaterials — the
  clearcoat term is the single biggest quality-per-byte lever available here —
  and, more importantly, an environment map for them to reflect. There is no
  environment to capture: the sky is a set of camera-parked domes and the
  ground is streamed chunks, so a real cube camera would cost a render of the
  world per update. Instead the env map is *painted*: a 128x64 equirectangular
  canvas holding the sky gradient, a horizon haze band, the ground colour and
  a hot sun blob, drawn from the same numbers sky.ts is already computing.
  It is painted once, from the first sky the fleet is handed. See the note on
  `setDay` for why repainting it was measurably pointless.

  The day cycle then drives `envMapIntensity` and a global tint on every
  material here, so a car parked at midnight is a dark shape with a cold sheen
  and the same car at noon is bright and glossy — without a single extra light
  in the scene.

  Everything is created through one `createVehicleMaterials()` per session and
  shared by all three vehicles: same lacquer, same glass, same rubber, one
  place to tune, and eleven materials total instead of eleven per vehicle.
*/

export interface VehicleMaterials {
  /** the shared slot materials; a vehicle picks the ones it uses */
  slots: Record<Slot, THREE.Material>
  /** a per-vehicle paint colour without a second material: clone the paint
      slot, keep the same env map and clearcoat, change only the base colour */
  paint: (hex: string, opts?: { metallic?: number; roughness?: number }) => THREE.MeshPhysicalMaterial
  /** re-light everything for the current sky. `day` 0..1, `night` its
      complement, plus the fog colour so reflections agree with the air */
  setDay: (day: number, night: number, fog: THREE.Color, sunEl: number) => void
  /** headlamps/tail lamps on, 0..1 — the emissive strength of the lamp slots */
  setLamps: (head: number, tail: number) => void
  dispose: () => void
}

/* -------------------------------------------------------------- env map -- */

/**
 * The painted sky, as an equirectangular strip.
 *
 * Equirect means u is azimuth and v is elevation, so the whole image is a
 * vertical gradient plus one blob for the sun — which is genuinely all a
 * reflection needs to sell a curved painted surface. The horizon sits at
 * v = 0.5; below it is ground, above it is sky, and the band right at the
 * seam is the fog colour, because that is what a car's flanks actually
 * reflect: the haze at eye level, not the zenith.
 */
const paintEnv = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sky: THREE.Color,
  horizon: THREE.Color,
  ground: THREE.Color,
  sunEl: number,
  sunPower: number,
) => {
  const css = (c: THREE.Color, a = 1) =>
    `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, css(sky))
  g.addColorStop(0.34, css(sky))
  g.addColorStop(0.47, css(horizon))
  g.addColorStop(0.53, css(horizon))
  g.addColorStop(0.72, css(ground))
  g.addColorStop(1, css(ground))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  if (sunPower > 0.01) {
    // the sun, wrapped three times so a blob straddling the seam is not cut
    // in half — the same trick the sky dome's haze blobs use
    const sy = h * (0.5 - Math.max(-0.2, sunEl) * 0.5)
    const r = w * 0.075
    ctx.globalCompositeOperation = 'lighter'
    for (const wrap of [-w, 0, w]) {
      const s = ctx.createRadialGradient(w * 0.3 + wrap, sy, 1, w * 0.3 + wrap, sy, r)
      s.addColorStop(0, `rgba(255,250,235,${0.95 * sunPower})`)
      s.addColorStop(0.35, `rgba(255,238,205,${0.35 * sunPower})`)
      s.addColorStop(1, 'rgba(255,230,190,0)')
      ctx.fillStyle = s
      ctx.fillRect(0, 0, w, h)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
}

/* -------------------------------------------------------------- textures -- */

/** tyre tread: circumferential ribs with a shoulder block pattern, painted
    once and wrapped by the revolve's uv (u around the tyre, v across it) */
const makeTreadTexture = () =>
  canvasTexture([64, 128], (ctx, w, h) => {
    ctx.fillStyle = '#16181c'
    ctx.fillRect(0, 0, w, h)
    // four circumferential grooves running the width of the canvas
    ctx.fillStyle = '#0a0b0d'
    for (const v of [0.3, 0.44, 0.56, 0.7]) ctx.fillRect(0, v * h - 2, w, 4)
    // lateral sipes, staggered either side of the centre rib
    for (let i = 0; i < 22; i++) {
      const y = (i / 22) * h
      ctx.fillRect(0, y, 3, 5)
      ctx.fillRect(w - 3, y + h / 44, 3, 5)
    }
    // a faint sheen up the sidewalls so they aren't dead flat
    const s = ctx.createLinearGradient(0, 0, 0, h)
    s.addColorStop(0, 'rgba(120,124,132,0.16)')
    s.addColorStop(0.22, 'rgba(0,0,0,0)')
    s.addColorStop(0.78, 'rgba(0,0,0,0)')
    s.addColorStop(1, 'rgba(120,124,132,0.16)')
    ctx.fillStyle = s
    ctx.fillRect(0, 0, w, h)
  })

/* ---------------------------------------------------------------- build -- */

const SKY_DAY = new THREE.Color('#8fb6dc')
const SKY_NIGHT = new THREE.Color('#0e1524')
const GROUND_DAY = new THREE.Color('#5b6350')
const GROUND_NIGHT = new THREE.Color('#0c0e11')

export function createVehicleMaterials(track: {
  texture: <T extends THREE.Texture>(t: T) => T
  add: <D extends { dispose: () => void }>(d: D) => D
}): VehicleMaterials {
  const ENV_W = 128
  const ENV_H = 64
  const envCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  let envTex: THREE.Texture | null = null
  let envCtx: CanvasRenderingContext2D | null = null
  if (envCanvas) {
    envCanvas.width = ENV_W
    envCanvas.height = ENV_H
    envCtx = envCanvas.getContext('2d')
    if (envCtx) {
      paintEnv(envCtx, ENV_W, ENV_H, SKY_DAY, new THREE.Color('#c9d8e4'), GROUND_DAY, 0.6, 1)
    }
    envTex = new THREE.CanvasTexture(envCanvas)
    envTex.mapping = THREE.EquirectangularReflectionMapping
    envTex.colorSpace = THREE.SRGBColorSpace
    track.texture(envTex)
  }

  const tread = typeof document !== 'undefined' ? track.texture(makeTreadTexture()) : null
  if (tread) {
    tread.wrapS = tread.wrapT = THREE.RepeatWrapping
    tread.repeat.set(1, 1)
  }

  const owned: THREE.Material[] = []
  const keep = <T extends THREE.Material>(m: T): T => {
    owned.push(m)
    track.add(m)
    return m
  }

  /*
    Automotive lacquer: a coloured, faintly metallic base with a perfectly
    smooth clear layer over it. The two highlights that come out of that — a
    broad soft one from the base and a tight bright one from the coat — are
    what the eye actually reads as "painted metal", and no amount of roughness
    tuning on a single-layer material reproduces it.
  */
  const makePaint = (hex: string, o: { metallic?: number; roughness?: number } = {}) =>
    keep(
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(hex),
        metalness: o.metallic ?? 0.55,
        roughness: o.roughness ?? 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.055,
        envMap: envTex,
        envMapIntensity: 1,
      }),
    )

  const paint = makePaint('#b4342c')
  const paint2 = makePaint('#e8e6e1', { metallic: 0.3, roughness: 0.36 })

  const trim = keep(
    new THREE.MeshStandardMaterial({
      color: '#2c2f34', roughness: 0.72, metalness: 0.08,
      envMap: envTex, envMapIntensity: 0.5,
    }),
  )
  const chrome = keep(
    new THREE.MeshStandardMaterial({
      color: '#e8ecef', roughness: 0.12, metalness: 1,
      envMap: envTex, envMapIntensity: 1.25,
    }),
  )
  const metal = keep(
    new THREE.MeshStandardMaterial({
      color: '#8e949c', roughness: 0.42, metalness: 0.85,
      envMap: envTex, envMapIntensity: 0.9,
    }),
  )
  /*
    Glazing without transmission. Real refraction is a second render of the
    scene per frame, which this project's budget will not carry; a dark,
    nearly-smooth, strongly reflective surface at ~40% opacity does the job,
    because a car window seen from outside in daylight is mostly reflection
    anyway. depthWrite stays on: the glass is a closed shell over an interior
    that must not show through the far side of itself.
  */
  const glass = keep(
    new THREE.MeshPhysicalMaterial({
      color: '#0f1519', roughness: 0.06, metalness: 0.25,
      transparent: true, opacity: 0.62,
      envMap: envTex, envMapIntensity: 1.6,
      clearcoat: 1, clearcoatRoughness: 0.03,
      side: THREE.DoubleSide,
    }),
  )
  const rubber = keep(
    new THREE.MeshStandardMaterial({
      color: '#1a1c20', roughness: 0.94, metalness: 0,
      map: tread ?? undefined,
    }),
  )
  const dark = keep(
    new THREE.MeshStandardMaterial({ color: '#0a0b0d', roughness: 0.86, metalness: 0.05 }),
  )
  const seat = keep(
    new THREE.MeshStandardMaterial({ color: '#3a3532', roughness: 0.88, metalness: 0 }),
  )
  // lamps are lit lenses: an emissive that the day cycle and the brake pedal
  // both drive, over a base pale enough to read as glass when they are off
  const lamp = keep(
    new THREE.MeshStandardMaterial({
      color: '#d8dee6', roughness: 0.14, metalness: 0.1,
      emissive: new THREE.Color('#fff2d4'), emissiveIntensity: 0,
      envMap: envTex, envMapIntensity: 1.1,
    }),
  )
  const lampRed = keep(
    new THREE.MeshStandardMaterial({
      color: '#5e1512', roughness: 0.18, metalness: 0.1,
      emissive: new THREE.Color('#ff2a18'), emissiveIntensity: 0.25,
      envMap: envTex, envMapIntensity: 1,
    }),
  )

  const slots: Record<Slot, THREE.Material> = {
    paint, paint2, trim, chrome, metal, glass, rubber, dark, lamp, lampRed, seat,
  }

  /* The env map is painted once, from the first sky this fleet is handed, and
     never repainted. That is not a compromise. It is what was already
     happening, minus the work.

     It used to climb a sixteen-step ladder of the day, on the stated theory
     that three re-runs its PMREM pass whenever the source texture is flagged.
     It does not, for this texture. What the shader samples is not the equirect
     canvas but the cubeUV render target WebGLCubeUVMaps builds out of it, and
     `getPMREM` only rebuilds that target when `texture.isRenderTargetTexture`
     is true (three 0.184.0). A CanvasTexture is never one, so the target is
     generated on the first draw, cached against the texture, and returned
     unchanged for the rest of the session. Every later `needsUpdate` repainted
     8192 pixels and re-uploaded them for reflections that could not see them.

     The timing was the other half of the bug. The ladder quantised `day`, the
     smoothstepped 0..1 curve out of sky.ts rather than the clock, and `day` only
     moves during twilight. So all sixteen no-op repaints fired inside the ~21
     second dusk window and none of them fired anywhere else; the old comment's
     "twice a minute" was never the shape it had.

     What actually carries the day cycle here is `envMapIntensity` and the tint
     below, which is why the frozen reflection has never been visible. The
     known limitation is that a session that boots at night keeps a night sky
     in the map through the following noon; fixing that properly means owning a
     PMREMGenerator (and therefore the renderer) in here, which is a bigger
     change than the reflection is worth. */
  let envPainted = false
  const skyC = new THREE.Color()
  const groundC = new THREE.Color()
  const tinted: THREE.Material[] = [paint, paint2, trim, chrome, metal, glass, lamp, lampRed]

  const setDay = (day: number, night: number, fog: THREE.Color, sunEl: number) => {
    if (envCtx && envTex && !envPainted) {
      envPainted = true
      skyC.lerpColors(SKY_NIGHT, SKY_DAY, day)
      groundC.lerpColors(GROUND_NIGHT, GROUND_DAY, day)
      paintEnv(envCtx, ENV_W, ENV_H, skyC, fog, groundC, sunEl, day)
      envTex.needsUpdate = true
    }
    // reflections fade with the light rather than the material changing: a
    // black car at midnight is not a different paint, it is the same paint
    // with nothing to reflect
    const k = 0.16 + 0.94 * day
    for (const m of tinted) {
      const s = m as THREE.MeshStandardMaterial
      if (s.envMapIntensity !== undefined) s.envMapIntensity = k * (s === chrome ? 1.3 : s === glass ? 1.5 : 1)
    }
    // the tail lamps carry a permanent ember so a parked car is findable in
    // the dark; the day washes it out
    lampRed.emissiveIntensity = Math.max(lampRed.emissiveIntensity, 0.12 + night * 0.35)
  }

  const setLamps = (head: number, tail: number) => {
    lamp.emissiveIntensity = head * 3.2
    lampRed.emissiveIntensity = 0.12 + tail * 2.6
  }

  return {
    slots,
    paint: makePaint,
    setDay,
    setLamps,
    dispose: () => {
      for (const m of owned) m.dispose()
      owned.length = 0
    },
  }
}
