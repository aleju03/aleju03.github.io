import * as THREE from 'three'
import { GLOW_ALPHA } from '../../render/pixelLook'
import { buildGripMitten } from './viewHand'

/*
  The physgun you hold: a chunky procedural gun at the bottom right of the
  view, and the same gun in the hand of your body when the camera is behind
  it.

  **Shape.** GMod's physgun is a boxy receiver, a drum of glowing coils, a
  stubby barrel and a claw of prongs round the emitter, and that silhouette is
  what reads as "physgun" at any size. This one keeps the silhouette and
  draws it in this world's terms: flat-shaded slabs and eight-sided drums (the
  pixel look outlines creases and silhouettes, so a chunky form reads and a
  smooth one does not), a slate body with a cream cover and ochre prongs
  picked from the look's anchor families, and the blue light showing through
  the gaps between the drum's bands rather than painted on. The prongs are
  hinged: they open when the beam takes hold and snap shut on release, the
  core brightens and the inner drum spins up with the load, so the gun itself
  says what the beam is doing.

  **Never through a wall.** The first-person copy is drawn in the same pass
  as everything else, in world space in front of the camera, but its depth is
  squeezed into the front of the depth range in the vertex shader
  (`gl_Position.z` remapped toward the near plane), so whatever the camera is
  pressed against, the gun is in front of it. That is an `onBeforeCompile`
  on ordinary standard materials with a uniform (`uVm`) switching it, so the
  third-person copy is the *same programs* with the uniform at zero: two
  programs for the whole gun, compiled under the boot cover by `stage()`,
  nothing linked on the first draw and no second render pass for the look to
  know about. The squeezed depth still differs from the world's behind it, so
  the look outlines the gun's silhouette like everything else.

  **The tool gun** (slot 3) is a second model in the same two copies, built
  from the *same* materials, so it costs no program the physgun did not
  already link: a boxy body with a long thin barrel and a glowing tip, and a
  screen that says which mode it is in (a canvas,
  redrawn only when the mode or its step changes, on one glowing material
  per copy, which `stage()` compiles with the rest). The screen is sized for
  the look, not for a monitor: at render scale 1 the look draws about 400
  lines, and the panel lands on roughly 58 by 36 of them, so the canvas is
  about that many texels and the words are set in a hand-drawn bitmap font
  at two texels a pixel (`GLYPHS`) rather than in a system font, whose
  antialiased strokes the look's posterize turned into a grey smear. In
  first person the panel's mount is solved once against the gun's resting
  pose so it faces the eye square and upright (`faceTheEye`), on a post above
  the back of the body; in the body's hands the back of the gun is inside
  the bean, so it is a smaller panel on the right flank, turned back toward
  the chase camera over that shoulder. The belt says which of the two
  guns is out; the springs, the bob and the draw are shared.

  **The portal gun** (slot 4, once taken from the catalogue) is a third
  model on the same programs again: a cream shell over a slate receiver, a
  glass chamber at the front lit in the colour of the last portal it opened
  (its own two glowing materials, which share the core's program), and three
  long dark claws reaching past a lens. Aperture's silhouette, this world's
  slabs and eight-sided drums, and the palette's cream and slate, not white
  plastic; the chamber's colour eases from blue to orange rather than
  snapping, and the claws twitch in on every shot.

  **The hand** is `viewHand.ts`: one smooth surface drawn the way the body is
  drawn, a mitten closed round the grip with a stub of forearm leaving the
  frame, in the body's colour and its vinyl sheen. Both guns' first-person
  copies share it; in third person the body's own mittens hold the gun.

  **Aim.** The first-person gun is aimed in the lens's own frame, at a point
  down the crosshair, and only the physgun's *hold* pulls it off that, toward
  the held thing, through a low-pass. Aiming it at whatever the view ray
  happened to hit made it shake: at a grazing angle the hit hops between the
  ground a few units off and the far field, and a quarter-unit offset from
  the lens turns that into a degree or more of barrel every few frames. The
  turn is also built from scratch each frame: it used to be slerped from
  the last frame's, which already carried the gun's own roll, so the roll
  fed back into the aim and the gun shivered even standing still.

  **Motion** is springs on a few numbers, all integrated semi-implicitly:
  sway (the gun lags the view and rolls into turns), bob (a figure eight off
  the walk's own gait), a kick when the beam takes hold or freezes something,
  the draw from below the frame when the tool comes out, and a strain shake
  while something heavy fights the beam. Nothing allocates per frame.
*/

const SLATE = '#5a6478'
const CREAM = '#d9d2bf'
const SLATE_DARK = '#2a2f3a'
const STEEL = '#9aa3b0'
const OCHRE = '#c08a2e'
const RUBBER = '#1e2128'

// the glow, linear and HDR: the look's ACES takes the hot one to a pale
// cyan and leaves the idle one a clear blue
const CORE_IDLE = new THREE.Color(0.04, 0.8, 2.4)
const CORE_HOT = new THREE.Color(0.3, 2.3, 4.4)

/** where the gun sits in the camera's frame, first person, and its size
    there: the bottom-right corner, a quarter of the frame, the claw about
    two thirds of the way across */
const FP_OFFSET = new THREE.Vector3(0.3, -0.26, -0.56)
const FP_SCALE = 0.34
/** the lens those two were laid out through. A different fov scales the
    gun's size and its sideways offset (never its depth) by the ratio of the
    half-angle tangents, so it fills the same corner of the frame at any
    fov the pause sheet allows */
const FP_REF_TAN = Math.tan(THREE.MathUtils.degToRad(74) / 2)
/** the gun in the body's hand, world units per model unit: a body is ~4.5
    tall and its forearm short, so the gun is drawn big enough to read */
const TP_SCALE = 2.2
/** the first-person physgun's own turn in the frame (pitch, yaw, roll) on
    top of its aim: rolled so its flank shows */
const FP_TURN = new THREE.Euler(0.03, 0, -0.3, 'YXZ')
/** the tool gun's: nearly level, and yawed a little so its left flank and
    barrel show past the screen (which faces the eye whatever this is) */
const TOOL_TURN = new THREE.Euler(0.04, 0.16, -0.08, 'YXZ')
/** the portal gun's: rolled a touch less than the physgun, so the chamber
    and the top claw both show */
const PORTAL_TURN = new THREE.Euler(0.1, 0.3, -0.18, 'YXZ')
/** where a first-person gun points when nothing pulls it: this far down the
    crosshair, in the lens's frame */
const CONVERGE = new THREE.Vector3(0, 0, -16)
/** how fast the first-person aim follows its goal, per second: a held thing
    dragged across the view leads the barrel by a few frames, and nothing
    that hops can shake it */
const AIM_RATE = 10

/** the body's own faint light (bodyMaterial's uGummy), on the mitten */
const HAND_GUMMY = 0.035

const VM_KEY = 'physgun-vm-depth'

/** squeeze first-person depth into the front of the range: z' = -w + (z + w) k */
const vmCompile = function (this: THREE.Material, shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uVm = this.userData.uVm
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uVm;')
    .replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n  gl_Position.z = mix(gl_Position.z, -gl_Position.w + (gl_Position.z + gl_Position.w) * 0.25, uVm);',
    )
}

const vmMaterial = <M extends THREE.Material>(m: M, fp: boolean): M => {
  m.userData.uVm = { value: fp ? 1 : 0 }
  m.onBeforeCompile = vmCompile
  m.customProgramCacheKey = () => VM_KEY
  return m
}

/** a light: writes the look's glow code into alpha (solid, and left out of
    the baked grade, which would grey its blue down to the sky's) */
const glowing = (m: THREE.MeshBasicMaterial) => {
  m.opacity = GLOW_ALPHA
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.OneFactor
  m.blendDst = THREE.ZeroFactor
  m.blendSrcAlpha = THREE.OneFactor
  m.blendDstAlpha = THREE.ZeroFactor
  return m
}

interface Mats {
  slate: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  steel: THREE.MeshStandardMaterial
  ochre: THREE.MeshStandardMaterial
  rubber: THREE.MeshStandardMaterial
  hand: THREE.MeshStandardMaterial
  core: THREE.MeshBasicMaterial
  lens: THREE.MeshBasicMaterial
  cream: THREE.MeshStandardMaterial
  /** the portal gun's chamber, in the last portal's colour */
  portal: THREE.MeshBasicMaterial
}

const makeMats = (fp: boolean): Mats => {
  const std = (c: string, rough = 0.62, metal = 0.25) =>
    vmMaterial(new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, flatShading: true }), fp)
  return {
    slate: std(SLATE),
    dark: std(SLATE_DARK, 0.7, 0.3),
    steel: std(STEEL, 0.5, 0.45),
    ochre: std(OCHRE, 0.45, 0.55),
    rubber: std(RUBBER, 0.9, 0),
    // the jelly: smooth-shaded, in the body's own colour and its own soft
    // vinyl (bodyMaterial's roughness), with the trace of light of its own
    // the body carries (its uGummy) as emissive, set with the colour
    hand: vmMaterial(
      new THREE.MeshStandardMaterial({
        color: '#4d8fe0', roughness: 0.62, metalness: 0,
        emissive: new THREE.Color('#4d8fe0').multiplyScalar(HAND_GUMMY),
      }),
      fp,
    ),
    core: vmMaterial(glowing(new THREE.MeshBasicMaterial({ color: CORE_IDLE.clone() })), fp),
    lens: vmMaterial(glowing(new THREE.MeshBasicMaterial({ color: CORE_IDLE.clone() })), fp),
    cream: std(CREAM, 0.55, 0.1),
    portal: vmMaterial(glowing(new THREE.MeshBasicMaterial({ color: PORTAL_GLOW[0].clone() })), fp),
  }
}

/** the portal gun's chamber, blue and orange, linear and HDR */
const PORTAL_GLOW = [new THREE.Color(0.1, 0.8, 3.4), new THREE.Color(3.4, 1.0, 0.06)] as const

/**
 * A surface for things this world builds around the portals (the Moon's
 * slab), on the viewmodel's program: a flat-shaded standard material with the
 * depth squeeze switched off, which links nothing the belt has not already.
 */
export const portalWorldMaterial = (color: THREE.ColorRepresentation, rough = 0.8, metal = 0.1) =>
  vmMaterial(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: true }), false)

/** geometries, shared by both copies of the gun */
interface Geos {
  list: THREE.BufferGeometry[]
  box: (w: number, h: number, d: number) => THREE.BufferGeometry
  drum: (r: number, len: number, seg?: number, r2?: number) => THREE.BufferGeometry
  /** a flat face toward +z */
  plane: (w: number, h: number) => THREE.BufferGeometry
}
const makeGeos = (): Geos => {
  const list: THREE.BufferGeometry[] = []
  const cache = new Map<string, THREE.BufferGeometry>()
  const keep = (k: string, g: () => THREE.BufferGeometry) => {
    let v = cache.get(k)
    if (!v) {
      v = g()
      cache.set(k, v)
      list.push(v)
    }
    return v
  }
  return {
    list,
    box: (w, h, d) => keep(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
    // a cylinder lying along z
    drum: (r, len, seg = 8, r2 = r) =>
      keep(`d${r},${len},${seg},${r2}`, () => new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2)),
    plane: (w, h) => keep(`p${w},${h}`, () => new THREE.PlaneGeometry(w, h)),
  }
}

interface Gun {
  root: THREE.Group
  mats: Mats
  prongs: THREE.Group[]
  spinner: THREE.Object3D
  muzzle: THREE.Object3D
}

/** the model: origin at the grip, forward is -z, a little over a unit long */
const buildGun = (g: Geos, mats: Mats, hand: THREE.BufferGeometry | null): Gun => {
  const root = new THREE.Group()
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(x, y, z)
    mesh.castShadow = false
    mesh.receiveShadow = false
    parent.add(mesh)
    return mesh
  }
  // the receiver: a slab with a steel cover and a dark belly
  add(g.box(0.2, 0.17, 0.32), mats.slate, 0, 0.1, 0.05)
  add(g.box(0.15, 0.06, 0.26), mats.steel, 0, 0.2, 0.07)
  add(g.box(0.17, 0.05, 0.5), mats.dark, 0, 0.0, -0.1)
  // rear cap and its knob
  add(g.drum(0.1, 0.09, 8), mats.dark, 0, 0.1, 0.22)
  add(g.drum(0.045, 0.06, 6), mats.ochre, 0, 0.1, 0.28)
  // the core drum, the gun's signature: a fat glowing cylinder behind four
  // dark bands, so the light shows through the gaps between them, and an
  // inner ring of fins that spins with the load
  add(g.drum(0.15, 0.32, 8), mats.core, 0, 0.13, -0.24)
  for (const z of [-0.09, -0.24, -0.39]) add(g.drum(0.18, 0.03, 8), mats.dark, 0, 0.13, z)
  const spinner = new THREE.Group()
  spinner.position.set(0, 0.13, -0.24)
  root.add(spinner)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    for (const z of [-0.1, 0, 0.1]) {
      const fin = add(g.box(0.035, 0.05, 0.05), mats.ochre, Math.cos(a) * 0.175, Math.sin(a) * 0.175, z, spinner)
      fin.rotation.z = a
    }
  }
  // side coils: the blue tubes along the flanks, clamped at each end
  for (const s of [-1, 1]) {
    add(g.drum(0.026, 0.42, 6), mats.core, s * 0.125, 0.0, -0.2)
    add(g.box(0.045, 0.05, 0.05), mats.dark, s * 0.125, 0.0, -0.01)
    add(g.box(0.045, 0.05, 0.05), mats.dark, s * 0.125, 0.0, -0.4)
  }
  // a low spine over the top, with a light strip along it
  add(g.box(0.05, 0.05, 0.36), mats.dark, 0, 0.33, -0.24)
  add(g.box(0.03, 0.03, 0.3), mats.core, 0, 0.365, -0.24)
  // barrel, emitter collar and the lens the beam comes out of
  add(g.drum(0.085, 0.2, 8, 0.1), mats.slate, 0, 0.12, -0.5)
  add(g.drum(0.12, 0.05, 8), mats.dark, 0, 0.12, -0.6)
  // a glowing ring round the emitter, and the lens the beam comes out of
  add(g.drum(0.1, 0.025, 8), mats.core, 0, 0.12, -0.635)
  add(g.drum(0.07, 0.03, 8), mats.lens, 0, 0.12, -0.65)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.12, -0.74)
  root.add(muzzle)
  // the claw: three prongs hinged at the collar
  const prongs: THREE.Group[] = []
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i / 3) * Math.PI * 2
    const hinge = new THREE.Group()
    hinge.position.set(Math.cos(a) * 0.11, 0.12 + Math.sin(a) * 0.11, -0.6)
    hinge.rotation.z = a - Math.PI / 2
    root.add(hinge)
    // local +y points out from the axis; the prong runs forward then hooks in
    add(g.box(0.045, 0.04, 0.2), mats.ochre, 0, 0, -0.1, hinge)
    const tip = add(g.box(0.04, 0.035, 0.1), mats.ochre, 0, -0.025, -0.23, hinge)
    tip.rotation.x = -0.55
    // a glowing pad on the inside of each hook: the claw lights with the core
    const pad = add(g.box(0.03, 0.022, 0.08), mats.core, 0, -0.05, -0.25, hinge)
    pad.rotation.x = -0.55
    // and a light strip down the inside of each prong
    add(g.box(0.026, 0.02, 0.16), mats.core, 0, -0.03, -0.1, hinge)
    add(g.box(0.05, 0.05, 0.05), mats.dark, 0, 0, 0, hinge)
    prongs.push(hinge)
  }
  // grip, trigger and guard
  const grip = add(g.box(0.08, 0.26, 0.11), mats.rubber, 0, -0.1, 0.06)
  grip.rotation.x = -0.28
  add(g.box(0.025, 0.06, 0.03), mats.dark, 0, -0.03, -0.05)
  add(g.box(0.03, 0.02, 0.14), mats.dark, 0, -0.07, -0.04)
  // the hand (first person only): the body is hidden there, so the mitten
  // *is* the player, closed over the grip (viewHand.ts)
  if (hand) add(hand, mats.hand, 0, 0, 0)
  return { root, mats, prongs, spinner, muzzle }
}

interface Tool {
  root: THREE.Group
  muzzle: THREE.Object3D
  /** the screen's mount: its centre is the panel's, its +z the panel's face */
  bezel: THREE.Object3D
}

/** the tool gun: origin at the grip, forward -z, the physgun's materials.
    `hand` is the first-person copy's mitten, null for the body's copy */
const buildToolgun = (g: Geos, mats: Mats, hand: THREE.BufferGeometry | null, screen: THREE.Material): Tool => {
  const root = new THREE.Group()
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }
  // the body: a slab, a cream top rail, a dark belly
  add(g.box(0.2, 0.18, 0.44), mats.slate, 0, 0.1, -0.04)
  add(g.box(0.13, 0.05, 0.36), mats.steel, 0, 0.215, -0.08)
  add(g.box(0.17, 0.05, 0.4), mats.dark, 0, -0.005, -0.08)
  // ochre side plates and the glowing coil between them
  for (const sx of [-1, 1]) add(g.box(0.03, 0.12, 0.22), mats.ochre, sx * 0.115, 0.1, -0.12)
  add(g.drum(0.07, 0.12, 8), mats.core, 0, 0.1, -0.3)
  // the barrel: a shroud, a long thin tube, a collar and the glowing tip
  add(g.box(0.12, 0.11, 0.16), mats.dark, 0, 0.1, -0.4)
  add(g.drum(0.035, 0.36, 6), mats.steel, 0, 0.1, -0.64)
  add(g.drum(0.06, 0.04, 8), mats.dark, 0, 0.1, -0.8)
  add(g.drum(0.04, 0.05, 8), mats.lens, 0, 0.1, -0.84)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.1, -0.9)
  root.add(muzzle)
  // the screen, a dark bezel and the lit face drawn by the belt. In first
  // person it stands on a post above the back of the body and is turned to
  // face the eye (faceTheEye). In the body's hands the back of the gun is
  // inside the bean, so there it is a smaller panel on the right flank,
  // upright and turned back toward the chase camera over that shoulder
  let bezel: THREE.Mesh
  if (hand) {
    add(g.box(0.07, 0.12, 0.07), mats.dark, -0.04, 0.24, 0.13)
    bezel = add(g.box(SCREEN_PANEL_W + 0.05, SCREEN_PANEL_H + 0.05, 0.035), mats.dark, SCREEN_AT.x, SCREEN_AT.y, SCREEN_AT.z)
  } else {
    bezel = add(g.box(SCREEN_PANEL_W + 0.05, SCREEN_PANEL_H + 0.05, 0.035), mats.dark, 0.15, 0.14, -0.2)
    bezel.rotation.set(-0.12, 1.1, 0, 'YXZ')
    bezel.scale.setScalar(0.62)
  }
  const face = new THREE.Mesh(g.plane(SCREEN_PANEL_W, SCREEN_PANEL_H), screen)
  face.position.set(0, 0, 0.0185)
  bezel.add(face)
  // grip, trigger, guard, and the mitten on it (first person only)
  const grip = add(g.box(0.08, 0.26, 0.11), mats.rubber, 0, -0.1, 0.06)
  grip.rotation.x = -0.28
  add(g.box(0.025, 0.06, 0.03), mats.dark, 0, -0.03, -0.05)
  add(g.box(0.03, 0.02, 0.14), mats.dark, 0, -0.07, -0.04)
  if (hand) add(hand, mats.hand, 0, 0, 0)
  root.traverse((o) => {
    o.castShadow = false
    o.receiveShadow = false
  })
  return { root, muzzle, bezel }
}

interface PortalGun {
  root: THREE.Group
  muzzle: THREE.Object3D
  claws: THREE.Group[]
}

/** the portal gun: origin at the grip, forward -z, the physgun's materials
    plus the cream shell and the chamber. `hand` as the tool gun's */
const buildPortalgun = (g: Geos, mats: Mats, hand: THREE.BufferGeometry | null): PortalGun => {
  const root = new THREE.Group()
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }
  // the back: a slate receiver under a fat cream shell tapering to a
  // rounded tail, a slate ring round the tail, and a lit strip along the top
  // that shows the last portal's colour from behind
  add(g.box(0.2, 0.16, 0.36), mats.slate, 0, 0.08, 0.04)
  add(g.drum(0.15, 0.4, 8), mats.cream, 0, 0.17, 0.0)
  add(g.drum(0.145, 0.1, 8, 0.09), mats.cream, 0, 0.17, 0.25)
  add(g.drum(0.152, 0.03, 8), mats.slate, 0, 0.17, 0.17)
  add(g.box(0.06, 0.035, 0.3), mats.dark, 0, 0.32, -0.01)
  add(g.box(0.03, 0.02, 0.26), mats.portal, 0, 0.34, -0.01)
  // a waist band, and the chamber: glass lit in the portal's colour, caged
  // by four dark ribs so the light shows through the gaps
  add(g.drum(0.165, 0.05, 8), mats.dark, 0, 0.17, -0.22)
  add(g.drum(0.11, 0.2, 8), mats.portal, 0, 0.17, -0.35)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const rib = add(g.box(0.03, 0.03, 0.22), mats.dark, Math.cos(a) * 0.12, 0.17 + Math.sin(a) * 0.12, -0.35)
    rib.rotation.z = a
  }
  // the front collar and the lens the shot leaves by
  add(g.drum(0.14, 0.05, 8), mats.cream, 0, 0.17, -0.47)
  add(g.drum(0.07, 0.03, 8), mats.portal, 0, 0.17, -0.5)
  const muzzle = new THREE.Object3D()
  muzzle.position.set(0, 0.17, -0.6)
  root.add(muzzle)
  // three long claws, hinged on the collar: the top one straight, the two
  // lower ones splayed, each with a glowing tip
  const claws: THREE.Group[] = []
  for (const a of [Math.PI / 2, Math.PI / 2 + (Math.PI * 2) / 3, Math.PI / 2 - (Math.PI * 2) / 3]) {
    const hinge = new THREE.Group()
    hinge.position.set(Math.cos(a) * 0.13, 0.17 + Math.sin(a) * 0.13, -0.47)
    hinge.rotation.z = a - Math.PI / 2
    root.add(hinge)
    add(g.box(0.04, 0.035, 0.26), mats.dark, 0, 0, -0.13, hinge)
    add(g.box(0.042, 0.012, 0.2), mats.cream, 0, 0.022, -0.12, hinge)
    const tip = add(g.box(0.035, 0.03, 0.08), mats.portal, 0, -0.018, -0.28, hinge)
    tip.rotation.x = -0.4
    claws.push(hinge)
  }
  // grip, trigger, guard, and the mitten on it (first person only)
  const grip = add(g.box(0.08, 0.26, 0.11), mats.rubber, 0, -0.1, 0.06)
  grip.rotation.x = -0.28
  add(g.box(0.025, 0.06, 0.03), mats.dark, 0, -0.03, -0.05)
  add(g.box(0.03, 0.02, 0.14), mats.dark, 0, -0.07, -0.04)
  if (hand) add(hand, mats.hand, 0, 0, 0)
  root.traverse((o) => {
    o.castShadow = false
    o.receiveShadow = false
  })
  return { root, muzzle, claws }
}

/*
  The screen's picture. The look draws about 400 lines at render scale 1 and
  the panel lands on roughly 58 by 36 of them in first person, so the canvas
  is about that many texels and a letter is a 7-pixel-tall bitmap glyph drawn
  two texels a pixel: 14 texels tall, a third of the panel. A system font at
  that size is antialiased mush that the posterize then quantizes into a
  grey smear; these are solid blocks, which survive the downscale whole.
  Minified it is mipmapped, so a lower render scale softens the letters
  rather than dropping strokes from them; magnified it stays nearest, so a
  higher one keeps them square.
*/
const SCREEN_W = 72
const SCREEN_H = 44
/** the lit face on the gun, in model units, at the canvas's aspect */
const SCREEN_PANEL_W = 0.38
const SCREEN_PANEL_H = (SCREEN_PANEL_W * SCREEN_H) / SCREEN_W
/** its centre on the gun: on a post above the back of the body */
const SCREEN_AT = new THREE.Vector3(-0.05, 0.38, 0.17)

/** a 7-row bitmap font, proportional, uppercase: each glyph's rows as
    strings, '#' lit. Anything missing draws as '?' */
const GLYPHS: Record<string, readonly string[]> = {
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  B: ['###.', '#..#', '#..#', '###.', '#..#', '#..#', '###.'],
  C: ['.###', '#...', '#...', '#...', '#...', '#...', '.###'],
  D: ['###.', '#..#', '#..#', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '#...', '###.', '#...', '#...', '####'],
  F: ['####', '#...', '#...', '###.', '#...', '#...', '#...'],
  G: ['.###', '#...', '#...', '#.##', '#..#', '#..#', '.###'],
  H: ['#..#', '#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..##', '...#', '...#', '...#', '...#', '#..#', '.##.'],
  K: ['#..#', '#..#', '#.#.', '##..', '#.#.', '#..#', '#..#'],
  L: ['#...', '#...', '#...', '#...', '#...', '#...', '####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#..#', '##.#', '##.#', '#.##', '#.##', '#..#', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '#..#', '###.', '#...', '#...', '#...'],
  Q: ['.##.', '#..#', '#..#', '#..#', '#..#', '#.#.', '.#.#'],
  R: ['###.', '#..#', '#..#', '###.', '#.#.', '#..#', '#..#'],
  S: ['.###', '#...', '#...', '.##.', '...#', '...#', '###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#..#', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  V: ['#...#', '#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['####', '...#', '..#.', '.##.', '.#..', '#...', '####'],
  '0': ['.##.', '#..#', '#.##', '##.#', '#..#', '#..#', '.##.'],
  '1': ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
  '2': ['.##.', '#..#', '...#', '..#.', '.#..', '#...', '####'],
  '3': ['###.', '...#', '...#', '.##.', '...#', '...#', '###.'],
  '4': ['#..#', '#..#', '#..#', '####', '...#', '...#', '...#'],
  '5': ['####', '#...', '###.', '...#', '...#', '#..#', '.##.'],
  '6': ['.##.', '#...', '#...', '###.', '#..#', '#..#', '.##.'],
  '7': ['####', '...#', '..#.', '..#.', '.#..', '.#..', '.#..'],
  '8': ['.##.', '#..#', '#..#', '.##.', '#..#', '#..#', '.##.'],
  '9': ['.##.', '#..#', '#..#', '.###', '...#', '...#', '.##.'],
  '-': ['...', '...', '...', '###', '...', '...', '...'],
  '/': ['..#', '..#', '.#.', '.#.', '.#.', '#..', '#..'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  '?': ['.##.', '#..#', '...#', '..#.', '.#..', '....', '.#..'],
  ' ': ['..', '..', '..', '..', '..', '..', '..'],
}
/** a glyph, falling back through the letter under an accent to '?' */
const glyph = (c: string) => GLYPHS[c] ?? GLYPHS[c.normalize('NFD')[0]] ?? GLYPHS['?']
/** a line's width in texels at `s` texels a font pixel */
const textWidth = (t: string, s: number) => {
  let w = 0
  for (const c of t) w += (glyph(c)[0].length + 1) * s
  return Math.max(0, w - s)
}

const makeScreen = () => {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  if (canvas) {
    canvas.width = SCREEN_W
    canvas.height = SCREEN_H
  }
  const tex = canvas ? new THREE.CanvasTexture(canvas) : new THREE.Texture()
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.SRGBColorSpace
  let last = ''
  /** a line at `s` texels a font pixel, centred unless given an `x` */
  const text = (ctx: CanvasRenderingContext2D, t: string, s: number, y: number, at?: number) => {
    let x = at ?? Math.round((SCREEN_W - textWidth(t, s)) / 2)
    for (const c of t) {
      const g = glyph(c)
      for (let r = 0; r < g.length; r++)
        for (let k = 0; k < g[r].length; k++) if (g[r][k] === '#') ctx.fillRect(x + k * s, y + r * s, s, s)
      x += (g[0].length + 1) * s
    }
  }
  const fits = (t: string, s: number) => textWidth(t, s) <= SCREEN_W - 4
  /** the name on one line at two texels a pixel if it fits, else broken at
      its space or hyphen onto two */
  const lines = (a: string): string[] => {
    if (fits(a, 2)) return [a]
    const cut = a.search(/[ -]/)
    if (cut < 0) return [a]
    return [a.slice(0, a[cut] === '-' ? cut + 1 : cut), a.slice(cut + 1)]
  }
  const draw = (a: string, b: string) => {
    const key = `${a}|${b}`
    if (!canvas || key === last) return
    last = key
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#0a1820'
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
    // a lit rim a texel in, so the glass reads as a display and not a hole
    ctx.fillStyle = '#1d4a5c'
    ctx.fillRect(1, 1, SCREEN_W - 2, 1)
    ctx.fillRect(1, SCREEN_H - 2, SCREEN_W - 2, 1)
    ctx.fillRect(1, 1, 1, SCREEN_H - 2)
    ctx.fillRect(SCREEN_W - 2, 1, 1, SCREEN_H - 2)
    const name = lines(a)
    // the step: big on its own line under a one-line name; under a
    // two-line name, big after its first line if it fits there, else small
    // underneath
    const beside = !!b && name.length === 2 && textWidth(`${name[0]} ${b}`, 2) <= SCREEN_W - 4
    const sb = !b || beside ? 0 : name.length === 1 && fits(b, 2) ? 2 : 1
    const gap = 3
    const h = name.length * 14 + (name.length - 1) * 2 + (sb ? gap + 7 * sb : 0)
    let y = Math.round((SCREEN_H - h) / 2)
    ctx.fillStyle = '#8ff0ff'
    for (const [i, l] of name.entries()) {
      const s = fits(l, 2) ? 2 : 1
      if (i === 0 && beside) {
        // the pair centred as one line, the step in its own colour
        const w = textWidth(`${l} ${b}`, 2)
        const x0 = Math.round((SCREEN_W - w) / 2)
        text(ctx, l, 2, y, x0)
        ctx.fillStyle = '#ffd27a'
        text(ctx, b, 2, y, x0 + w - textWidth(b, 2))
        ctx.fillStyle = '#8ff0ff'
      } else text(ctx, l, s, y)
      y += 16
    }
    if (sb) {
      ctx.fillStyle = '#ffd27a'
      text(ctx, b, sb, y - 2 + gap)
    }
    tex.needsUpdate = true
  }
  return { tex, draw }
}

export interface ViewFrame {
  camera: THREE.PerspectiveCamera
  dt: number
  /** planar speed over the run cap, 0..1 */
  gait: number
  grounded: boolean
  /** the beam has something */
  holding: boolean
  strain: number
  /** first person: draw the viewmodel; else the body's copy */
  firstPerson: boolean
  /** third person: where the body's right hand is (world), and the aim */
  hand?: THREE.Vector3 | null
  /** third person: the body's left hand, on the foregrip */
  handL?: THREE.Vector3 | null
  aim?: THREE.Vector3 | null
  /** the point the gun points at (the held thing's target, or far down the
      view): the barrel is aimed at it, so the beam leaves along the barrel */
  aimAt?: THREE.Vector3 | null
  /** drawn at all (the physgun is out, nobody is driving) */
  shown: boolean
  /** which gun is out (default the physgun) */
  tool?: ViewTool
}

export type ViewTool = 'physgun' | 'toolgun' | 'portalgun'

export interface Viewmodel {
  readonly root: THREE.Group
  /** the first-person gun */
  readonly fp: THREE.Group
  /** the body's copy */
  readonly tp: THREE.Group
  update: (f: ViewFrame) => void
  /** the beam's start and direction, off whichever copy is drawn */
  muzzle: (pos: THREE.Vector3, dir: THREE.Vector3) => void
  /** a jolt: 1 for a grab, less for a freeze or release */
  kick: (k: number) => void
  /** the hand's colour, from the body's look */
  setHandColor: (c: THREE.ColorRepresentation) => void
  /** what the tool gun's screen says: a big line and a small one */
  setScreen: (a: string, b: string) => void
  /** the portal gun fired this colour (0 blue, 1 orange): the chamber turns
      to it and the claws twitch */
  portalShot: (color: 0 | 1) => void
  stage: (camera: THREE.Camera) => void
  unstage: () => void
  dispose: () => void
}

/** the first-person gun's resting turn in the lens's frame (no sway): its
    aim at CONVERGE, then its own turn on top. `out` is returned */
const restTurn = (turn: THREE.Euler, out: THREE.Quaternion) => {
  const dir = CONVERGE.clone().sub(FP_OFFSET).normalize()
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0))
  return out.setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromEuler(turn))
}

/**
 * Turn the first-person tool gun's screen mount so that, with the gun at
 * rest, the panel faces the eye square and stands upright in the view. Solved
 * once, in the lens's frame, and stored as the mount's own turn on the gun,
 * so the screen still rides the gun's sway and bob like any other part.
 */
const faceTheEye = (bezel: THREE.Object3D) => {
  const rest = restTurn(TOOL_TURN, new THREE.Quaternion())
  // the panel's centre in the lens's frame, and the way back to the eye
  const at = bezel.position.clone().multiplyScalar(FP_SCALE).applyQuaternion(rest).add(FP_OFFSET)
  const n = at.clone().negate().normalize()
  const u = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize()
  const x = new THREE.Vector3().crossVectors(u, n)
  const face = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, u, n))
  bezel.quaternion.copy(rest.invert().multiply(face))
}

export function createViewmodel(parent: THREE.Object3D): Viewmodel {
  const root = new THREE.Group()
  root.name = 'physgun-viewmodel'
  root.userData.dynamic = true
  parent.add(root)
  const geos = makeGeos()
  // the mitten, one surface shared by both guns' first-person copies
  const mitten = buildGripMitten()
  const fpGun = buildGun(geos, makeMats(true), mitten)
  const tpGun = buildGun(geos, makeMats(false), null)
  // the tool gun, in the same materials, and its screen (one glowing
  // material per copy, since the first-person depth squeeze is per material)
  const screen = makeScreen()
  const screenMat = (fpCopy: boolean) =>
    vmMaterial(glowing(new THREE.MeshBasicMaterial({ map: screen.tex, color: 0xffffff })), fpCopy)
  const fpScreen = screenMat(true)
  const tpScreen = screenMat(false)
  const fpTool = buildToolgun(geos, fpGun.mats, mitten, fpScreen)
  const tpTool = buildToolgun(geos, tpGun.mats, null, tpScreen)
  faceTheEye(fpTool.bezel)
  screen.draw('WELD', 'A')
  const fpPortal = buildPortalgun(geos, fpGun.mats, mitten)
  const tpPortal = buildPortalgun(geos, tpGun.mats, null)
  // each copy is a holder for every gun; the belt says which is out
  const fp = new THREE.Group()
  const tp = new THREE.Group()
  fp.add(fpGun.root, fpTool.root, fpPortal.root)
  tp.add(tpGun.root, tpTool.root, tpPortal.root)
  let which: ViewTool = 'physgun'
  /** the chamber's colour, eased toward the last shot's */
  let portalHue = 0
  let portalWant = 0
  let claw = 0
  let clawV = 0
  for (const g of [fp, tp]) {
    g.traverse((o) => {
      o.frustumCulled = false
    })
    g.visible = false
    root.add(g)
  }
  tp.scale.setScalar(TP_SCALE)
  fp.scale.setScalar(FP_SCALE)

  // springs: position offset (camera space), rotation offset (pitch, yaw,
  // roll), the prong opening, the draw
  const off = new THREE.Vector3()
  const offV = new THREE.Vector3()
  const rot = new THREE.Vector3()
  const rotV = new THREE.Vector3()
  let open = 0
  let openV = 0
  let drawn = 0
  let bob = 0
  let time = 0
  let glow = 0
  let spin = 0
  let hasLast = false
  const eul = new THREE.Euler(0, 0, 0, 'YXZ')
  const eulLast = new THREE.Euler(0, 0, 0, 'YXZ')
  const want = new THREE.Vector3()
  const wantR = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const tmp = new THREE.Vector3()
  const m4 = new THREE.Matrix4()
  const aimQ = new THREE.Quaternion()
  const m4b = new THREE.Matrix4()
  const tmp2 = new THREE.Vector3()
  /** the first-person aim in the lens's frame (smoothed) and its goal */
  const aimDir = new THREE.Vector3(0, 0, -1)
  const aimGoal = new THREE.Vector3()
  const origin = new THREE.Vector3()
  let aimed = false
  const up = new THREE.Vector3(0, 1, 0)
  let usingFp = true

  const spring = (x: number, v: number, goal: number, w: number, z: number, dt: number) => {
    // implicit in the spring and the damper, so a stiff spring on a long
    // frame cannot blow up
    const nv = (v + dt * w * w * (goal - x)) / (1 + 2 * z * w * dt + w * w * dt * dt)
    return [x + nv * dt, nv] as const
  }

  const update = (f: ViewFrame) => {
    const dt = Math.max(0, Math.min(0.05, f.dt))
    time += dt
    drawn += ((f.shown ? 1 : 0) - drawn) * (1 - Math.exp(-dt * (f.shown ? 9 : 16)))
    const visible = drawn > 0.02
    usingFp = f.firstPerson
    which = f.tool ?? 'physgun'
    fpGun.root.visible = tpGun.root.visible = which === 'physgun'
    fpTool.root.visible = tpTool.root.visible = which === 'toolgun'
    fpPortal.root.visible = tpPortal.root.visible = which === 'portalgun'
    if (which === 'portalgun') {
      portalHue += (portalWant - portalHue) * (1 - Math.exp(-dt * 12))
      ;[claw, clawV] = spring(claw, clawV, 0, 30, 0.35, dt)
      for (const gun of [fpGun, tpGun]) {
        gun.mats.portal.color.copy(PORTAL_GLOW[0]).lerp(PORTAL_GLOW[1], portalHue)
          .multiplyScalar(0.92 + 0.08 * Math.sin(time * 29))
      }
      for (const pg of [fpPortal, tpPortal]) for (const c of pg.claws) c.rotation.x = -claw * 0.35
    }
    fp.visible = visible && f.firstPerson
    tp.visible = visible && !f.firstPerson

    // look rates, from the camera's own turn this frame
    const cam = f.camera
    eul.setFromQuaternion(cam.quaternion, 'YXZ')
    let yawRate = 0
    let pitchRate = 0
    if (hasLast && dt > 0) {
      let dy = eul.y - eulLast.y
      dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      yawRate = dy / dt
      pitchRate = (eul.x - eulLast.x) / dt
    }
    eulLast.copy(eul)
    hasLast = true

    // bob: a figure eight off the gait, only on the ground
    const g = f.grounded ? f.gait : 0
    bob += dt * (5 + 6 * g)
    const bx = Math.sin(bob) * 0.014 * g
    const by = -Math.abs(Math.cos(bob)) * 0.02 * g + Math.sin(time * 1.7) * 0.0035
    // sway: the gun lags the turn and rolls into it
    const sy = THREE.MathUtils.clamp(yawRate * 0.012, -0.07, 0.07)
    const sp = THREE.MathUtils.clamp(pitchRate * 0.01, -0.05, 0.05)
    want.set(bx - sy * 0.6, by - sp * 0.5 - (1 - drawn) * 0.45, 0)
    // strain shake
    const sh = f.holding ? f.strain * f.strain * 0.012 : 0
    want.x += Math.sin(time * 71) * sh
    want.y += Math.sin(time * 83 + 1) * sh
    wantR.set(sp * 1.2 + (1 - drawn) * 0.6, sy * 1.4, sy * 2.2)
    for (let i = 0; i < 3; i++) {
      const [x, v] = spring(off.getComponent(i), offV.getComponent(i), want.getComponent(i), 16, 0.75, dt)
      off.setComponent(i, x)
      offV.setComponent(i, v)
      const [rx, rv] = spring(rot.getComponent(i), rotV.getComponent(i), wantR.getComponent(i), 14, 0.7, dt)
      rot.setComponent(i, rx)
      rotV.setComponent(i, rv)
    }
    // the claw opens on a hold, with a little overshoot
    ;[open, openV] = spring(open, openV, f.holding ? 1 : 0, 22, 0.45, dt)
    for (const gun of [fpGun, tpGun]) {
      for (const pr of gun.prongs) pr.rotation.x = open * 0.42
    }
    // the core: idle, then hot with the hold, flickering with strain
    glow += ((f.holding ? 1 : 0) - glow) * (1 - Math.exp(-dt * 10))
    const flick = 0.92 + 0.08 * Math.sin(time * 37) + (f.holding ? f.strain * 0.25 * Math.sin(time * 91) : 0)
    spin += dt * (1.5 + glow * 14 + f.strain * 10)
    for (const gun of [fpGun, tpGun]) {
      gun.mats.core.color.copy(CORE_IDLE).lerp(CORE_HOT, glow).multiplyScalar(flick)
      gun.mats.lens.color.copy(CORE_IDLE).lerp(CORE_HOT, glow).multiplyScalar(flick * (1.1 + glow * 0.6))
      gun.spinner.rotation.z = spin
    }

    if (fp.visible) {
      // camera frame, then the offset, then the springs
      const k = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / FP_REF_TAN
      fp.scale.setScalar(FP_SCALE * k)
      fp.position.copy(FP_OFFSET).add(off)
      fp.position.x *= k
      fp.position.y *= k
      // the aim, in the lens's frame: down the crosshair, or toward what
      // the physgun holds, low-passed either way so a target that hops
      // cannot shake the gun. (The quaternion this frame is built from
      // scratch, never slerped from last frame's: that one carried the
      // turn below, and chasing it fed the turn back into the aim.)
      if (which === 'physgun' && f.holding && f.aimAt) {
        m4b.copy(cam.matrixWorld).invert()
        aimGoal.copy(f.aimAt).applyMatrix4(m4b).sub(fp.position)
        if (aimGoal.lengthSq() < 1e-6) aimGoal.copy(CONVERGE).sub(fp.position)
      } else aimGoal.copy(CONVERGE).sub(fp.position)
      aimGoal.normalize()
      if (!aimed) aimDir.copy(aimGoal)
      else aimDir.lerp(aimGoal, 1 - Math.exp(-dt * AIM_RATE)).normalize()
      aimed = true
      m4.lookAt(origin, aimDir, up)
      aimQ.setFromRotationMatrix(m4)
      fp.position.applyMatrix4(cam.matrixWorld)
      fp.quaternion.copy(cam.quaternion).multiply(aimQ)
      // then the gun's own turn, and the springs' sway on top
      const turn = which === 'toolgun' ? TOOL_TURN : which === 'portalgun' ? PORTAL_TURN : FP_TURN
      eul.set(turn.x + rot.x, turn.y + rot.y, turn.z + rot.z, 'YXZ')
      fp.quaternion.multiply(q.setFromEuler(eul))
    } else aimed = false
    if (tp.visible && f.hand) {
      // in the body's hands: both arms are solved onto the aim
      // (playerBody's holdTool), the grip sits between the two mittens read
      // off the posed rig every frame, and the barrel points along the same
      // aim the arms were solved onto, so the gun cannot point one way while
      // the arms point another. A matrix's lookAt points its +z from the
      // target back at the eye, so looking from the origin along the aim
      // leaves -z, the gun's forward, on it
      tp.position.copy(f.hand)
      if (f.handL) {
        // the grip between the two mittens, a little toward the right one
        tp.position.lerp(f.handL, 0.35)
      }
      if (f.aim) m4.lookAt(tmp.set(0, 0, 0), f.aim, up)
      else if (f.aimAt) m4.lookAt(tp.position, f.aimAt, up)
      else m4.lookAt(tmp.set(0, 0, 0), tmp2.set(0, 0, -1).applyQuaternion(cam.quaternion), up)
      tp.quaternion.setFromRotationMatrix(m4)
    }
  }

  const muzzle = (pos: THREE.Vector3, dir: THREE.Vector3) => {
    const holder = usingFp ? fp : tp
    const m = which === 'toolgun' ? (usingFp ? fpTool : tpTool).muzzle
      : which === 'portalgun' ? (usingFp ? fpPortal : tpPortal).muzzle
      : (usingFp ? fpGun : tpGun).muzzle
    holder.updateMatrixWorld(true)
    m.getWorldPosition(pos)
    dir.set(0, 0, -1).applyQuaternion(holder.quaternion).normalize()
  }

  const kick = (k: number) => {
    offV.z += 1.6 * k
    rotV.x += 5 * k
  }

  let staged = false
  const stage = (camera: THREE.Camera) => {
    staged = true
    camera.updateMatrixWorld()
    fp.visible = true
    tp.visible = true
    // both guns in both copies, so every program either draws is linked
    fpGun.root.visible = tpGun.root.visible = fpTool.root.visible = tpTool.root.visible = true
    fpPortal.root.visible = tpPortal.root.visible = true
    fp.position.copy(FP_OFFSET).applyMatrix4(camera.matrixWorld)
    fp.quaternion.copy(camera.quaternion)
    tp.position.set(-0.6, -0.2, -2.5).applyMatrix4(camera.matrixWorld)
    tp.quaternion.copy(camera.quaternion)
  }
  const unstage = () => {
    if (!staged) return
    staged = false
    fp.visible = false
    tp.visible = false
  }

  return {
    root,
    fp,
    tp,
    update,
    muzzle,
    kick,
    setHandColor: (c) => {
      for (const gun of [fpGun, tpGun]) {
        gun.mats.hand.color.set(c)
        // the body's own trace of light (bodyMaterial's uGummy)
        gun.mats.hand.emissive.copy(gun.mats.hand.color).multiplyScalar(HAND_GUMMY)
      }
    },
    setScreen: (a, b) => screen.draw(a, b),
    portalShot: (color) => {
      portalWant = color
      clawV += 7
      offV.z += 1.2
      rotV.x += 3.5
    },
    stage,
    unstage,
    dispose: () => {
      root.removeFromParent()
      for (const g of geos.list) g.dispose()
      mitten.dispose()
      for (const gun of [fpGun, tpGun]) for (const m of Object.values(gun.mats)) (m as THREE.Material).dispose()
      fpScreen.dispose()
      tpScreen.dispose()
      screen.tex.dispose()
    },
  }
}
