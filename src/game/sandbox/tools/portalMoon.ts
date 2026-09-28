import * as THREE from 'three'
import { MOON_FAR, MOON_ORIGIN } from '../../levels/space'
import { noStand, type Solid } from '../../physics/collision'
import { PORTAL_HH, type Portal, type PortalColor, type Portals } from './portals'
import type { PortalView } from './portalView'

/*
  The portal gun and the Moon: a shot at the Moon hanging in the night sky
  opens that portal on the Moon itself, and the pair is a way there and back.

  **Where it opens.** Not where the ray would meet a body three hundred
  thousand units off (the sky's Moon is a disc on a dome, and the Moon level
  is a patch of ground in the same scene sixty thousand units from the
  house), but on one fixed spot: the face of a dark slab standing on the
  landing pad, fourteen units east of where a flight comes down, turned to
  face the Earth. The slab is built the first time a shot lands there, on
  the viewmodel's own program (it links nothing), with a collision box in
  the Moon level's set that the portal treats as its wall.

  **Making the far side ready.** The Moon's ground is built a slice a frame
  (outsideWorld's `moonPortal.prepare`, the same budget a flight's approach
  spends) and so is the painted Earth that hangs in its sky; until both are
  there the new portal is not `ready` and shows its closed swirl.

  **Looking through.** From the Earth the view through the pair is live: for
  that one pass the scene is dressed as the Moon (its ground where the level
  keeps it, the Earth's streamed ground put away, the Moon's harsh sun, the
  Earth hung low in its black sky, no fog and a far plane out to the Moon's)
  and undressed after, so it costs one more cropped scene pass and a handful
  of uniforms. From the Moon the view back is a **snapshot**: the Earth's
  side is photographed from the Earth portal, looking out of it, at the
  moment you step through, and the Moon portal shows that picture looked up
  by the direction through the pair. Rendering the Earth live from the Moon
  would mean re-running the Earth's sky and streaming for a second lens
  every frame; the snapshot is a picture of a place you just left, which is
  what it has to show anyway, with no parallax up close.

  **And back the other way**: on the Moon a shot at the Earth hanging in
  its sky opens on the Earth, on a fixed spot rather than where the ray
  would meet the painted globe: the left leaf of the house's garage door,
  facing the street (the caller fits it there with the gun's own fit, so it
  is flush and rides the leaf). Its view from the Moon is a snapshot taken
  at once, the Earth's streamed ground shown for the one render
  (`dressEarth`).

  **Going through** is a level change the walker never sees: `depart` takes
  the snapshot and fixes the Moon's frame for a portal arrival (the Earth low
  over the slab's shoulder, the Moon's own sun behind it), and the caller
  runs the seamless swap (LevelSystem's `cross`) and places the walker out of
  the slab in the Moon level's own coordinates, which are the portal's.
*/

/** what it needs of the outside (outsideWorld's moonPortal, and the Moon) */
export interface MoonLink {
  skyMoon: (out: THREE.Vector3) => boolean
  root: () => THREE.Object3D | null
  prepare: (x: number, z: number, ms: number) => boolean
  land: (earthDir: THREE.Vector3) => void
  dress: (cam: THREE.Vector3) => (() => void) | null
  skyEarth: (out: THREE.Vector3) => number
  dressEarth: () => (() => void) | null
  /** the Moon's ground height */
  ground: (x: number, z: number) => number
  /** the Moon level's box list */
  obstacles: Solid[]
}

export interface PortalMoonOpts {
  portals: Portals
  link: MoonLink
  /** where the ovals are drawn, so a Moon portal rides the Moon's root */
  view?: PortalView | null
  /** the slab's surface; omit headless */
  material?: THREE.Material | null
  /** for the snapshot of the Earth's side; omit headless */
  renderer?: THREE.WebGLRenderer | null
  /** the Moon's solids changed (its sandbox re-reads them) */
  onSolids?: () => void
}

export interface PortalMoon {
  /** the gun fired at nothing solid: if the ray is on the sky's Moon, open
      `color` on the Moon and say so */
  sky: (color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3) => boolean
  /** on the Moon: is the ray on the Earth hanging in the sky */
  onEarth: (dir: THREE.Vector3) => boolean
  /** photograph the Earth's side out of `from` (a portal there) for the
      Moon side's view, dressing the scene as the Earth if it is not */
  snapshotFrom: (from: Portal, scene: THREE.Scene | null, gain?: number) => void
  /** once a frame: the far side made ready a slice at a time */
  tick: () => void
  /**
   * The view through a pair spanning two levels (portalView's `cross`):
   * dress the scene as the Moon for a pass, or hand back the Earth's
   * snapshot, or null for the swirl.
   */
  view: (to: Portal, vcam: THREE.PerspectiveCamera, scene?: THREE.Scene | null) =>
    | { restore: () => void; far: number }
    | { snapshot: THREE.Texture; viewProj: THREE.Matrix4; gain: number }
    | null
  /** a walker is about to go from the Earth through `from`: photograph the
      Earth's side for the view back and fix the Moon's frame. `gain` lifts
      the picture for the grade it will be shown under (a night street is
      graded brighter where it was taken than the Moon's day grade shows it) */
  depart: (from: Portal, scene: THREE.Scene | null, gain?: number) => void
  /** the spot on the Moon */
  readonly site: { pos: THREE.Vector3; n: THREE.Vector3; up: THREE.Vector3 }
  /** the picture of the Earth's side, once taken (for a harness) */
  readonly snapshot: THREE.WebGLRenderTarget | null
  dispose: () => void
}

/** the slab, east of the landing pad, its face to the west */
const SLAB_X = MOON_ORIGIN.x + 14
const SLAB_Z = MOON_ORIGIN.z
const SLAB_W = 4.6
const SLAB_H = 7.2
const SLAB_T = 1.2
/** where the Earth hangs for a trip by portal: low in the west, over the
    slab's shoulder as you step out, so the first thing you see is home */
const EARTH_EL = 0.12
export const PORTAL_EARTH_DIR = new THREE.Vector3(-Math.cos(EARTH_EL), Math.sin(EARTH_EL), 0)
/** how far off the disc's centre a shot still counts: the disc is about
    0.03 of a radian across, and a shot at a target that small wants help */
const AIM_SLACK = Math.cos(0.075)

export function createPortalMoon(o: PortalMoonOpts): PortalMoon {
  const { portals, link } = o
  const site = { pos: new THREE.Vector3(), n: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) }
  let slab: THREE.Group | null = null
  let slabBox: Solid | null = null
  const geos: THREE.BufferGeometry[] = []

  /** the slab and its box, once; and the portal's spot on its face */
  const build = () => {
    const g = Math.min(
      link.ground(SLAB_X - SLAB_T / 2, SLAB_Z - SLAB_W / 2), link.ground(SLAB_X - SLAB_T / 2, SLAB_Z + SLAB_W / 2),
      link.ground(SLAB_X + SLAB_T / 2, SLAB_Z), link.ground(SLAB_X, SLAB_Z),
    )
    const face = SLAB_X - SLAB_T / 2
    site.pos.set(face - 0.03, g + 0.08 + PORTAL_HH, SLAB_Z)
    if (slabBox) return
    slabBox = noStand(new THREE.Box3(
      new THREE.Vector3(face, g - 1, SLAB_Z - SLAB_W / 2 - 0.2),
      new THREE.Vector3(SLAB_X + SLAB_T / 2 + 0.2, g + SLAB_H - 0.5, SLAB_Z + SLAB_W / 2 + 0.2),
    ))
    link.obstacles.push(slabBox)
    o.onSolids?.()
    const root = link.root()
    if (!root || !o.material) return
    slab = new THREE.Group()
    slab.name = 'portal-slab'
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
      geos.push(geo)
      const m = new THREE.Mesh(geo, o.material!)
      m.position.set(x, y, z)
      m.castShadow = true
      m.receiveShadow = true
      slab!.add(m)
      return m
    }
    // the slab, sunk half a unit into the regolith, and a shallow cap
    // stepped back from its face so the top reads as a made thing
    add(new THREE.BoxGeometry(SLAB_T, SLAB_H, SLAB_W), SLAB_X, g + SLAB_H / 2 - 0.5, SLAB_Z)
    add(new THREE.BoxGeometry(SLAB_T * 0.7, 0.35, SLAB_W + 0.3), SLAB_X + 0.15, g + SLAB_H - 0.35, SLAB_Z)
    root.add(slab)
    slab.updateMatrixWorld(true)
  }

  const md = new THREE.Vector3()
  const sky = (color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3) => {
    void eye
    if (!link.skyMoon(md)) return false
    if (dir.clone().normalize().dot(md) < AIM_SLACK) return false
    build()
    const p = portals.placeAt(color, 'moon', site.pos, site.n, site.up, 'moon', slabBox ? [slabBox] : [])
    p.ready = false
    link.land(PORTAL_EARTH_DIR)
    return true
  }

  // a Moon portal rides the Moon's root (flying past it, it is out there)
  const offOpen = portals.on((e) => {
    if (e.type !== 'open' || !o.view) return
    const p = portals.list[e.color]
    o.view.setParent(e.color, p?.site === 'moon' ? link.root() : null)
  })

  const prepared = new WeakSet<Portal>()
  const tick = () => {
    for (const p of portals.all) {
      if (!p || p.level !== 'moon') continue
      if (p.site === 'moon') {
        build()
        if (slabBox) p.hosts = [slabBox]
      }
      if (prepared.has(p)) continue
      // Read the partner even while this endpoint is not ready yet.
      const other = portals.all.find((q) => q && q.owner === p.owner && q.color !== p.color)
      p.ready = false
      const ax = other && other.level !== 'moon' ? other.pos.x : 0
      const az = other && other.level !== 'moon' ? other.pos.z : 0
      if (link.prepare(ax, az, 2)) { p.ready = true; prepared.add(p) }
    }
  }

  /* ---- the snapshot of the Earth's side ---- */
  const snapRT = o.renderer
    ? new THREE.WebGLRenderTarget(768, 768, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    })
    : null
  const snapCam = new THREE.PerspectiveCamera(112, 1, 0.1, 900)
  const snapVP = new THREE.Matrix4()
  const rot = new THREE.Matrix4()
  let snapped = false
  let snapGain = 1
  const at = new THREE.Vector3()

  const depart = (from: Portal, scene: THREE.Scene | null, gain = 1) => {
    link.land(PORTAL_EARTH_DIR)
    snapshotFrom(from, scene, gain)
  }
  const snapshotFrom = (from: Portal, scene: THREE.Scene | null, gain = 1, target = snapRT, projection = snapVP) => {
    snapGain = gain
    const r = o.renderer
    if (!r || !target || !scene) return
    // from just in front of the Earth portal, looking out of it
    snapCam.position.copy(from.pos).addScaledVector(from.n, 0.2)
    snapCam.up.copy(Math.abs(from.n.y) > 0.7 ? from.up : at.set(0, 1, 0))
    snapCam.lookAt(at.copy(from.pos).addScaledVector(from.n, 10))
    snapCam.updateMatrixWorld()
    snapCam.updateProjectionMatrix()
    const prev = r.getRenderTarget()
    // the ovals stay out of it: the one being walked through is drawing
    // itself as a full-screen quad this frame (portalView's near-plane
    // cover), and would be the whole picture
    const ovals = o.view?.root ?? null
    const shown = ovals?.visible ?? false
    if (ovals) ovals.visible = false
    r.setRenderTarget(target)
    r.render(scene, snapCam)
    r.setRenderTarget(prev)
    if (ovals) ovals.visible = shown
    // a direction lookup: the view's turn only, never its place
    rot.extractRotation(snapCam.matrixWorld).invert()
    projection.multiplyMatrices(snapCam.projectionMatrix, rot)
    snapped = true
  }

  // Only visible views allocate a snapshot. Four entries match the portal
  // renderer's pass budget and cannot grow with everyone who ever joined.
  const remoteSnapshots = new Map<string, { rt: THREE.WebGLRenderTarget; vp: THREE.Matrix4; frame: string }>()
  const view: PortalMoon['view'] = (to, vcam, scene) => {
    // any portal on the Moon is seen live, the scene dressed as the Moon
    if (to.level === 'moon') {
      const restore = link.dress(vcam.position)
      return restore ? { restore, far: MOON_FAR } : null
    }
    if (to.owner && snapRT && scene) {
      const key = `${to.owner}:${to.color}`
      let shot = remoteSnapshots.get(key)
      if (!shot) {
        if (remoteSnapshots.size >= 4) {
          const first = remoteSnapshots.keys().next().value!
          remoteSnapshots.get(first)!.rt.dispose(); remoteSnapshots.delete(first)
        }
        shot = { rt: snapRT.clone(), vp: new THREE.Matrix4(), frame: '' }
      }
      remoteSnapshots.delete(key); remoteSnapshots.set(key, shot)
      const frame = to.basis.elements.map(v => v.toFixed(2)).join(',')
      if (frame !== shot.frame) {
        const restore = link.dressEarth()
        snapshotFrom(to, scene, 1, shot.rt, shot.vp)
        restore?.()
        shot.frame = frame
      }
      return { snapshot: shot.rt.texture, viewProj: shot.vp, gain: 1 }
    }
    // from the Moon back to the Earth: the picture taken on the way out
    if (snapped && snapRT) return { snapshot: snapRT.texture, viewProj: snapVP, gain: snapGain }
    return null
  }

  const ed = new THREE.Vector3()
  const onEarth = (dir: THREE.Vector3) => {
    const rad = link.skyEarth(ed)
    return rad > 0 && dir.clone().normalize().dot(ed) > Math.cos(rad * 1.05)
  }

  return {
    sky,
    onEarth,
    snapshotFrom: (from, scene, gain) => {
      const undress = link.dressEarth()
      snapshotFrom(from, scene, gain)
      undress?.()
    },
    tick,
    view,
    depart,
    site,
    get snapshot() {
      return snapped ? snapRT : null
    },
    dispose: () => {
      offOpen()
      snapRT?.dispose()
      for (const shot of remoteSnapshots.values()) shot.rt.dispose()
      remoteSnapshots.clear()
      for (const g of geos) g.dispose()
      slab?.removeFromParent()
      if (slabBox) {
        const i = link.obstacles.indexOf(slabBox)
        if (i >= 0) link.obstacles.splice(i, 1)
      }
    },
  }
}
