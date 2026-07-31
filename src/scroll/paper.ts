/*
  The folded-paper primitive, shared by everything on the hero canvas that is
  meant to read as a sheet: the paper dart in BlockName and the waypoints the
  flight path threads.

  One sheet is drawn flat as a 2D outline, extruded paper-thin, folded, and
  then outlined in the letters' side colour — the fold has to transform the
  GEOMETRY rather than the mesh, because the outline is derived from the folded
  result. Take the materials from the caller and share the Color instances:
  BlockName already lerps those on a 0..1 light->dark mix, so a sheet built
  here crossfades with the page's theme for free instead of needing its own
  observer.

  Nothing in here touches the DOM or React — it is plain three.js geometry, and
  the caller owns disposal of everything the returned handles list.
*/

import * as THREE from 'three'

/** sheet thickness, in the hero world's units — a hair, so the paper has an edge */
export const PAPER_THICKNESS = 0.07

export interface PaperSheet {
  mesh: THREE.Mesh
  outline: THREE.LineSegments
  /** every geometry the sheet owns, for the caller's disposer list */
  geometries: THREE.BufferGeometry[]
}

/**
 * One folded sheet. `points` is the flat outline in the XY plane; `fold`
 * receives the extruded geometry and may rotate/translate it into place.
 */
export function foldedSheet(
  points: readonly (readonly [number, number])[],
  material: THREE.Material,
  outlineMaterial: THREE.Material,
  fold?: (geo: THREE.ExtrudeGeometry) => void,
  thickness = PAPER_THICKNESS,
): PaperSheet {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y)
  shape.closePath()

  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
  fold?.(geo)
  const edgeGeo = new THREE.EdgesGeometry(geo)

  return {
    mesh: new THREE.Mesh(geo, material),
    outline: new THREE.LineSegments(edgeGeo, outlineMaterial),
    geometries: [geo, edgeGeo],
  }
}

export interface PaperDart {
  group: THREE.Group
  /** 0 = not yet arrived, 1 = fully landed */
  setReveal(t: number): void
  dispose(): void
}

/** dihedral: the wings rise from the keel in a shallow V, as in BlockName's dart */
const FOLD = 0.36

/**
 * A miniature of the dart the hero flies, parked on the flight path with its
 * nose along the direction of travel. Nose points along +x, same as the big one.
 *
 * This replaced an earlier idea — radiating creased "petals" that unfolded at
 * each stop — which was abstract enough that it read as a crumpled scrap rather
 * than as anything. A waypoint has to be legible at a glance and mean something:
 * a small paper plane on a contrail says "the flight stopped here" with no
 * explaining. Keep any future marker at least that readable.
 */
export function createPaperDart(opts: {
  material: THREE.Material
  outlineMaterial: THREE.Material
  /** world-unit length of the dart, nose to tail */
  size?: number
}): PaperDart {
  const { material, outlineMaterial, size = 1 } = opts
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)
  const geometries: THREE.BufferGeometry[] = []

  const add = (
    points: readonly (readonly [number, number])[],
    fold: (geo: THREE.ExtrudeGeometry) => void,
  ) => {
    const sheet = foldedSheet(points, material, outlineMaterial, fold)
    body.add(sheet.mesh, sheet.outline)
    geometries.push(...sheet.geometries)
  }

  // wings: nose point, swept-back wingtip, root just off the fold line so the
  // two panels never share a face to z-fight over
  for (const side of [1, -1]) {
    add(
      [
        [2.7, side * 0.02],
        [-2.1, side * 1.75],
        [-1.85, side * 0.06],
      ],
      (geo) => geo.rotateX(side * FOLD),
    )
  }
  // the keel hangs under the fold — the spine you would pinch to throw it
  add(
    [
      [2.7, 0],
      [-2.1, 0],
      [-2.1, -0.72],
    ],
    (geo) => {
      geo.rotateX(Math.PI / 2)
      geo.translate(0, PAPER_THICKNESS / 2, 0)
    },
  )

  // the sheet above is drawn at roughly 4.8 units nose to tail
  const unit = size / 4.8

  return {
    group,
    setReveal(t: number) {
      const eased = t * t * (3 - 2 * t)
      group.scale.setScalar(unit * (0.2 + 0.8 * eased))
    },
    dispose() {
      for (const geo of geometries) geo.dispose()
    },
  }
}
