import * as THREE from 'three'
import { B, HIP_Y, NECK_OFF, WAIST_OFF, beanField, bindMatrixWorld } from './bodyShape'
import type { Field } from './isoSurface'

/*
  How far a point is from a body's own surface: the bean and whatever it is
  wearing, never its arms or legs. It exists so a body's mittens can be kept
  out of itself: an emote or the point key names where a mitten should go,
  and on a chubby bean in a cap and a headset some of those places are inside
  the belly, the brim or a cup, which on screen is a forearm vanishing into a
  face. `playerBody.ts` asks this after the arms are posed and re-solves any
  arm whose mitten or forearm comes out inside.

  Two surfaces, measured two ways.

  **The bean** is exact: it is the same egg `bodyShape.ts` polygonized the
  skin from (`beanField`, per build), evaluated in the pose the skin was
  drawn in. A point is carried back there through the bone the skin at that
  height rides on, twice over: through the torso for the trunk and through
  the head for the head, each copy cut off where the other takes over, so a
  bowed head moves the face the mitten is resting on and not the belly under
  it. The torso's squash rides along in that inverse, so a landing's squat
  bean is the one measured.

  **What is worn** is sampled rather than written: the variant's own vertices
  that stand proud of the bean and carry no weight from a limb (a brim, a headset's cups, the beaver's snout
  and ears, a hood, a helmet, a pack), thinned to one per few centimetres
  and each kept with its normal and the bone that carries it, bucketed on a
  coarse grid in the pose they were drawn in, so a query is carried back
  into that pose through each carrying bone and looks at a few cells. Just behind
  one of them is inside (so a mitten that has only just gone through a brim
  is pushed out the side it came in from); anywhere else is outside, by the
  distance to the nearest, since what is worn is thin and a forearm behind a
  mic boom is past it, not in it. Taken from the geometry, it knows
  every piece of gear there is and every one added later, with no table to
  keep in step. It is built the first time it is asked for on a geometry,
  since most bodies never emote.

  All of it is in the group's own frame (design units), headless and
  allocation-free per call.
*/

export interface SelfContact {
  /** read the bones' poses; call once the pose is final, before `distance` */
  pose: () => void
  /** signed distance (design units, negative inside) from a group-local point
      to the body's own surface; `n` receives the outward direction there.
      Past `need` the answer is only a lower bound and `n` is not written,
      which is most of the calls and most of the saving */
  distance: (p: THREE.Vector3, n: THREE.Vector3, need?: number) => number
}

/** the bones an arm or a leg is made of: never part of the surface */
const LIMB_BONES = new Set<number>([
  B.UARM_L, B.FARM_L, B.HAND_L, B.UARM_R, B.FARM_R, B.HAND_R,
  B.THIGH_L, B.SHIN_L, B.FOOT_L, B.THIGH_R, B.SHIN_R, B.FOOT_R,
  B.SHOULDER_L, B.SHOULDER_R, B.HIP_L, B.HIP_R,
])
/** the head bone's height in the drawing: where the trunk hands over */
const NECK_Y = HIP_Y + WAIST_OFF + NECK_OFF
/** how far either copy of the bean reaches past the neck into the other's */
const SEAM = 0.28
/** a worn vertex is one standing at least this far off the bean */
const PROUD = 0.035
/** worn vertices are thinned to one per cell this size */
const CELL = 0.055
/** how far behind a worn vertex still counts as inside the piece */
const THIN = 0.04
/** beyond this a worn point is only a lower bound on the distance */
const NEAR = 0.3

/** the worn points riding one bone, bucketed on a coarse grid in the pose
    they were drawn in, so a query carried back into that pose looks at a
    handful of cells rather than every point */
interface GearGroup {
  bone: number
  p: Float32Array
  n: Float32Array
  cells: Map<number, number[]>
  /** the points' box, to skip the group outright */
  box: THREE.Box3
}
interface Gear {
  groups: GearGroup[]
  count: number
}
/** the grid's cell: at least the furthest any caller asks about, so the
    3x3x3 cells round a query always hold its nearest point */
const GRID = 0.32
const cellKey = (x: number, y: number, z: number) =>
  (Math.floor(x / GRID) + 64) * 16384 + (Math.floor(y / GRID) + 64) * 128 + (Math.floor(z / GRID) + 64)

const gearOf = (geo: THREE.BufferGeometry, bean: Field): Gear => {
  const pos = geo.getAttribute('position')
  const nrm = geo.getAttribute('normal')
  const si = geo.getAttribute('skinIndex')
  const sw = geo.getAttribute('skinWeight')
  const seen = new Set<number>()
  const keep: number[] = []
  for (let i = 0; i < pos.count; i++) {
    let bi = si.getX(i)
    let bw = sw.getX(i)
    if (sw.getY(i) > bw) { bi = si.getY(i); bw = sw.getY(i) }
    if (sw.getZ(i) > bw) { bi = si.getZ(i); bw = sw.getZ(i) }
    if (sw.getW(i) > bw) bi = si.getW(i)
    if (LIMB_BONES.has(bi)) continue
    // nor the skin where a limb blends into the flank, which stands proud
    // of the bean and is the arm's own root, not something worn
    let limbW = 0
    if (LIMB_BONES.has(si.getX(i))) limbW += sw.getX(i)
    if (LIMB_BONES.has(si.getY(i))) limbW += sw.getY(i)
    if (LIMB_BONES.has(si.getZ(i))) limbW += sw.getZ(i)
    if (LIMB_BONES.has(si.getW(i))) limbW += sw.getW(i)
    if (limbW > 0.01) continue
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    if (bean(x, y, z) < PROUD) continue
    // a cell per facing, too: the top and the underside of a brim thinner
    // than a cell are both kept, or a mitten above one reads as inside it
    const nx = nrm.getX(i)
    const ny = nrm.getY(i)
    const nz = nrm.getZ(i)
    const ax = Math.abs(nx)
    const ay = Math.abs(ny)
    const az = Math.abs(nz)
    const face = ax > ay && ax > az ? (nx > 0 ? 0 : 1) : ay > az ? (ny > 0 ? 2 : 3) : nz > 0 ? 4 : 5
    const key = ((Math.floor(x / CELL) + 512) * 1048576 + (Math.floor(y / CELL) + 512) * 1024 + (Math.floor(z / CELL) + 512)) * 8 + face
    if (seen.has(key)) continue
    seen.add(key)
    keep.push(i, bi)
  }
  const byBone = new Map<number, number[]>()
  for (let k = 0; k < keep.length; k += 2) {
    const list = byBone.get(keep[k + 1]) ?? []
    list.push(keep[k])
    byBone.set(keep[k + 1], list)
  }
  const groups: GearGroup[] = []
  for (const [bone, idx] of byBone) {
    const gp = new Float32Array(idx.length * 3)
    const gn = new Float32Array(idx.length * 3)
    const cells = new Map<number, number[]>()
    idx.forEach((i, k) => {
      gp[k * 3] = pos.getX(i)
      gp[k * 3 + 1] = pos.getY(i)
      gp[k * 3 + 2] = pos.getZ(i)
      gn[k * 3] = nrm.getX(i)
      gn[k * 3 + 1] = nrm.getY(i)
      gn[k * 3 + 2] = nrm.getZ(i)
      const key = cellKey(gp[k * 3], gp[k * 3 + 1], gp[k * 3 + 2])
      const c = cells.get(key)
      if (c) c.push(k)
      else cells.set(key, [k])
    })
    const box = new THREE.Box3()
    for (let k = 0; k < idx.length; k++) box.expandByPoint(new THREE.Vector3(gp[k * 3], gp[k * 3 + 1], gp[k * 3 + 2]))
    groups.push({ bone, p: gp, n: gn, cells, box })
  }
  return { groups, count: keep.length / 2 }
}

/** built once per geometry and shared by every body wearing it */
const GEAR = new WeakMap<THREE.BufferGeometry, Gear>()

export function createSelfContact(
  group: THREE.Object3D,
  mesh: THREE.SkinnedMesh,
  build: () => number,
): SelfContact {
  const bones = mesh.skeleton.bones
  const inverses = mesh.skeleton.boneInverses
  const torso = bones[B.TORSO]
  const head = bones[B.HEAD]
  const bindT = bindMatrixWorld(B.TORSO, new THREE.Matrix4())
  const bindH = bindMatrixWorld(B.HEAD, new THREE.Matrix4())
  const groupInv = new THREE.Matrix4()
  const mapT = new THREE.Matrix4()
  const mapH = new THREE.Matrix4()
  const jT = new THREE.Matrix3()
  const jH = new THREE.Matrix3()
  const boneM: THREE.Matrix4[] = bones.map(() => new THREE.Matrix4())
  const boneN: THREE.Matrix3[] = bones.map(() => new THREE.Matrix3())
  const boneStamp = new Int32Array(bones.length).fill(-1)
  let stamp = 0
  // each gear bone's map from the group's frame back into the drawing
  const back: THREE.Matrix4[] = bones.map(() => new THREE.Matrix4())
  const backStamp = new Int32Array(bones.length).fill(-1)
  const q = new THREE.Vector3()
  const g = new THREE.Vector3()

  const pose = () => {
    stamp++
    groupInv.copy(group.matrixWorld).invert()
    // posed = L * bind^-1 * drawn, so drawn = bind * L^-1 * posed
    mapT.multiplyMatrices(groupInv, torso.matrixWorld).invert().premultiply(bindT)
    mapH.multiplyMatrices(groupInv, head.matrixWorld).invert().premultiply(bindH)
    // a gradient in the drawing comes back through the transpose
    jT.setFromMatrix4(mapT).transpose()
    jH.setFromMatrix4(mapH).transpose()
  }

  /** one copy of the bean, cut at the seam: `below` keeps the trunk */
  const cut = (bean: Field, x: number, y: number, z: number, below: boolean) =>
    Math.max(bean(x, y, z), below ? y - (NECK_Y + SEAM) : NECK_Y - SEAM - y)

  const beanCopy = (
    bean: Field, map: THREE.Matrix4, jac: THREE.Matrix3, below: boolean, p: THREE.Vector3, n: THREE.Vector3,
    need: number,
  ) => {
    q.copy(p).applyMatrix4(map)
    const d = cut(bean, q.x, q.y, q.z, below)
    if (d > need) return d
    const e = 0.008
    g.set(
      cut(bean, q.x + e, q.y, q.z, below) - cut(bean, q.x - e, q.y, q.z, below),
      cut(bean, q.x, q.y + e, q.z, below) - cut(bean, q.x, q.y - e, q.z, below),
      cut(bean, q.x, q.y, q.z + e, below) - cut(bean, q.x, q.y, q.z - e, below),
    ).applyMatrix3(jac)
    const len = g.length()
    if (len > 1e-9) n.copy(g).divideScalar(len)
    return d
  }

  const boneMatrix = (b: number) => {
    if (boneStamp[b] !== stamp) {
      boneStamp[b] = stamp
      boneM[b].multiplyMatrices(groupInv, bones[b].matrixWorld).multiply(inverses[b])
      boneN[b].getNormalMatrix(boneM[b])
    }
    if (backStamp[b] !== stamp) {
      backStamp[b] = stamp
      back[b].copy(boneM[b]).invert()
    }
    return b
  }

  const gearFor = (): Gear => {
    const geo = mesh.geometry
    let gear = GEAR.get(geo)
    if (!gear) {
      gear = gearOf(geo, beanField(build()))
      GEAR.set(geo, gear)
    }
    return gear
  }
  const gq = new THREE.Vector3()

  const nT = new THREE.Vector3()
  const nH = new THREE.Vector3()
  const distance = (p: THREE.Vector3, n: THREE.Vector3, need = NEAR) => {
    const bean = beanField(build())
    nT.set(0, 0, 1)
    nH.set(0, 0, 1)
    const dT = beanCopy(bean, mapT, jT, true, p, nT, need)
    const dH = beanCopy(bean, mapH, jH, false, p, nH, need)
    let d = dT
    n.copy(nT)
    if (dH < d) {
      d = dH
      n.copy(nH)
    }
    // the nearest worn vertex, signed by its normal, found in the pose it
    // was drawn in through the bone that carries it
    const gear = gearFor()
    if (gear.count === 0) return d
    const reach = Math.min(d, need, NEAR) + CELL
    let best = reach * reach
    let bg: GearGroup | null = null
    let bk = -1
    for (const grp of gear.groups) {
      boneMatrix(grp.bone)
      gq.copy(p).applyMatrix4(back[grp.bone])
      const far = grp.box.distanceToPoint(gq)
      if (far * far >= best) continue
      const cx = Math.floor(gq.x / GRID)
      const cy = Math.floor(gq.y / GRID)
      const cz = Math.floor(gq.z / GRID)
      const gp = grp.p
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iy = cy - 1; iy <= cy + 1; iy++) {
          for (let iz = cz - 1; iz <= cz + 1; iz++) {
            const list = grp.cells.get((ix + 64) * 16384 + (iy + 64) * 128 + (iz + 64))
            if (!list) continue
            for (const k of list) {
              const dx = gq.x - gp[k * 3]
              const dy = gq.y - gp[k * 3 + 1]
              const dz = gq.z - gp[k * 3 + 2]
              const d2 = dx * dx + dy * dy + dz * dz
              if (d2 < best) {
                best = d2
                bg = grp
                bk = k
                g.set(dx, dy, dz)
              }
            }
          }
        }
      }
    }
    if (bg) {
      const gn = bg.n
      const along = g.x * gn[bk * 3] + g.y * gn[bk * 3 + 1] + g.z * gn[bk * 3 + 2]
      // just behind a vertex (and not off past its edge) the distance is
      // how far back along its normal: a mitten that has only just gone
      // through a brim is pushed out the side it came in from. Anywhere else
      // it is to the nearest vertex, a shade short of the surface between
      // two of them, and pointing away from it. Deeper than THIN behind a
      // vertex is not inside anything: the pieces are thin (a mic boom, a
      // brim, a cup's rim), and a forearm behind a boom is past it
      const side2 = best - along * along
      const dist = Math.sqrt(best)
      if (along < 0 && along > -THIN && side2 < CELL * CELL * 1.5) {
        if (along < d) {
          d = along
          n.set(gn[bk * 3], gn[bk * 3 + 1], gn[bk * 3 + 2]).applyMatrix3(boneN[bg.bone]).normalize()
        }
      } else if (dist - CELL * 0.6 < d) {
        d = dist - CELL * 0.6
        if (dist > 1e-5) n.copy(g).divideScalar(dist)
        else n.set(gn[bk * 3], gn[bk * 3 + 1], gn[bk * 3 + 2])
        n.applyMatrix3(boneN[bg.bone]).normalize()
      }
    }
    return d
  }

  return { pose, distance }
}
