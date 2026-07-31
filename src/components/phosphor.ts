/*
  The wreck's screen: the picture on the CRT that stands up at the foot of the
  page, and the magnet you can hold against it.

  This is a plane parked on the tube's face inside BlockName's scene, not a
  surface of its own. That matters, because the first version of this was a
  full-bleed black band across the document with the same shader on it, and a
  black band is not a screen: it is a black band. A screen is a screen because
  it is bolted into a computer, sitting on a desk, at an angle, with a bezel
  around it. The model was already there.

  The picture is a 2D canvas rasterized once and uploaded as a texture. The
  fragment shader then does three things to it:

  - Warms it up. `uLit` is the machine act's own scrub, so as the wreck rises
    off the floor the raster paints itself down the tube and the phosphor comes
    up. Below that, the screen is dead apart from one blinking cursor, which is
    the tell this thing has been plugged in the whole time.
  - Bends it. Anyone who owned a tube did this once with a speaker: hold a
    magnet near the glass and the beam bends around it, so the picture bulges
    and splits into red, green and blue, because the three guns are deflected by
    different amounts. Here the magnet is your pointer, raycast onto the plane.
  - Degausses it. Real monitors shake the residual field out with one coil
    shudder at power-on, so this one does it at the moment the tube lights,
    which is also when the act plays its power cue.

  Two things worth keeping if this moves. The field is aspect-corrected:
  distances are `(uv - magnet) * vec2(aspect, 1)`, or a round magnet is an
  ellipse on a 4:3 face. And the magnet's strength is a spring rather than a
  lerp, so letting go overshoots and rings down; that is the whole difference
  between a warp filter and something with weight behind it.

  Copy on the tube is English only, like everything else in AlejOS: the desktop,
  its windows and the walk HUD are all in-fiction and none of them translate.
*/

import * as THREE from 'three'

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uMagnet;
uniform float uStrength;
uniform float uRadius;
uniform float uAspect;
uniform float uRing;
uniform float uRingT;
uniform float uTime;
uniform float uLit;
uniform vec4 uCursor;
uniform float uBlink;

const float PI = 3.14159265;

/* the glass is a section of a sphere, so straight lines aren't */
vec2 curve(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  c *= 1.0 + 0.022 * vec2(c.y * c.y, c.x * c.x);
  return c * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(vUv);

  /* the magnet: a gaussian well that both pulls the beam in and sweeps it
     around, which is why the picture twists rather than merely stretching */
  vec2 d = (uv - uMagnet) * vec2(uAspect, 1.0);
  float r2 = dot(d, d);
  float field = exp(-r2 / max(uRadius * uRadius, 1e-4));
  float len = sqrt(max(r2, 1e-9));
  vec2 dir = d / len;
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 off = uStrength * field * (dir * -0.9 + perp * 1.15) * 0.10;

  /* degauss: one ring travelling out from the centre of the tube */
  vec2 rc = (uv - 0.5) * vec2(uAspect, 1.0);
  float rd = length(rc);
  vec2 rdir = rd > 1e-5 ? rc / rd : vec2(0.0);
  off += rdir * uRing * sin(rd * 22.0 - uRingT * 20.0) * exp(-rd * 1.1) * 0.05;

  off.x /= uAspect;
  float bend = length(off);

  /* convergence error: the three guns land in different places */
  vec3 col;
  col.r = texture2D(uTex, uv + off * 1.12).r;
  col.g = texture2D(uTex, uv + off * 0.96).g;
  col.b = texture2D(uTex, uv + off * 0.80).b;

  /* phosphor bleed */
  vec3 glow =
      texture2D(uTex, uv + off + vec2(uTexel.x * 2.0, 0.0)).rgb
    + texture2D(uTex, uv + off - vec2(uTexel.x * 2.0, 0.0)).rgb
    + texture2D(uTex, uv + off + vec2(0.0, uTexel.y * 2.0)).rgb;
  col += glow * 0.12;

  /* the beam bunches where the field is strongest, so the warp is brighter */
  col *= 1.0 + field * uStrength * 0.9 + bend * 4.0;

  /* the raster paints itself down the tube as the machine stands up */
  float wipe = clamp(uLit * 1.3, 0.0, 1.0);
  col *= smoothstep(wipe, wipe - 0.09, 1.0 - uv.y) * (0.18 + 0.82 * uLit);

  /* the cursor is separate: it blinks on a dead screen too, which is the
     "still plugged in" tell the wreck has always had */
  if (uv.x > uCursor.x && uv.x < uCursor.z && uv.y > uCursor.y && uv.y < uCursor.w) {
    col += vec3(0.16, 0.62, 0.36) * uBlink * (0.35 + 0.65 * uLit);
  }

  /* scanlines, and the slow hum bar drifting up the picture */
  col *= 0.82 + 0.18 * sin(vUv.y * 260.0 * 2.0 * PI);
  float bar = fract(vUv.y - uTime * 0.06) - 0.5;
  col *= 1.0 + 0.05 * exp(-bar * bar * 36.0);

  /* dead glass is not black glass: a little body, and one diagonal glare so
     the tube still reads as a curved sheet with the machine switched off */
  vec3 base = vec3(0.018, 0.024, 0.022) * (1.0 + 1.6 * uLit);
  float glare = smoothstep(0.55, 1.0, vUv.y * 0.75 + vUv.x * 0.45) * 0.045;
  vec2 v = uv - 0.5;
  gl_FragColor = vec4((base + col) * (1.0 - 0.7 * dot(v, v)) + glare, 1.0);
}
`

export interface PhosphorScreen {
  /** the plane to park on the tube's face */
  readonly mesh: THREE.Mesh
  /** the machine act's scrub: 0 is a dead tube, 1 is a lit one */
  setLit(value: number): void
  /** magnet held against the glass at this point on the face, in 0..1 uv */
  pull(u: number, v: number): void
  release(): void
  degauss(): void
  /** re-rasterize the picture, since the display face lands after the first paint */
  repaint(): void
  frame(dt: number): void
  dispose(): void
}

/*
  The tube's contents, as a fixed character grid.

  This screen is roughly 150 CSS pixels wide where it sits on the page, so the
  budget is not "how much can I say" but "how many characters fit before this
  stops being text and becomes green noise". At ~8px per character that is
  about twenty columns, which is why these lines are this short. An earlier
  pass ran 44 columns of status output and rendered as illegible fuzz. Anything
  added here has to hold the grid.
*/
const COLUMNS = 20
const LINES: [string, string][] = [
  ['ALEJOS 5.2', '2003'],
  ['', ''],
  ['chat', 'ok'],
  ['arcade', 'ok'],
  ['front door', 'open'],
]
const PROMPT = 'C:\\>'

/** 4:3, and big enough that the text survives being mapped onto curved glass */
const TEX_W = 1024
const TEX_H = 768

/** where the block cursor ends up, in uv on the face: min corner, max corner */
const CURSOR = { x0: 0, y0: 0, x1: 0, y1: 0 }

function rasterize(ctx: CanvasRenderingContext2D) {
  const w = TEX_W
  const h = TEX_H
  ctx.fillStyle = '#040806'
  ctx.fillRect(0, 0, w, h)

  const pad = w * 0.07
  const inner = w - pad * 2
  // sized off the grid rather than picked: the type is as big as twenty
  // columns allow, which is the whole point of the column budget above
  ctx.font = `100px 'Geist Mono Variable', ui-monospace, monospace`
  const advance = ctx.measureText('0').width / 100
  const size = Math.min(inner / (COLUMNS * advance), h / ((LINES.length + 3) * 1.5))
  const lineH = size * 1.5
  ctx.font = `${size}px 'Geist Mono Variable', ui-monospace, monospace`
  ctx.textBaseline = 'alphabetic'
  ctx.shadowColor = 'rgba(110,231,183,0.6)'
  ctx.shadowBlur = size * 0.45

  const top = pad + size
  LINES.forEach(([left, right], i) => {
    // the header is the machine identifying itself, so it sits back a little
    ctx.fillStyle = i === 0 ? 'rgba(110,231,183,0.55)' : '#6ee7b7'
    const y = top + i * lineH
    ctx.textAlign = 'left'
    ctx.fillText(left, pad, y)
    if (right) {
      ctx.textAlign = 'right'
      ctx.fillText(right, w - pad, y)
    }
  })

  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(110,231,183,0.18)'
  ctx.fillRect(pad, top + lineH * 0.45, inner, Math.max(2, size * 0.03))

  ctx.textAlign = 'left'
  ctx.shadowBlur = size * 0.5
  ctx.fillStyle = '#6ee7b7'
  const promptY = top + (LINES.length + 0.8) * lineH
  ctx.fillText(PROMPT, pad, promptY)
  ctx.shadowBlur = 0

  const cx = pad + ctx.measureText(`${PROMPT} `).width
  const cw = size * advance
  CURSOR.x0 = cx / w
  CURSOR.x1 = (cx + cw) / w
  // uv runs up the face; canvas coordinates run down it
  CURSOR.y0 = 1 - promptY / h
  CURSOR.y1 = 1 - (promptY - size * 0.78) / h
}

/**
 * Builds the screen. `width` and `height` are the plane's size in the units the
 * wreck model is scaled to, so the caller sizes it off the real glass mesh.
 */
export function createPhosphorScreen(width: number, height: number): PhosphorScreen {
  const canvas = document.createElement('canvas')
  canvas.width = TEX_W
  canvas.height = TEX_H
  const ctx = canvas.getContext('2d')
  if (ctx) rasterize(ctx)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping

  const uniforms = {
    uTex: { value: texture },
    uTexel: { value: new THREE.Vector2(1 / TEX_W, 1 / TEX_H) },
    uMagnet: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
    uRadius: { value: 0.3 },
    uAspect: { value: width / height },
    uRing: { value: 0 },
    uRingT: { value: 0 },
    uTime: { value: 0 },
    uLit: { value: 0 },
    uCursor: { value: new THREE.Vector4(CURSOR.x0, CURSOR.y0, CURSOR.x1, CURSOR.y1) },
    uBlink: { value: 1 },
  }

  const geometry = new THREE.PlaneGeometry(width, height)
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    // the picture is emitted light, not a lit surface, and it sits a hair in
    // front of the glass it belongs to
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)

  // the field
  let aimU = 0.5
  let aimV = 0.5
  let strength = 0
  let strengthVel = 0
  let target = 0
  let ring = 0
  let ringT = 0
  let time = 0

  return {
    mesh,

    setLit(value) {
      uniforms.uLit.value = value
    },

    pull(u, v) {
      aimU = u
      aimV = v
      target = 1
    },

    release() {
      target = 0
    },

    degauss() {
      ring = 1
      ringT = 0
    },

    repaint() {
      if (!ctx) return
      rasterize(ctx)
      uniforms.uCursor.value.set(CURSOR.x0, CURSOR.y0, CURSOR.x1, CURSOR.y1)
      texture.needsUpdate = true
    },

    frame(dt) {
      time += dt
      uniforms.uTime.value = time

      // the magnet trails the pointer, so it has weight; a field welded to the
      // cursor reads as a filter rather than as something you are dragging
      const follow = 1 - Math.exp(-14 * dt)
      const magnet = uniforms.uMagnet.value
      magnet.x += (aimU - magnet.x) * follow
      magnet.y += (aimV - magnet.y) * follow

      strengthVel += (target - strength) * 210 * dt
      strengthVel *= Math.exp(-8.5 * dt)
      strength += strengthVel * dt
      uniforms.uStrength.value = strength

      if (ring > 0) {
        ringT += dt
        ring *= Math.exp(-3.2 * dt)
        if (ring < 0.002) ring = 0
        uniforms.uRing.value = ring
        uniforms.uRingT.value = ringT
      }

      // 1.4s period, on rather longer than off, like a real text cursor
      uniforms.uBlink.value = time % 1.4 < 0.85 ? 1 : 0
    },

    dispose() {
      geometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }
}
