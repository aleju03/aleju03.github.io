import * as THREE from 'three'

// Offline only: regenerate with node scripts/bake-vehicle-env.mjs.
const paintEnv = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sky: THREE.Color,
  horizon: THREE.Color,
  ground: THREE.Color,
  sunEl: number,
  sunPower: number,
) => {
  const css = (c: THREE.Color, a = 1) =>
    `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, css(sky))
  g.addColorStop(0.34, css(sky))
  g.addColorStop(0.47, css(horizon))
  g.addColorStop(0.53, css(horizon))
  g.addColorStop(0.72, css(ground))
  g.addColorStop(1, css(ground))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  if (sunPower > 0.01) {
    // the sun, wrapped three times so a blob straddling the seam is not cut
    // in half — the same trick the sky dome's haze blobs use
    const sy = h * (0.5 - Math.max(-0.2, sunEl) * 0.5)
    const r = w * 0.075
    ctx.globalCompositeOperation = 'lighter'
    for (const wrap of [-w, 0, w]) {
      const s = ctx.createRadialGradient(w * 0.3 + wrap, sy, 1, w * 0.3 + wrap, sy, r)
      s.addColorStop(0, `rgba(255,250,235,${0.95 * sunPower})`)
      s.addColorStop(0.35, `rgba(255,238,205,${0.35 * sunPower})`)
      s.addColorStop(1, 'rgba(255,230,190,0)')
      ctx.fillStyle = s
      ctx.fillRect(0, 0, w, h)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
}

const canvas = document.createElement('canvas')
canvas.width = 128
canvas.height = 64
paintEnv(canvas.getContext('2d')!, 128, 64, new THREE.Color('#8fb6dc'),
  new THREE.Color('#c9d8e4'), new THREE.Color('#5b6350'), 0.6, 1)
const source = new THREE.CanvasTexture(canvas)
source.mapping = THREE.EquirectangularReflectionMapping
source.colorSpace = THREE.SRGBColorSpace
const renderer = new THREE.WebGLRenderer()
const generator = new THREE.PMREMGenerator(renderer)
const target = generator.fromEquirectangular(source)
const pixels = new Uint16Array(target.width * target.height * 4)
renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels)
// The painted environment is LDR. Store linear bytes losslessly in PNG;
// no runtime convolution or HDR decoder is needed to sample the cubeUV atlas.
const output = document.createElement('canvas')
output.width = target.width
output.height = target.height
const ctx = output.getContext('2d')!
const data = ctx.createImageData(output.width, output.height)
for (let i = 0; i < pixels.length; i++) {
  data.data[i] = i % 4 === 3 ? 255 : Math.round(255 * THREE.DataUtils.fromHalfFloat(pixels[i]))
}
ctx.putImageData(data, 0, 0)
Object.assign(window, { __vehicleEnv: output.toDataURL('image/png') })
target.dispose()
generator.dispose()
source.dispose()
renderer.dispose()
