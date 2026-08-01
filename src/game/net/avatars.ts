import * as THREE from 'three'
import {
  DESIGN_CROWN, DESIGN_EYE, buildPlayerBody, type PlayerPose, type PlayerRig,
} from '../player/playerBody'
import { unpackLook } from '../player/look'
import type { RagdollEnv } from '../player/ragdoll'
import { makeCollisionSet, type CollisionSet } from '../physics/collision'
import { canvasTexture } from '../core/textures'
import type { PlayerId } from './protocol'
import type { RemotePlayer, RemoteWorld } from './remotePlayers'

/*
  The other people, drawn. `net/remotePlayers.ts` decides where everyone is;
  this module is the only thing that turns that into meshes, and it is
  deliberately thin — the hard part was already solved for the local player.

  Every remote body is another `buildPlayerBody()`, the same articulated robot
  the local player wears, fed the same `PlayerPose` struct. That works because
  the rig was written to be watched: `pose.show` scales the cinematic layer
  (speed lean, gaze-follow) that the first-person lens has to suppress, and at
  show = 1 the head is un-hidden and the full performance runs. Nothing in the
  rig is a singleton, so the factory can simply be called again per player.

  Three deviations from the local body, all deliberate:

  - Remote bodies do not cast shadows. Shadow maps here are hand-baked and
    only re-rendered when something near a caster flags them; a crowd of
    moving casters would either bake stale silhouettes into the map or force
    a re-bake every frame, and neither is worth what a shadow buys under
    somebody else's feet.
  - Remote parts *are* frustum culled. The local body opts out because it hugs
    the lens and culling blinks its limbs, which cannot happen to a body that
    is by definition somewhere else.
  - The whole group is hidden past CULL_DIST. Beyond that a player is under a
    pixel tall and their name is unreadable, so the cost is pure.

  Over each head ride three sprites, all painted at runtime like everything
  else here: a name plate, a speaker badge that appears while its owner is
  talking, and a chat bubble that surfaces whatever they last said for a few
  seconds. The badge reads the network's `speaking` bit rather than the audio,
  so someone shouting from across the valley — too far for proximity voice to
  carry — still visibly has something to say.

  Passengers are the fourth case, and they are a *reparenting*, not a pose.

  A player sitting in a machine is not placed from their own pose stream at
  all: their group is hung off the vehicle's own seat node and left there. It
  has to work that way. The alternative is to place a seated body at the
  coordinates their client is sending — which are the vehicle's, sampled on a
  different clock, interpolated by a different buffer — and the result is a
  driver sliding around inside their own car by a few centimetres every time
  the two playbacks disagree. Hung off the seat, they are welded to the
  bodywork exactly as the local player's rig is, and every attitude the
  machine has is theirs for free.
*/

export interface AvatarEnv {
  /** the floor under an arbitrary x/z in the live level: the remote's feet
      are solved against the ground *they* stand on, not the local player's */
  groundAt: (x: number, z: number) => number
  ceilingY?: number
  collision: CollisionSet
  /** the lens, for distance culling */
  eyePos: THREE.Vector3
  /** the seat node this player is sitting in, or null for anyone on foot.
      Supplied by the scene, which is the only side that knows both the seat
      table and the fleet's scene graph */
  seatOf?: (id: PlayerId) => THREE.Object3D | null
}

export interface RemoteAvatars {
  root: THREE.Group
  /** draw one frame of whatever the store currently believes */
  update: (world: RemoteWorld, dt: number, env: AvatarEnv) => void
  /** float a line of chat over a player's head for a few seconds */
  say: (id: PlayerId, text: string) => void
  /** a player renamed or repainted. Both are rare and both are cheap: a
      repaint is four `Color.set()` calls (never a relink), a rename is one
      canvas the size of the word. A body that has not spawned yet needs
      neither — `update` reads the roster on the way in */
  reskin: (id: PlayerId, entry: { name: string; admin: boolean; look?: string }) => void
  dispose: () => void
}

/** past this a body is a pixel and a name plate is unreadable */
const CULL_DIST = 190
const CULL_DIST_SQ = CULL_DIST * CULL_DIST
/** how long a chat line hangs over the head that said it */
const BUBBLE_MS = 7_000

/*
  What floats over a head, in the rig's own design units.

  These are children of the body's group, which is *scaled* (see
  `bodyScale`), so a height in world units gets multiplied by that scale on
  its way to the screen and lands somewhere other than where it was written.
  Written in design units they mean what they say, and, the point of it,
  they can be stacked off DESIGN_CROWN, the actual top of the actual head,
  instead of off a fraction of the eye height that happened to look right at
  one body size. The badge used to sit two units clear of the crown, which is
  a speaker glyph hanging in the sky over somebody.
*/
const NAME_H = 0.3
const BADGE_H = 0.3
const BUBBLE_H = 0.28
/** the plate clears the antenna, the badge sits on the plate, the bubble on
    the badge, each a hair apart, all measured from the crown up */
const NAME_UP = 0.26
const BADGE_UP = NAME_UP + 0.42
const BUBBLE_UP = BADGE_UP + 0.36
/** where that crown is over the group's own origin, which is not the same
    place in both poses: standing, the origin is the soles; seated, `sit()`
    hangs the body from its eye so the origin is the face. Everything floating
    over the head moves with it or a driver's name ends up on the ceiling */
const STAND_TOP = DESIGN_CROWN
const SEAT_TOP = DESIGN_CROWN - DESIGN_EYE

/** one speaker glyph, shared by every badge in the world: a cone and two
    arcs, drawn once. Sprite materials still get their own instance so each
    badge can fade on its own clock. */
let badgeTex: THREE.Texture | null = null
const speakerTexture = () => {
  if (badgeTex) return badgeTex
  badgeTex = canvasTexture([128, 128], (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h)
    const cx = w * 0.42
    const cy = h / 2
    // a soft dark disc so the glyph reads against snow, sky or asphalt
    ctx.fillStyle = 'rgba(12,16,20,0.62)'
    ctx.beginPath()
    ctx.arc(w / 2, cy, w * 0.46, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#e9f4ff'
    ctx.strokeStyle = '#e9f4ff'
    ctx.lineCap = 'round'
    // speaker box + cone
    ctx.beginPath()
    ctx.moveTo(cx - 22, cy - 11)
    ctx.lineTo(cx - 8, cy - 11)
    ctx.lineTo(cx + 10, cy - 27)
    ctx.lineTo(cx + 10, cy + 27)
    ctx.lineTo(cx - 8, cy + 11)
    ctx.lineTo(cx - 22, cy + 11)
    ctx.closePath()
    ctx.fill()
    // two waves
    ctx.lineWidth = 6
    for (let i = 0; i < 2; i++) {
      ctx.beginPath()
      ctx.arc(cx + 12, cy, 16 + i * 13, -0.72, 0.72)
      ctx.stroke()
    }
  })
  return badgeTex
}

/** a rounded plaque with centred text, sized to the string it holds */
const plaqueTexture = (
  text: string,
  { bg, fg, weight }: { bg: string; fg: string; weight: string },
) => {
  const pad = 22
  const font = `${weight} 46px ui-sans-serif, system-ui, sans-serif`
  // measure on a throwaway context so the real canvas can be sized to fit
  const probe = document.createElement('canvas').getContext('2d')
  if (probe) probe.font = font
  const textW = probe ? probe.measureText(text).width : text.length * 24
  const w = Math.min(1024, Math.ceil(textW + pad * 2))
  const h = 84
  const tex = canvasTexture([w, h], (ctx) => {
    ctx.clearRect(0, 0, w, h)
    const r = h * 0.34
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.roundRect(1, 1, w - 2, h - 2, r)
    ctx.fill()
    ctx.font = font
    ctx.fillStyle = fg
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, w / 2, h / 2 + 2)
  })
  return { tex, aspect: w / h }
}

const makeSprite = (map: THREE.Texture, height: number, aspect: number) => {
  const mat = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    // honest occlusion: a name behind the house is behind the house. Voices
    // still carry through walls, but a plate floating over solid brick reads
    // as a bug rather than as presence.
    depthTest: true,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(height * aspect, height, 1)
  return sprite
}

interface Avatar {
  rig: PlayerRig
  group: THREE.Group
  name: THREE.Sprite
  nameTex: THREE.Texture
  /** what the plate currently says, and what the body is currently painted
      in: a rename or a repaint that changes nothing must not redraw a canvas */
  nameText: string
  nameAdmin: boolean
  look: string | undefined
  badge: THREE.Sprite
  bubble: THREE.Sprite | null
  bubbleTex: THREE.Texture | null
  bubbleUntil: number
  /** eased 0..1 so the badge fades instead of strobing with the voice gate */
  badgeK: number
  wasDown: boolean
  clock: number
  /** the seat node this body is currently parented to, or null for the world */
  seat: THREE.Object3D | null
  /** the crown height the tags over this head are currently stacked on */
  top: number
}

export function createRemoteAvatars(eye: number, grav = 34): RemoteAvatars {
  const root = new THREE.Group()
  root.userData.dynamic = true // people move; never freeze this subtree
  const avatars = new Map<PlayerId, Avatar>()
  // reused every frame across every body — a crowd must not feed the GC
  const pose: PlayerPose = {
    dt: 0, gait: 0, crouchK: 0, grounded: true, run: false,
    yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, landing: 0, show: 1,
  }
  const env: RagdollEnv = {
    groundY: 0,
    collision: makeCollisionSet({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }),
  }
  /** a seated body's group position is local to the machine, so the distance
      cull has to ask the matrix rather than read the vector */
  const seatWorld = new THREE.Vector3()

  const namePlate = (text: string, admin: boolean) =>
    plaqueTexture(text, {
      bg: admin ? 'rgba(157,85,66,0.82)' : 'rgba(12,16,20,0.62)',
      fg: '#f2f5f8',
      weight: admin ? '700' : '500',
    })

  const spawn = (player: RemotePlayer): Avatar => {
    const rig = buildPlayerBody(eye, grav, unpackLook(player.look))
    const group = rig.group
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false
        o.frustumCulled = true
      }
    })

    const { tex: nameTex, aspect } = namePlate(player.name, player.admin)
    const name = makeSprite(nameTex, NAME_H, aspect)
    group.add(name)

    const badge = makeSprite(speakerTexture(), BADGE_H, 1)
    badge.visible = false
    group.add(badge)

    root.add(group)
    const a: Avatar = {
      rig, group, name, nameTex, badge,
      nameText: player.name, nameAdmin: player.admin, look: player.look,
      bubble: null, bubbleTex: null, bubbleUntil: 0,
      badgeK: 0, wasDown: false, clock: 0, seat: null, top: STAND_TOP,
    }
    stackTags(a)
    return a
  }

  /** re-stack whatever is floating over this head onto `a.top` */
  const stackTags = (a: Avatar) => {
    a.name.position.y = a.top + NAME_UP
    a.badge.position.y = a.top + BADGE_UP
    if (a.bubble) a.bubble.position.y = a.top + BUBBLE_UP
  }

  /** move a body between the world and a machine's seat. The rig's own pose
      is set on the way in (the same fold the local player wears) and cleared
      on the way out, so a player who gets out of a car does not walk away
      still sitting down */
  const reseat = (a: Avatar, seat: THREE.Object3D | null) => {
    if (a.seat === seat) return
    a.seat = seat
    a.group.parent?.remove(a.group)
    if (seat) {
      seat.add(a.group)
      // the seat node is the seated eye and `sit()` hangs the body under it,
      // so the group goes on it flat. Its scale is deliberately left alone:
      // this body is the size it is, and forcing it to 1 to make it fit a
      // cabin is how a player used to walk out of a car nine per cent shorter
      // than they got into it
      a.group.position.set(0, 0, 0)
      // the seat faces the machine's forward; the rig is built facing the
      // other way, exactly as CrtScene turns the local body round
      a.group.rotation.set(0, Math.PI, 0)
      a.rig.reset()
      a.rig.sit()
    } else {
      root.add(a.group)
      a.group.rotation.set(0, 0, 0)
      a.rig.reset()
    }
    a.top = seat ? SEAT_TOP : STAND_TOP
    stackTags(a)
  }

  const dropBubble = (a: Avatar) => {
    if (!a.bubble) return
    a.group.remove(a.bubble)
    a.bubble.material.dispose()
    a.bubbleTex?.dispose()
    a.bubble = null
    a.bubbleTex = null
  }

  const despawn = (id: PlayerId) => {
    const a = avatars.get(id)
    if (!a) return
    dropBubble(a)
    // it may be hanging off a vehicle seat rather than off this root
    a.group.parent?.remove(a.group)
    a.name.material.dispose()
    a.nameTex.dispose()
    a.badge.material.dispose()
    // The six materials this body built itself, and nothing else. The
    // geometry is deliberately left alone: every rig shares one module-level
    // set (see playerBody.ts), so disposing it here would take the arms off
    // everybody still standing, the local player included.
    a.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat.dispose()
    })
    avatars.delete(id)
  }

  return {
    root,

    update(world, dt, worldEnv) {
      const now = performance.now()

      // retire anyone the store has dropped (left, or stepped into another level)
      for (const id of avatars.keys()) {
        if (!world.players.has(id)) despawn(id)
      }

      env.collision = worldEnv.collision
      env.ceilingY = worldEnv.ceilingY

      for (const [id, player] of world.players) {
        let a = avatars.get(id)
        if (!a) {
          a = spawn(player)
          avatars.set(id, a)
          a.rig.face(player.yaw)
        }
        a.clock += dt

        // --- a seat wins over everything below ----------------------------
        // Sitting in something is the one state that owns placement outright:
        // no ragdoll (you cannot flop in a car), no walk pose, no ground
        // solve. The seat node is the body's whole transform.
        const seat = worldEnv.seatOf?.(id) ?? null
        if (seat || a.seat) reseat(a, seat)
        if (seat) {
          a.group.getWorldPosition(seatWorld)
          const seatVisible = seatWorld.distanceToSquared(worldEnv.eyePos) < CULL_DIST_SQ
          a.group.visible = seatVisible
          if (!seatVisible) continue
          const to = player.speaking ? 1 : 0
          a.badgeK += (to - a.badgeK) * (1 - Math.exp(-14 * dt))
          const lit = a.badgeK > 0.02
          a.badge.visible = lit
          if (lit) {
            a.badge.material.opacity = Math.min(1, a.badgeK * 1.2)
            const s = BADGE_H * a.badgeK * (1 + Math.sin(a.clock * 7) * 0.07 * a.badgeK)
            a.badge.scale.set(s, s, 1)
          }
          if (a.bubble && now > a.bubbleUntil) dropBubble(a)
          if (a.bubble) a.bubble.position.y = a.top + BUBBLE_UP + BADGE_H * a.badgeK * 0.6
          a.wasDown = player.down
          continue
        }

        // --- flops -------------------------------------------------------
        // A ragdoll is cosmetic, so it is simulated locally rather than
        // streamed: while it runs, the verlet sim owns the body's placement
        // and the network position is ignored (the rig's own contract). The
        // get-up re-seats the group on whatever the network says by then.
        if (player.down && !a.wasDown) {
          a.rig.flop(player.vx, player.vy + 1.6, player.vz)
        } else if (!player.down && a.wasDown && a.rig.down) {
          a.group.position.set(player.x, player.y, player.z)
          a.group.updateMatrixWorld(true)
          a.rig.beginRecover()
        }
        a.wasDown = player.down

        if (!a.rig.ragdolling) {
          if (player.snapped) a.rig.face(player.yaw)
          a.group.position.set(player.x, player.y, player.z)
          a.group.rotation.y = a.rig.facing + Math.PI
        }

        // --- distance work ------------------------------------------------
        const camDistSq = a.group.position.distanceToSquared(worldEnv.eyePos)
        const visible = camDistSq < CULL_DIST_SQ
        a.group.visible = visible
        if (!visible) continue

        // --- the body ------------------------------------------------------
        pose.dt = dt
        pose.gait = player.gait
        pose.crouchK = player.crouchK
        pose.grounded = player.grounded
        pose.run = player.run
        pose.yaw = player.yaw
        pose.pitch = player.pitch
        pose.vx = player.vx
        pose.vz = player.vz
        pose.vy = player.vy
        pose.landing = player.landing
        env.groundY = worldEnv.groundAt(player.x, player.z)
        a.rig.update(pose, env)

        // --- the badge -----------------------------------------------------
        const to = player.speaking ? 1 : 0
        a.badgeK += (to - a.badgeK) * (1 - Math.exp(-14 * dt))
        const lit = a.badgeK > 0.02
        a.badge.visible = lit
        if (lit) {
          a.badge.material.opacity = Math.min(1, a.badgeK * 1.2)
          // a slow breathing pulse, so a live mic reads as live even when the
          // speaker is between words
          const pulse = 1 + Math.sin(a.clock * 7) * 0.07 * a.badgeK
          const s = BADGE_H * a.badgeK * pulse
          a.badge.scale.set(s, s, 1)
        }

        // --- the bubble ----------------------------------------------------
        if (a.bubble && now > a.bubbleUntil) dropBubble(a)
        if (a.bubble) {
          // ride above the badge only while the badge is actually there
          a.bubble.position.y = a.top + BUBBLE_UP + BADGE_H * a.badgeK * 0.6
        }
      }
    },

    reskin(id, entry) {
      const a = avatars.get(id)
      if (!a) return
      if (entry.look !== a.look) {
        a.look = entry.look
        a.rig.setLook(unpackLook(entry.look))
      }
      if (entry.name === a.nameText && entry.admin === a.nameAdmin) return
      a.nameText = entry.name
      a.nameAdmin = entry.admin
      const { tex, aspect } = namePlate(entry.name, entry.admin)
      a.name.material.map = tex
      a.name.material.needsUpdate = true
      a.name.scale.set(NAME_H * aspect, NAME_H, 1)
      a.nameTex.dispose()
      a.nameTex = tex
    },

    say(id, text) {
      const a = avatars.get(id)
      if (!a) return
      dropBubble(a)
      const { tex, aspect } = plaqueTexture(text, {
        bg: 'rgba(233,244,255,0.92)',
        fg: '#12161a',
        weight: '500',
      })
      const bubble = makeSprite(tex, BUBBLE_H, aspect)
      bubble.position.y = a.top + BUBBLE_UP
      a.group.add(bubble)
      a.bubble = bubble
      a.bubbleTex = tex
      a.bubbleUntil = performance.now() + BUBBLE_MS
    },

    dispose() {
      for (const id of [...avatars.keys()]) despawn(id)
      badgeTex?.dispose()
      badgeTex = null
      root.parent?.remove(root)
    },
  }
}
