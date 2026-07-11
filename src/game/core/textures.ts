import * as THREE from 'three'

/*
  Runtime canvas textures. Nothing in this project ships image assets: every
  surface is drawn onto a 2D canvas at startup and wrapped as a THREE texture
  (the "nothing shipped, nothing copyrighted" rule). These are the shared
  primitives; each level module keeps its own make*Texture recipes and calls
  canvasTexture() with a seeded RNG so the paint is deterministic. Callers
  are responsible for handing the returned texture to their Disposer.
*/

export const canvasTexture = (
  size: [number, number],
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  repeat?: [number, number],
) => {
  const canvas = document.createElement('canvas')
  canvas.width = size[0]
  canvas.height = size[1]
  const ctx = canvas.getContext('2d')
  if (ctx) draw(ctx, size[0], size[1])
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeat[0], repeat[1])
  }
  tex.anisotropy = 4
  return tex
}

/** soft radial sprite, the workhorse for glows, halos and light pools */
export const makeGlowTexture = (inner: string, outer: string) =>
  canvasTexture([128, 128], (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2)
    g.addColorStop(0, inner)
    g.addColorStop(1, outer)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })
