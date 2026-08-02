/*
  The graphics tier: one mutable-once record every density and budget knob
  reads at build time.

  The world was originally tuned against a single floor — a cold iGPU — and
  the owner's verdict after playing it on a discrete card was, fairly, that
  the floor was holding the ceiling down. So the floor became a *tier*: a
  real GPU gets the dense grass field, the big shadow map and the fuller
  canopies; integrated, mobile and software renderers keep the lean numbers
  everything was first tuned on, and the adaptive pixel-ratio governor in
  CrtScene remains the safety net under both.

  CrtScene reads the GPU string (UNMASKED_RENDERER, with a conservative
  fallback), runs it past classifyGpu, and calls setGfxTier BEFORE any level
  builds — these values are baked into geometry and materials at construction,
  not read per frame. Headless probes never call it and get 'medium', which
  keeps jiti numbers deterministic.

  The sniff is a guess and will be wrong on real hardware in both directions
  (an Arc or a Lunar Lake iGPU reads as integrated; a ten-year-old discrete
  card reads as a real one), so the visitor can overrule it from the pause
  sheet — `components/os/roamPrefs.ts` holds that choice and CrtScene resolves
  the two here. Because everything in this record is *baked*, an overrule
  lands on the next load rather than on the running world; the menu says so.
*/

export type GfxTier = 'high' | 'medium'

/**
  What a GPU string is worth. Integrated, mobile and software renderers get
  the lean tier everything was first tuned on; anything else is assumed to be
  a discrete card. Kept beside the two records rather than at the call site,
  because a classifier and the thing it classifies into drift apart otherwise.
*/
export const classifyGpu = (gpu: string): GfxTier =>
  /intel|iris|uhd|mali|adreno|powervr|videocore|apple gpu|swiftshader|llvmpipe/i.test(gpu)
    ? 'medium'
    : 'high'

export interface Gfx {
  /** lattice edge of the *far* grass field, at grass.ts's FAR_STEP; the pool
      is side² clumps of three blades, so this sets both its reach and its
      cost. Sparse by design — it is the field you see at a distance */
  grassSide: number
  /** ...and of the dense near field, at NEAR_STEP. This is the one that
      decides whether grass reads as turf or as scattered tufts, so it is a
      radius rather than a density: the spacing is fixed at what closes up */
  grassNearSide: number
  /** wildflower lattice edge */
  flowerSide: number
  /** the sun's live shadow map resolution */
  shadowMap: number
  /** multiplier on foliage cards per canopy lobe */
  canopyK: number
  /** birds in the sky, total across every flock (one instanced draw) */
  birds: number
  /** animals on the ground at once. Each is a skinned mesh with its own
      mixer and its own draw call, so this one is a real budget rather than
      a lattice edge — see world/fauna.ts */
  fauna: number
  /** people walking the streets of a town, likewise one articulated rig
      each (world/pedestrians.ts) */
  pedestrians: number
  /** the cloud shell's fourth FBM octave (ragged rims) and its high cirrus
      layer. Three extra noise samples over a third of the screen — free on a
      real card, not on a cold iGPU */
  richSky: boolean
}

// The two lattices are deliberately the same size on each tier, which puts
// the whole field back on exactly the triangle budget the single sparse one
// used to spend — the win here was never a bigger budget, it was noticing
// that all of it was being spent at distances where none of it could be seen.
const MEDIUM: Gfx = {
  grassSide: 144, grassNearSide: 144, flowerSide: 44, shadowMap: 1024, canopyK: 1,
  birds: 26, fauna: 8, pedestrians: 5, richSky: false,
}
const HIGH: Gfx = {
  grassSide: 224, grassNearSide: 224, flowerSide: 60, shadowMap: 2048, canopyK: 1.45,
  birds: 54, fauna: 14, pedestrians: 9, richSky: true,
}

export const gfx: Gfx = { ...MEDIUM }

export const setGfxTier = (tier: GfxTier) => {
  Object.assign(gfx, tier === 'high' ? HIGH : MEDIUM)
}
