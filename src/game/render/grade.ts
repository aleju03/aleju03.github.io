/*
  The world's colour identity, as a function and as the lookup table that
  bakes it.

  Every frame of the 3D game ends in `pixelLook.ts`'s post pass, and the one
  step of that pass that decides what the world *feels* like, rather than how
  chunky it is, is the grade: which hues it is allowed to have, how much of
  them, how deep its shadows go and what colour they are. Doing that with
  per-pixel maths in the shader would mean paying for a hue-pull, a chroma
  curve and two split tones on every pixel, and worse, it would mean the look
  lived in GLSL where nobody but the shader can reason about it. So it lives
  here instead, as plain arithmetic over OKLab (the perceptual space where a
  hue rotation does not change how bright something looks), and it is baked
  once at startup into a 32-cube 3D texture the shader samples trilinearly.
  The pass carries two of them, day and night, and crossfades on a uniform,
  so the day cycle moves the mood without a single program changing.

  What the grade does, in order, and why each step is here:

  - **Gathers hues toward a handful of anchors.** A procedural world picks its
    colours from a dozen tables written at different times, and together they
    read as a paint catalogue. Pulling every hue part of the way toward the
    nearest of six anchors (brick, ochre, moss, teal, slate, plum) is what a
    pixel artist's palette does by construction: the world ends up using six
    families of colour instead of sixty, and they agree with each other.
  - **Caps chroma softly.** Grass and leaves were authored nearly neon under
    ACES, and at a low resolution a saturated field is the loudest thing on
    screen. A tanh knee keeps the order of saturations and loses the top.
  - **Desaturates the shadows** harder than the lights, which is how the eye
    works and most of what makes a picture read as moody rather than dull.
  - **Split-tones**: cool slate into the shadows, warm cream into the
    highlights. The single strongest move for "atmosphere" per unit of effort.
  - **Lifts the floor and lowers the ceiling.** Nothing is pure black (a
    shadow is a deep blue-grey you can still read a shape in) and nothing is
    pure white (a lit wall is cream). That compressed range is also what
    keeps the posterize step's bands evenly spaced where the eye can see them.

  It runs in Node as well as in the browser: `bakeGrade` is pure arithmetic
  into a Uint8Array, and only `gradeTexture` touches three. Tune a preset
  here, never by adding colour maths to the shader.
*/

import * as THREE from 'three'

export interface Grade {
  /** OKLab lightness black is lifted to, and white is pulled down to */
  floor: number
  ceiling: number
  /** S-curve strength around mid-grey: 0 none, 1 strong */
  contrast: number
  /** a power on lightness before the curve; under 1 opens the shadows */
  gamma: number
  /** overall chroma multiplier, and an extra one reached in the darks */
  sat: number
  shadowSat: number
  /** soft ceiling on OKLab chroma (a sRGB primary is ~0.26-0.32) */
  chromaCap: number
  /** OKLab hue in degrees and chroma added, weighted to the darks / lights */
  shadowTint: [number, number]
  highlightTint: [number, number]
  /** hues (OKLab degrees) the palette gathers toward, and how hard */
  anchors: number[]
  pull: number
}

/**
  Daylight: murky but warm, and still friendly. Chroma is capped low and the
  greens gather toward olive, so a meadow reads as a painted field rather
  than as a lawn under studio light, while the warm split tone keeps it an
  afternoon rather than an overcast morgue. The anchors are the families the
  world is actually built from (brick and roof tile, sand and straw, olive
  and leaf, sea and shade, sky and slate, dusk), so the pull tidies rather
  than recolours.
*/
export const GRADE_DAY: Grade = {
  floor: 0.055,
  ceiling: 0.95,
  contrast: 0.4,
  gamma: 1.04,
  sat: 0.82,
  shadowSat: 0.72,
  chromaCap: 0.115,
  shadowTint: [60, 0.012],
  highlightTint: [80, 0.01],
  anchors: [34, 74, 118, 168, 240, 314],
  pull: 0.35,
}

/**
  Night: the Purkinje shift, and real darks. Under starlight the eye loses
  colour before it loses shape and what is left leans blue, so the night
  table drains chroma and pushes the darks toward slate; and it crushes the
  middle (gamma well over 1, a floor near black), so the moonlit ground is a
  deep dark and the things that are *lit* (lamp pools, windows, a headlamp)
  are the islands the eye goes to.
*/
export const GRADE_NIGHT: Grade = {
  floor: 0.05,
  ceiling: 0.95,
  contrast: 0.26,
  gamma: 1.06,
  sat: 0.66,
  shadowSat: 0.45,
  chromaCap: 0.12,
  shadowTint: [255, 0.03],
  highlightTint: [68, 0.03],
  anchors: [34, 74, 118, 168, 240, 314],
  pull: 0.4,
}

/* --------------------------------------------------------------- oklab -- */

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055

/** linear sRGB to OKLab, into `out` (L, a, b) */
export const toOklab = (r: number, g: number, b: number, out: number[]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return out
}

/** OKLab to linear sRGB, into `out` (unclamped) */
export const fromOklab = (L: number, a: number, b: number, out: number[]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return out
}

const DEG = Math.PI / 180
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** signed shortest angle from `h` to `to`, degrees */
const angTo = (h: number, to: number) => ((to - h + 540) % 360) - 180

/**
 * Grade one display-referred sRGB colour (0..1 per channel) into `out`.
 * The whole identity of the world is this function; `bakeGrade` merely
 * tabulates it.
 */
export const gradeColor = (
  g: Grade, r: number, gr: number, b: number, out: number[],
): number[] => {
  const lab = toOklab(srgbToLinear(r), srgbToLinear(gr), srgbToLinear(b), out)
  let L = lab[0]
  let C = Math.hypot(lab[1], lab[2])
  let h = Math.atan2(lab[2], lab[1]) / DEG

  // tone: gamma, then an S-curve around the middle, then the compressed range
  L = Math.pow(clamp01(L), g.gamma)
  const s = L * L * (3 - 2 * L)
  L = L + (s - L) * g.contrast
  L = g.floor + (g.ceiling - g.floor) * L

  // the palette: gather each hue part of the way toward its nearest anchor.
  // Greys have no hue worth moving, so the pull fades in with chroma
  if (C > 1e-4 && g.anchors.length) {
    let best = 360
    for (const a of g.anchors) {
      const d = angTo(h, a)
      if (Math.abs(d) < Math.abs(best)) best = d
    }
    h += best * g.pull * smooth(0.005, 0.04, C)
  }

  // chroma: overall, less in the darks, then a soft knee at the cap
  const dark = 1 - smooth(0.25, 0.7, L)
  C *= g.sat * (1 - (1 - g.shadowSat) * dark)
  C = g.chromaCap * Math.tanh(C / g.chromaCap)

  let A = C * Math.cos(h * DEG)
  let B = C * Math.sin(h * DEG)
  // split tone, weighted to where it belongs
  const lo = (1 - L) * (1 - L)
  const hi = L * L
  A += Math.cos(g.shadowTint[0] * DEG) * g.shadowTint[1] * lo
  B += Math.sin(g.shadowTint[0] * DEG) * g.shadowTint[1] * lo
  A += Math.cos(g.highlightTint[0] * DEG) * g.highlightTint[1] * hi
  B += Math.sin(g.highlightTint[0] * DEG) * g.highlightTint[1] * hi

  fromOklab(L, A, B, out)
  out[0] = linearToSrgb(clamp01(out[0]))
  out[1] = linearToSrgb(clamp01(out[1]))
  out[2] = linearToSrgb(clamp01(out[2]))
  return out
}

/** edge length of the baked cube. 32 is 128 kB and indistinguishable from
    the function at the posterize step's resolution */
export const LUT_SIZE = 32

/** tabulate a grade into RGBA8, red fastest, as a 3D texture wants it */
export const bakeGrade = (g: Grade, size = LUT_SIZE): Uint8Array => {
  const data = new Uint8Array(size * size * size * 4)
  const c = [0, 0, 0]
  let i = 0
  for (let bz = 0; bz < size; bz++)
    for (let gy = 0; gy < size; gy++)
      for (let rx = 0; rx < size; rx++) {
        gradeColor(g, rx / (size - 1), gy / (size - 1), bz / (size - 1), c)
        data[i++] = Math.round(c[0] * 255)
        data[i++] = Math.round(c[1] * 255)
        data[i++] = Math.round(c[2] * 255)
        data[i++] = 255
      }
  return data
}

/** the baked grade as a texture the post pass can sample */
export const gradeTexture = (g: Grade, size = LUT_SIZE) => {
  const tex = new THREE.Data3DTexture(bakeGrade(g, size), size, size, size)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}
