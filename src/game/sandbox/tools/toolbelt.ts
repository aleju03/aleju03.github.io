import * as THREE from 'three'
import type { Sandbox } from '../sandbox'
import { createBeam, type Beam } from './beam'
import { createPhysgun, RANGE, type Physgun } from './physgun'
import { createPhysgunSfx, type PhysgunSfx } from './sfx'
import { emptyInput, type RigEntry, type ToolInput, type VehicleGrab } from './types'
import { createViewmodel, type Viewmodel } from './viewmodel'
import { createToolgun, toolgunScreen, toolgunSwatch, type Toolgun } from './toolgun'
import { createCameraTool, type CameraTool } from './camera'
import { shutter } from '../creative/sfx'
import { contraptionOf, type Contraption } from '../contraption/contraption'
import { createPortals, type Portal, type PortalColor, type Portals, type PortalWorld } from './portals'
import { createPortalSfx } from './portalSfx'
import { createPortalView, type PortalView } from './portalView'
import { createWeapons, WEAPON_IDS, type WeaponId, type Weapons, type WeaponWorld } from './weapons'
import { createWeaponView, type RemoteHands, type WeaponView } from './weaponView'
import { createWeaponSfx } from './weaponSfx'
import type { WorldServerMessage } from '../../net/protocol'
import { COLUMNS, SLOTS, columnOf, type ToolId } from './slots'

/*
  The tool belt: which thing is in your hand, and the one object CrtScene
  talks to about any of them.

  Slots are GMod's, and so are the columns they are kept in. Slot 0 is your
  hands (nothing drawn, E uses doors and seats the way it always has), 1 is
  the physgun, 2 the tool gun (toolgun.ts: weld, axis, rope, no-collide,
  keys, remove) and 3 the portal gun (portals.ts), which is not carried until
  it is taken from the catalogue (`give`): left click opens the blue portal,
  right click the orange, R closes both. 4, 5 and 6 are the weapons
  (weapons.ts): the pistol, the crossbow and the rocket launcher, carried
  from the start; left click fires, R reloads the pistol. The number keys
  pick a *column* (`COLUMNS`, `column()`): 1 is the hands, 2 the tools, 3
  the weapons, and pressing the same one again steps down it, wrapping. The
  wheel steps through every slot in order, across the columns, while nothing
  is held, and belongs to the physgun's distance while something is. A slot
  with nothing in it, or a tool not yet given, is skipped by both.

  The physgun's beam goes through them too: an aim whose ray meets an open
  oval before anything solid is handed to the physgun carried out of the
  partner (its eye mapped through the pair, the ray starting at the exit),
  so what is seen through a portal can be taken, held and thrown through
  it, your own body included (you can only see yourself through one). A
  hold taken through keeps that pair's map while it lasts, and lets go if
  either portal closes. The beam is drawn in two: a straight run into the
  entry, and the ordinary curve out of the exit.

  The portals themselves outlive the gun being out: they stay open with any
  tool in hand, and the belt carries props through them after every fixed
  slice of the live sandbox. What a shot lands on is asked of the live level
  (`portalWorld`), and a shot that finds nothing is offered to
  `portalElsewhere` before it fizzles (the Moon in the night sky).

  The belt is also where the contraption controller (contraption/) gets its
  keys: every `update` hands the live sandbox's contraption this frame's key
  set and the seat the holder is in, whatever tool is out and whether or not
  any is usable, because a machine is driven from a seat where no tool is.
  The physgun reads the contraption too: what it lifts weighs the whole
  welded machine, and its reload thaws everything joined to what it hits.

  A frame is two calls, and the split is the same one the sandbox makes:
  `update(input)` before the sandbox ticks (it decides what the beam is
  pulling toward, so the slices that follow can pull), and `present(frame)`
  after the camera is final for the frame (third person has moved the lens
  by then), which places the gun, draws the beam from its muzzle to where
  the held thing is *drawn*, lights the halo and keeps the hum going.

  Headless, with no `parent`, it builds no meshes and no sound, and
  `present` only syncs the physgun's plain-data record: that is the belt the
  measure harness and a future authoritative server would run.

  Everything the beam's look needs to compile (the viewmodel's two programs,
  the ribbon, the sprites, the halo shell, the portals' ovals) is built here
  at construction and
  shown to a camera by `stage()` so it can be compiled and first-drawn under
  the boot cover; `unstage()` puts it all back.
*/

export { COLUMNS, SLOTS, columnOf, type ToolId }
/** carried from the start; the rest are given */
const STARTER: readonly ToolId[] = ['hands', 'physgun', 'toolgun', 'camera', 'pistol', 'crossbow', 'rocket']
const isWeapon = (t: ToolId | null | undefined): t is WeaponId => !!t && (WEAPON_IDS as readonly string[]).includes(t)

export interface ToolbeltOpts {
  sb: Sandbox
  /** where the gun and beam are drawn; omit headless */
  parent?: THREE.Object3D | null
  /** the bodies the beam can pick up by a limb */
  rigs?: () => Iterable<RigEntry>
  /** props welded to a prop (reload thaws them together) */
  linked?: (id: number) => Iterable<number>
  /** the fleet's parked machines, for the physgun */
  vehicles?: VehicleGrab
  /** starting slot (0 hands) */
  slot?: number
  /** synthesize the physgun's sound (default: when drawn) */
  sound?: boolean
  /** the renderer the portals' views are drawn with; omit and the ovals
      are not built (headless) */
  renderer?: THREE.WebGLRenderer | null
  /** the live level as the portal gun sees it (null: no portals here) */
  portalWorld?: () => PortalWorld | null
  /** your own body, for the physgun through a portal */
  self?: () => RigEntry | null
  /** a portal shot that hit nothing: open it somewhere else, or say no */
  portalElsewhere?: (color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3) => boolean
  /** what the weapons can hit beyond the sandbox and the fleet, and their
      way onto the wire (weapons.ts's WeaponWorld) */
  weapons?: Omit<WeaponWorld, 'sb' | 'vehicles'>
  /** where another player's hands are, for the gun they are holding */
  remoteHands?: RemoteHands
}

export interface ToolFrame {
  camera: THREE.PerspectiveCamera
  dt: number
  /** walk gait 0..1 and whether the feet are down, for the bob */
  gait: number
  grounded: boolean
  /** first person: the viewmodel; else the gun in the body's hand */
  firstPerson: boolean
  /** third person: the body's right hand, world */
  hand?: THREE.Vector3 | null
  /** third person: the body's left hand, on the foregrip */
  handL?: THREE.Vector3 | null
  /** the tool is usable at all this frame: on foot, in the sandbox's level,
      not sitting, not a heap on the floor */
  active: boolean
  /** the look's internal lines, for the beam's minimum width */
  lines: number
}

export interface Toolbelt {
  readonly slot: number
  readonly tool: ToolId
  select: (slot: number) => void
  cycle: (dir: number) => void
  /** a number key: the column's first carried slot, or, when the hand is
      already in that column, the next one down it (wrapping) */
  column: (c: number) => void
  readonly physgun: Physgun
  readonly toolgun: Toolgun
  /** the camera (camera.ts): its zoom and its requests for a photograph */
  readonly camera: CameraTool
  /** the blue and the orange portal, and everything that goes through them */
  readonly portals: Portals
  /** hand over a tool the belt does not carry yet (the catalogue's portal
      gun); returns false when it was carried already */
  give: (tool: ToolId) => boolean
  /** is this tool carried */
  has: (tool: ToolId) => boolean
  /** the live sandbox's contraptions (the parts, the joints, the drive) */
  readonly contraption: Contraption
  /** the language the tool gun's screen is written in */
  lang: 'en' | 'es'
  /** before the sandbox ticks. `active` false holsters whatever is held */
  update: (input: ToolInput, active: boolean) => void
  /** after the camera is final */
  present: (f: ToolFrame) => void
  /** put everything away at once, for a frame loop that stops presenting
      (climbing into a vehicle): drop what is held, hide the gun and beam,
      silence the hum. The next `present` brings them back */
  holster: () => void
  /** mouse-look belongs to the tool (E is turning a held prop) */
  readonly capturesLook: boolean
  /** E belongs to the tool (something is held), not to doors and seats */
  readonly capturesUse: boolean
  /** the sandbox the belt works in: the live level's own. Drops whatever
      the physgun held in the old one */
  setSandbox: (sb: Sandbox) => void
  /** hand colour for the first-person mitten, off the body's look */
  setHandColor: (c: THREE.ColorRepresentation) => void
  /** the parts, for the covered compile */
  stage: (camera: THREE.Camera) => void
  unstage: () => void
  readonly beam: Beam | null
  readonly viewmodel: Viewmodel | null
  /** the ovals and the views through them, when drawn */
  readonly portalView: PortalView | null
  /** the pistol, the crossbow and the rocket launcher */
  readonly weapons: Weapons
  readonly weaponView: WeaponView | null
  /** fly the shots and place other people's guns: `present` does it, and a
      frame loop that is not presenting (at the wheel) calls this instead */
  tickWeapons: (dt: number) => void
  /** the shared walk's messages the weapons answer to */
  receive: (m: WorldServerMessage) => void
  dispose: () => void
}

const NO_KEYS: ReadonlySet<string> = new Set()

export function createToolbelt(o: ToolbeltOpts): Toolbelt {
  // the live level's sandbox, re-pointed on a level cut (setSandbox)
  let sb = o.sb
  let con = contraptionOf(sb)
  const physgun = createPhysgun({
    sb,
    rigs: o.rigs,
    // everything joined to what the reload hits thaws with it, and a hold
    // weighs the machine it has hold of
    linked: o.linked ?? ((id) => con.linked(id)),
    massOf: (id) => con.massOf(id),
    vehicles: o.vehicles,
    self: o.self,
  })
  const toolgun = createToolgun(sb)
  const camera = createCameraTool()
  camera.onShot(() => {
    if (o.sound ?? !!o.parent) shutter(aimEye.x, aimEye.y, aimEye.z)
  })
  const portals = createPortals()
  const owned = new Set<ToolId>(STARTER)
  const portalSfx = (o.sound ?? !!o.parent) ? createPortalSfx() : null
  const portalView = o.parent && o.renderer ? createPortalView(portals, o.parent, o.renderer) : null
  let portalFireWas = false
  let portalAltWas = false
  let portalCloseWas = false
  let lang: 'en' | 'es' = 'en'
  /** the tool gun's tracer: the beam flicked to where a click landed */
  let tracer = 0
  const tracerEnd = new THREE.Vector3()
  const beam = o.parent ? createBeam(o.parent) : null
  const vm = o.parent ? createViewmodel(o.parent) : null
  const sfx: PhysgunSfx | null = (o.sound ?? !!o.parent) ? createPhysgunSfx() : null
  const weapons = createWeapons({
    sb: () => sb, vehicles: o.vehicles, ...o.weapons,
    // rockets and bolts go through a pair that stays in this level
    portal: (eye, dir, reach) => {
      const w = o.portalWorld?.()
      if (!w) return null
      const e = portals.rayEnters(w.level, eye, dir, reach)
      return e && e.to.level === w.level ? e : null
    },
  })
  const weaponView = o.parent && vm ? createWeaponView(o.parent, weapons, vm) : null
  const weaponSfx = (o.sound ?? !!o.parent) ? createWeaponSfx() : null
  const offWeapons = weapons.on((e) => {
    if (e.type === 'fire' && e.mine) vm?.weaponShot(e.w)
    weaponSfx?.play(e, aimEye)
  })
  /** where the drawn shot leaves: the muzzle as of the last present */
  const shotFrom = new THREE.Vector3()
  let shotFromSet = false
  const tickWeapons = (dt: number) => {
    weapons.step(dt)
    weaponView?.update(dt, o.remoteHands ?? null)
  }
  let slot = Math.max(0, Math.min(SLOTS.length - 1, o.slot ?? 0))
  if (!SLOTS[slot]) slot = 0
  let lastActive = true

  const muzzle = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const flashAt = new THREE.Vector3()
  /** the holder's view direction as of the last update: the body's gun
      points along it in third person, not along the chase camera */
  const aimDir = new THREE.Vector3(0, 0, -1)
  const aimEye = new THREE.Vector3()
  /** what the gun points at: the held thing's target, the surface a miss
      found, or a point well down the view */
  const aimAt = new THREE.Vector3()

  const offEvents = physgun.on((e) => {
    switch (e.type) {
      case 'grab':
        sfx?.grab()
        vm?.kick(1)
        beam?.kick(1)
        break
      case 'release':
        sfx?.release(e.speed)
        vm?.kick(0.35)
        break
      case 'freeze': {
        sfx?.freeze()
        vm?.kick(0.7)
        flashAt.set(e.x, e.y, e.z)
        const p = e.prop >= 0 ? sb.get(e.prop) : undefined
        beam?.flash(p?.mesh ?? null, flashAt)
        break
      }
      case 'unfreeze': {
        sfx?.unfreeze()
        flashAt.set(e.x, e.y, e.z)
        const p = e.prop >= 0 ? sb.get(e.prop) : undefined
        if (p?.mesh) beam?.flash(p.mesh, flashAt)
        break
      }
      case 'miss':
        sfx?.miss()
        break
      case 'deny':
        sfx?.deny()
        break
    }
  })

  const offTool = toolgun.on((e) => {
    tracer = 0.09
    tracerEnd.copy(e.point)
    const p = e.prop >= 0 ? sb.get(e.prop) : undefined
    switch (e.type) {
      case 'select':
        sfx?.grab()
        vm?.kick(0.5)
        beam?.flash(p?.mesh ?? null, e.point, 0.6)
        break
      case 'join':
      case 'set':
        sfx?.freeze()
        vm?.kick(0.8)
        beam?.flash(p?.mesh ?? null, e.point)
        sb.fx.zap(e.point, e.normal)
        break
      case 'remove':
        sfx?.release(12)
        vm?.kick(0.8)
        sb.fx.zap(e.point, e.normal)
        sb.fx.dust(e.point, 1)
        break
      case 'cancel':
        sfx?.unfreeze()
        vm?.kick(0.3)
        break
      case 'mode':
        tracer = 0
        sfx?.unfreeze()
        vm?.kick(0.25)
        break
      case 'fail':
        sfx?.miss()
        vm?.kick(0.3)
        break
      case 'deny':
        sfx?.deny()
        vm?.kick(0.3)
        break
    }
  })

  const offPortals = portals.on((e) => {
    switch (e.type) {
      case 'open':
        portalSfx?.open(e.color)
        sb.fx.zap(e.point, portals.list[e.color]?.n ?? e.point)
        break
      case 'fizzle':
        portalSfx?.fizzle()
        sb.fx.dust(e.point, 0.6)
        break
      case 'close':
        portalSfx?.close()
        break
      case 'pass':
        if (e.prop >= 0) portalSfx?.pass()
        break
    }
  })
  /** props through the portals, after every slice of the live sandbox */
  const carry = () => {
    const w = o.portalWorld?.()
    if (w) portals.carryProps(sb, w.level, physgun.prop?.id ?? null)
  }
  let offCarry = sb.onAfterSlice(carry)

  const firePortal = (color: PortalColor, input: ToolInput) => {
    vm?.portalShot(color)
    portalSfx?.shot(color)
    const w = o.portalWorld?.()
    if (!w) return
    // a body in the sky under the crosshair (the Moon by night, the Earth
    // from the Moon) takes the shot first, if nothing solid is near
    // in front of it: the ground a long way behind a disc is not the target
    if (!sb.raycast(input.aim.eye, input.aim.dir, 60, { props: true, world: true }) &&
      o.portalElsewhere?.(color, input.aim.eye, input.aim.dir)) return
    const shot = portals.fire(color, input.aim.eye, input.aim.dir, w)
    // nothing solid down the ray: the sky may have somewhere to put it
    if (!shot.ok && shot.reason === 'miss' && !o.portalElsewhere?.(color, input.aim.eye, input.aim.dir)) {
      portalSfx?.fizzle()
    }
  }

  /* ---- the physgun through the portals ---- */
  const vAim = { eye: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), yaw: 0, near: 0, through: true }
  const vInput: ToolInput = { ...emptyInput(vAim), aim: vAim }
  const holdM = new THREE.Matrix4()
  let holdVia = -1
  let holdPair: { from: Portal; to: Portal } | null = null
  let viaNow = false
  const entryAt = new THREE.Vector3()
  const exitAt = new THREE.Vector3()
  const exitDir = new THREE.Vector3()
  const outDir = new THREE.Vector3()
  /** the aim the physgun gets this frame: the real one, or carried through */
  const beamAim = (input: ToolInput): ToolInput => {
    viaNow = false
    const w = o.portalWorld?.()
    // a hold taken through a pair lets go if the pair changes
    if (physgun.holding && holdVia >= 0 && holdVia !== portals.version) {
      if (!holdPair || portals.partner(holdPair.from) !== holdPair.to) {
        physgun.release(false)
        holdVia = -1
      } else holdVia = portals.version
    }
    if (!physgun.holding) { holdVia = -1; holdPair = null }
    let M: THREE.Matrix4 | null = null
    let near = 0
    if (w) {
      const e = portals.rayEnters(w.level, input.aim.eye, input.aim.dir, RANGE)
      if (e) {
        /* Anything solid before the oval stops the beam there, except the
           collision box the portal lies on: a wall's box stands a shoulder
           pad proud of the drawn wall, in front of the oval (Portal.inset),
           and read as a wall it kept every wall portal from ever carrying
           the beam. The same pad stands in front of the exit, so the ray
           carried out starts past it rather than inside it */
        const inDepth = (e.from.inset + 0.06) / Math.max(0.2, -input.aim.dir.dot(e.from.n))
        const blk = sb.raycast(input.aim.eye, input.aim.dir, e.t, { props: true, world: true })
        const own = blk?.prop && e.from.anchor?.kind === 'prop' && e.from.anchor.id === blk.prop.id
        if (!(blk && !own && blk.distance < e.t - inDepth)) {
          M = e.M
          if (!physgun.holding) holdPair = { from: e.from, to: e.to }
          outDir.copy(input.aim.dir).transformDirection(e.M)
          near = e.t + (e.to.inset + 0.06) / Math.max(0.2, outDir.dot(e.to.n))
          entryAt.copy(e.at)
        }
      }
    }
    if (physgun.holding) {
      // a hold keeps the map it was taken through (and one taken straight
      // stays straight), wherever the crosshair wanders meanwhile
      if (holdVia < 0) return input
      M = holdM
      near = 0
    }
    if (!M) return input
    Object.assign(vInput, input)
    vInput.aim = vAim
    vAim.eye.copy(input.aim.eye).applyMatrix4(M)
    vAim.dir.copy(input.aim.dir).transformDirection(M)
    vAim.yaw = Math.atan2(-vAim.dir.x, -vAim.dir.z)
    vAim.near = near
    vAim.through = true
    if (M !== holdM) holdM.copy(M)
    // where the beam goes in and comes out, for drawing it in two
    exitAt.copy(entryAt).applyMatrix4(holdM)
    exitDir.copy(vAim.dir)
    viaNow = true
    return vInput
  }
  /** after the physgun's update: did it take hold through the pair */
  const noteHold = () => {
    if (physgun.holding && holdVia < 0 && viaNow) holdVia = portals.version
  }
  /** the second run of the beam: the gun to the entry oval */
  const beamIn = o.parent ? createBeam(o.parent) : null

  const select = (s: number) => {
    if (s < 0 || s >= SLOTS.length || !SLOTS[s] || s === slot) return
    if (!owned.has(SLOTS[s]!)) return
    if (physgun.holding) physgun.release(false)
    toolgun.cancel()
    slot = s
  }
  const cycle = (dir: number) => {
    for (let k = 1; k <= SLOTS.length; k++) {
      const s = (((slot + dir * k) % SLOTS.length) + SLOTS.length) % SLOTS.length
      if (SLOTS[s] && owned.has(SLOTS[s]!)) {
        select(s)
        return
      }
    }
  }
  const column = (c: number) => {
    const col = COLUMNS[c]
    if (!col) return
    const at = col.indexOf(slot)
    for (let k = 1; k <= col.length; k++) {
      const s = at < 0 ? col[k - 1] : col[(at + k) % col.length]
      if (SLOTS[s] && owned.has(SLOTS[s]!)) {
        select(s)
        return
      }
    }
  }

  const update = (input: ToolInput, active: boolean) => {
    aimDir.copy(input.aim.dir)
    aimEye.copy(input.aim.eye)
    // the machines hear the keys whatever is in your hand: a seat drives
    // with no tool out at all
    con.input(input.keys ?? NO_KEYS, input.seat ?? null)
    camera.step(input.dt)
    if (!active) {
      camera.cancel()
      if (physgun.holding) physgun.release(false)
      toolgun.cancel()
      con.held = null
      lastActive = false
      weapons.update(input, null, null)
      weapons.wield(null)
      return
    }
    // a click that brought the tool back (a pause, a seat) is not a grab
    if (!lastActive && input.fire) input.fire = false
    lastActive = true
    if (!physgun.holding && input.wheel) {
      // the paste ghost turns with the wheel, the paint and balloon modes read it as the palette
      if (SLOTS[slot] === 'toolgun' && toolgun.wantsWheel) { /* the ghost's turn, read by the gun */ }
      else if (SLOTS[slot] === 'toolgun' && toolgun.wantsColorWheel) toolgun.stepColor(input.wheel > 0 ? 1 : -1)
      else if (SLOTS[slot] === 'camera' && camera.wheel(input.wheel)) { /* the level, not the next tool */ }
      else cycle(input.wheel > 0 ? 1 : -1)
      input.wheel = 0
    }
    if (SLOTS[slot] === 'physgun') {
      physgun.update(beamAim(input))
      noteHold()
    } else {
      viaNow = false
      if (physgun.holding) physgun.release(false)
    }
    if (SLOTS[slot] === 'toolgun') toolgun.update(input)
    if (SLOTS[slot] === 'camera') camera.update(input)
    else camera.cancel()
    if (SLOTS[slot] === 'portalgun') {
      // a click opens one; holding it down does not keep firing
      if (input.fire && !portalFireWas) firePortal(0, input)
      else if (input.alt && !portalAltWas) firePortal(1, input)
      if (input.reload && !portalCloseWas) portals.close()
      portalFireWas = input.fire
      portalAltWas = input.alt
      portalCloseWas = input.reload
    } else portalFireWas = portalAltWas = portalCloseWas = false
    // the weapons keep their clocks whatever is out
    const tool = SLOTS[slot]
    weapons.update(input, isWeapon(tool) ? tool : null, shotFromSet ? shotFrom : null)
    weapons.wield(isWeapon(tool) ? tool : null)
    // a hoverball carried on the beam holds wherever it is let go
    con.held = physgun.prop?.id ?? null
  }

  const present = (f: ToolFrame) => {
    if (vm) vm.root.visible = true
    if (beam) beam.root.visible = true
    if (beamIn) beamIn.root.visible = true
    physgun.sync()
    // the machines' flames and ropes, every frame, whatever is in hand
    con.present(f.dt)
    const tool = SLOTS[slot]
    const shown = f.active && tool === 'physgun'
    const toolOut = f.active && tool === 'toolgun'
    const portalOut = f.active && tool === 'portalgun'
    const weaponOut = f.active && isWeapon(tool)
    tickWeapons(f.dt)
    // a portal riding a door or a prop goes where it went this frame
    portals.follow()
    portals.tick(f.dt)
    tracer = Math.max(0, tracer - f.dt)
    // (through a portal the gun points into the entry, not at the far side)
    if (viaNow && tool === 'physgun') aimAt.copy(entryAt)
    else if (physgun.holding) aimAt.copy(physgun.view.target)
    else if (physgun.view.mode === 'miss') aimAt.copy(physgun.view.end)
    else aimAt.copy(aimDir).multiplyScalar(24).add(aimEye)
    if (vm) {
      if (toolOut) {
        const [a, b] = toolgunScreen(toolgun.state, lang, toolgun.aimedKeys)
        vm.setScreen(a, b, toolgunSwatch(toolgun.state))
      }
      vm.update({
        camera: f.camera, dt: f.dt, gait: f.gait, grounded: f.grounded,
        holding: physgun.holding, strain: physgun.view.strain,
        firstPerson: f.firstPerson, hand: f.hand, handL: f.handL, aim: aimDir, aimAt,
        shown: shown || toolOut || portalOut || weaponOut,
        tool: tool === 'toolgun' || tool === 'portalgun' || isWeapon(tool) ? tool : 'physgun',
        loaded: isWeapon(tool) ? weapons.loaded(tool) : 1,
      })
    }
    if (beam) {
      if (vm && (shown || toolOut || portalOut || weaponOut)) vm.muzzle(muzzle, forward)
      else {
        f.camera.getWorldDirection(forward)
        muzzle.copy(f.camera.position).addScaledVector(forward, 0.8)
      }
      if (toolOut) {
        // the tool gun's beam is a flick to where the click landed, and the
        // halo sits on the first prop of a joint while it waits for the second
        const pend = toolgun.pending !== null ? sb.get(toolgun.pending) : undefined
        beam.holdHalo(pend?.mesh ?? null)
        beam.update({
          muzzle, forward, end: tracerEnd, target: tracerEnd, mode: tracer > 0 ? 'miss' : 'off',
          strain: 0, dt: f.dt, lines: f.lines, fov: f.camera.fov, camera: f.camera,
        })
      } else if (portalOut || weaponOut) {
        // the portal gun and the weapons draw no beam: its shot is the oval opening
        beam.holdHalo(null)
        beam.update({
          muzzle, forward, end: tracerEnd, target: tracerEnd, mode: 'off',
          strain: 0, dt: f.dt, lines: f.lines, fov: f.camera.fov, camera: f.camera,
        })
      } else {
        beam.holdHalo(shown ? physgun.prop?.mesh ?? null : null)
        // through a portal: a straight run into the entry, and the beam
        // proper out of the exit
        const via = shown && viaNow && physgun.view.mode !== 'off'
        beamIn?.update({
          muzzle, forward, end: entryAt, target: entryAt, mode: via ? 'miss' : 'off',
          strain: 0, dt: f.dt, lines: f.lines, fov: f.camera.fov, camera: f.camera,
        })
        beam.update({
          muzzle: via ? exitAt : muzzle, forward: via ? exitDir : forward,
          end: physgun.view.end, target: physgun.view.target, mode: shown ? physgun.view.mode : 'off',
          strain: physgun.view.strain, dt: f.dt, lines: f.lines, fov: f.camera.fov, camera: f.camera,
        })
      }
    }
    sfx?.hum(shown && physgun.holding, physgun.view.strain)
    if (weaponOut && vm) {
      vm.muzzle(shotFrom, forward)
      shotFromSet = true
    } else shotFromSet = false
  }

  return {
    get slot() {
      return slot
    },
    get tool() {
      return SLOTS[slot] ?? 'hands'
    },
    select,
    cycle,
    column,
    physgun,
    toolgun,
    camera,
    portals,
    give: (tool) => {
      if (owned.has(tool)) return false
      owned.add(tool)
      return true
    },
    has: (tool) => owned.has(tool),
    get contraption() {
      return con
    },
    get lang() {
      return lang
    },
    set lang(l) {
      lang = l
    },
    update,
    present,
    holster: () => {
      if (physgun.holding) physgun.release(false)
      toolgun.cancel()
      con.held = null
      if (vm) vm.root.visible = false
      if (beamIn) {
        beamIn.clear()
        beamIn.root.visible = false
      }
      if (beam) {
        beam.clear()
        beam.root.visible = false
      }
      sfx?.hum(false, 0)
      lastActive = false
    },
    get capturesLook() {
      return physgun.capturesLook
    },
    get capturesUse() {
      return physgun.holding
    },
    setSandbox: (next) => {
      if (next === sb) return
      beam?.holdHalo(null)
      beam?.clear()
      sb = next
      con.input(NO_KEYS, null, 0)
      con = contraptionOf(next)
      physgun.retarget(next)
      toolgun.retarget(next)
      weapons.retarget()
      offCarry()
      offCarry = next.onAfterSlice(carry)
    },
    setHandColor: (c) => vm?.setHandColor(c),
    stage: (camera) => {
      vm?.stage(camera)
      beam?.stage(camera)
      beamIn?.stage(camera)
      portalView?.stage(camera)
      weaponView?.stage(camera)
    },
    unstage: () => {
      vm?.unstage()
      beam?.unstage()
      beamIn?.unstage()
      portalView?.unstage()
      weaponView?.unstage()
    },
    beam,
    viewmodel: vm,
    portalView,
    weapons,
    weaponView,
    tickWeapons,
    receive: (m) => {
      weapons.receive(m, (id, out) => weaponView?.muzzleOf(id, out) ?? false)
      if (m.type === 'world-shot' && WEAPON_IDS[m.w]) weaponView?.remoteShot(m.id, WEAPON_IDS[m.w])
      if (m.type === 'world-welcome' || m.type === 'world-wields') weapons.wield(isWeapon(SLOTS[slot]) && lastActive ? SLOTS[slot] as WeaponId : null)
    },
    dispose: () => {
      offWeapons()
      weaponView?.dispose()
      offEvents()
      offTool()
      offPortals()
      offCarry()
      portalView?.dispose()
      toolgun.dispose()
      physgun.dispose()
      beam?.dispose()
      beamIn?.dispose()
      vm?.dispose()
      sfx?.dispose()
    },
  }
}

// the walker's side of the portals and their way to the Moon, for the scene
// that owns the walk and the levels
export { createPortalWalk, type PortalWalk } from './portalWalk'
export { createPortalMoon, type PortalMoon } from './portalMoon'
export { portalWorldMaterial } from './viewmodel'
