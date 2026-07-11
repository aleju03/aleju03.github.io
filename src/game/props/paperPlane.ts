import * as THREE from 'three'

/*
  The hero's paper dart, landed. When the wreck swallows the plane out on
  the portfolio page, the warp tags the boot with via:'plane' and the room
  answers by laying this souvenir on the bedroom rug — the same two creased
  wing panels and keel as BlockName's dart (drawn flat in the top view,
  extruded paper-thin, folded), with the same inked outlines, in the hero's
  dark-theme palette frozen solid because the room is always night. It
  rests the way a thrown dart actually settles: nose dipped, keeled over
  onto one wing. buildPaperPlane() returns a group whose origin is the
  floor contact point with the nose along +x — position it, yaw it, add it.
*/

const PAPER = 0.07 // sheet thickness, in the dart's own drawing units
const FOLD = 0.36 // dihedral: the wings rise from the keel in a shallow V
const SCALE = 0.16 // drawing units -> room units: a ~0.75-unit (real toy) dart

export function buildPaperPlane(): THREE.Group {
  const paperMat = new THREE.MeshStandardMaterial({ color: '#fbf2e5', roughness: 0.9 })
  const creaseMat = new THREE.MeshStandardMaterial({ color: '#807160', roughness: 0.9 })
  const inkMat = new THREE.LineBasicMaterial({ color: '#807160' })
  const body = new THREE.Group()
  const sheet = (
    pts: [number, number][],
    mat: THREE.Material,
    fold: (geo: THREE.ExtrudeGeometry) => void,
  ) => {
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (const [x, y] of pts.slice(1)) shape.lineTo(x, y)
    shape.closePath()
    const geo = new THREE.ExtrudeGeometry(shape, { depth: PAPER, bevelEnabled: false })
    fold(geo)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.castShadow = true
    body.add(mesh)
    body.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), inkMat))
  }
  // the wings: nose point, swept-back wingtip, root just off the fold line
  for (const side of [1, -1] as const) {
    sheet(
      [
        [2.7, side * 0.02],
        [-2.1, side * 1.75],
        [-1.85, side * 0.06],
      ],
      paperMat,
      (geo) => geo.rotateX(side * FOLD),
    )
  }
  // the keel hanging under the fold, in the darker inner-crease shade
  sheet(
    [
      [2.7, 0],
      [-2.1, 0],
      [-2.1, -0.72],
    ],
    creaseMat,
    (geo) => {
      geo.rotateX(Math.PI / 2)
      geo.translate(0, PAPER / 2, 0)
    },
  )
  // the drawing lives in page space (z up off the sheet); stand it into the
  // room (y up, nose +x), then land it the way a dart actually comes to
  // rest: pitched so the keel's bottom edge lies flat (it deepens toward
  // the tail, so matching its slope dips the nose), then keeled over until
  // one wingtip catches the floor — at this fold the keel edge and the
  // wingtip touch together at atan((tipRise + keelDepth) / halfSpan)
  body.rotation.x = -Math.PI / 2
  const pose = new THREE.Group()
  pose.add(body)
  pose.rotation.set(Math.atan2(Math.sin(FOLD) * 1.75 + 0.72, 1.75), 0, -Math.atan2(0.72, 4.8))
  pose.scale.setScalar(SCALE)
  const group = new THREE.Group()
  group.add(pose)
  // origin = floor: drop the pose so its lowest point (the grounded
  // wingtip) sits at y 0
  group.updateMatrixWorld(true)
  pose.position.y = -new THREE.Box3().setFromObject(pose).min.y
  return group
}
