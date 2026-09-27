import * as THREE from 'three'
import { DEFAULT_LOOK, FUR_SWATCHES, PHONES_RED, type PlayerLook } from './look'
import { B, boneRestWorld, faceWindow } from './bodyShape'

/*
  The one material a body is drawn with, and the reason a repaint is free.

  `bodyShape.ts` stamps every vertex with an `aRole` code (which of the
  look's paints it wears: the body, the headgear, the headgear's detail)
  and an `aPart` pair (how much of it is bean and how much leg). This is an
  ordinary MeshStandardMaterial with three small injections, so the scene's
  lights, fog, shadows and tone map reach the body exactly as they reach
  everything else:

  - the diffuse colour is looked up in `uPal`, a per-body palette uniform.
    A look change is a few `Color.set()` calls into that array. Nothing
    about the material's *configuration* ever changes, so a repaint can
    never relink a shader (the root CLAUDE.md's boot-cost rule);
  - the face, the blink and the outfit are **painted**, not modelled. The
    vertex shader hands the fragment shader the vertex's bind-pose position
    (`vBind`, taken before skinning, so it rides the body however it bends),
    and the face panel, the two pill eyes, the five expressions and the
    five outfits (spots, stripes, overalls, the spacesuit, with its chest
    unit, patch and flag, and the beaver's fur, belly and paws), the scales
    on the beaver's tail and the helmet's gold visor are small 2D and 3D
    distance functions of it. A shape
    painted this way is crisp at any mesh resolution, blinks by scaling one
    uniform, and costs no geometry variant: `uFace`, `uLid` and `uCostume`
    are per body;
  - `uHideHead` is the first-person lens. The lens rides inside the head,
    so in the colour pass every vertex weighted to the head or an arm is
    slid, before skinning, onto the neck or the shoulder it hangs from: the
    skin folds shut into a smooth dome where the head was, and looking down
    you see a closed bean, your own chest and belly. Cutting the top off
    instead leaves the skin open, and from above an open skin is a hollow
    cup with the road visible down each leg. The headgear is discarded, and
    so is everything else that is not the bean: the beaver's ears, snout
    and tail and the headphones, which sit right beside the lens and would
    otherwise be the inside of an earcup filling the screen. The shadow pass
    draws with three's own depth material, which knows nothing of any of
    this, so the body still casts whole.

  Every body builds its own instance (the palette is per body) but they all
  share one compiled program: `customProgramCacheKey` names the injection,
  so the local player, every remote player, the town's pedestrians and the
  pause-sheet preview link it once between them.
*/

/** the face panel: cream, or ink when the eyes are painted light */
const FACE_LIGHT = '#f3ebdc'
const FACE_DARK = '#27232c'
const INK = '#1c1a22'
const CHEEK = '#ee9a8a'
const GLINT = '#ffffff'
const HAIR = '#7a4e33'
/** the spacesuit's cloth and the helmet's shell: a warm off-white, not
    paper, so it survives the look's grade without blowing out */
const SUIT_WHITE = '#e4e0d4'
/** the life-support pack: the suit's white gone to machinery */
const SUIT_GREY = '#9c9a94'
/** the beaver's belly, snout and inner ears */
const BEAVER_CREAM = '#ecd9b4'
/** the headset's plastic and leather: a hair off pure black, so the look's
    outline still finds its edge against a dark hat */
const PHONES_BLACK = '#222126'
/** the tail is the fur gone leathery: darker and greyer */
const TAIL_LEATHER = new THREE.Color('#3a302a')

/** the beaver's and the headset's paints, from the look: the fur (and the
    tail darkened from it), and the headset's metal in the colour its
    `phones` value names (look.ts's PHONES) */
const gearPaint = (look: PlayerLook, pal: THREE.Color[]) => {
  pal[11].set(FUR_SWATCHES[look.fur ?? 0] ?? FUR_SWATCHES[0])
  pal[13].copy(pal[11]).multiplyScalar(0.55).lerp(TAIL_LEATHER, 0.45)
  const phones = look.phones ?? 0
  pal[15].set(phones === 2 ? look.trim : phones === 3 ? look.accent : PHONES_RED)
}

export interface BodyMaterial {
  material: THREE.MeshStandardMaterial
  setLook: (look: PlayerLook) => void
  /** which of the five expressions the face wears */
  setFace: (face: number) => void
  /** how open the eyes are, 0 shut .. 1 open */
  setLid: (lid: number) => void
  /** true hides the whole body from the colour pass (not from shadows) */
  hideHead: (hidden: boolean) => void
  /** a multiplier on the face's own light, e.g. brighter at night */
  setGlow: (k: number) => void
}

const faceFor = (glow: string, out: THREE.Color) => {
  const c = new THREE.Color(glow)
  // a light eye colour on a cream panel is no face at all: flip the panel
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return out.set(lum > 0.35 ? FACE_DARK : FACE_LIGHT)
}

/** a bone's rest (bind) position as GLSL literal: the fold's pivots. The
    head and the shoulders are not rotated in the bind pose, so rest and
    bind positions agree for them */
const v3 = (bone: number) => {
  const p = boneRestWorld(bone, new THREE.Vector3())
  return `${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}`
}

export function makeBodyMaterial(look: PlayerLook = DEFAULT_LOOK): BodyMaterial {
  const pal = [
    FACE_LIGHT, look.shell, look.trim, look.accent, look.glow, INK, CHEEK, GLINT, HAIR, SUIT_WHITE, SUIT_GREY,
    FUR_SWATCHES[0], BEAVER_CREAM, FUR_SWATCHES[0], PHONES_BLACK, PHONES_RED,
  ].map((c) => new THREE.Color(c))
  faceFor(look.glow, pal[0])
  gearPaint(look, pal)
  const uniforms = {
    uPal: { value: pal },
    uGlowK: { value: 1 },
    uHideHead: { value: 0 },
    uFaceLift: { value: 0.35 },
    uGummy: { value: 0.03 },
    uFace: { value: 0 },
    uLid: { value: 1 },
    uCostume: { value: look.costume ?? 0 },
    uHat: { value: look.hat ?? 0 },
    // the face window of this body's build: half-width, half-height, centre
    uWin: { value: new THREE.Vector3() },
  }
  const setWin = (build: number) => {
    const w = faceWindow(build)
    uniforms.uWin.value.set(w.w, w.h, w.y)
  }
  setWin(look.build ?? 0)
  // soft vinyl: a broad sheen, a touch glossier than dough, the way the
  // beans this is drawn after read under a sun
  const material = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 })
  material.name = 'playerBody'
  material.onBeforeCompile = (shader) => {
    for (const k of Object.keys(uniforms) as Array<keyof typeof uniforms>) shader.uniforms[k] = uniforms[k]
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uHideHead;
attribute float aRole;
attribute vec2 aPart;
varying float vRole;
varying vec2 vPart;
varying vec3 vBind;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRole = aRole;
vPart = aPart;
vBind = position;
// the first-person fold: see below
if (uHideHead > 0.5) {
  float wHead = 0.0;
  float wArmL = 0.0;
  float wArmR = 0.0;
  for (int i = 0; i < 4; i++) {
    int b = int(skinIndex[i] + 0.5);
    float w = skinWeight[i];
    if (b == ${B.HEAD} || b == ${B.EYES} || b == ${B.POM}) wHead += w;
    if (b == ${B.UARM_L} || b == ${B.FARM_L} || b == ${B.HAND_L}) wArmL += w;
    if (b == ${B.UARM_R} || b == ${B.FARM_R} || b == ${B.HAND_R}) wArmR += w;
  }
  transformed = mix(transformed, vec3(${v3(B.HEAD)}), wHead);
  transformed = mix(transformed, vec3(${v3(B.UARM_L)}), wArmL);
  transformed = mix(transformed, vec3(${v3(B.UARM_R)}), wArmR);
}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uPal[16];
uniform float uGlowK;
uniform float uHideHead;
uniform float uFaceLift;
uniform float uGummy;
uniform float uFace;
uniform float uLid;
uniform float uCostume;
uniform float uHat;
uniform vec3 uWin;
varying float vRole;
varying vec2 vPart;
varying vec3 vBind;
// a pill standing upright: half-width r, straight part 2h tall
float bodyPill(vec2 q, float r, float h) {
  q.y = abs(q.y) - h;
  return length(vec2(q.x, max(q.y, 0.0))) - r;
}
float bodyEye(vec2 q, float side, float w, float h) {
  // q is relative to the eye's centre, design units; side is +1 on the
  // body's left (+x), -1 on its right; w and h the face window's half-sizes,
  // which every size here is a fraction of, so a wide bean has wide eyes
  float lid = max(uLid, 0.06);
  int kind = int(uFace + 0.5);
  float r = 0.12 * w;
  float hh = 0.2 * h;
  if (kind == 2) {
    // happy: an upturned arc, a closed smiling eye
    vec2 c = q - vec2(0.0, -0.1 * h);
    float d = abs(length(c) - 1.3 * r) - 0.45 * r;
    return max(d, -c.y + 0.004);
  }
  if (kind == 3) {
    // surprised: wide round eyes
    q.y /= lid;
    return length(q) - 1.45 * r;
  }
  q.y /= lid;
  float d = bodyPill(q, r, hh);
  if (kind == 1) d = max(d, q.y - 0.2 * hh); // sleepy: the lids half down
  if (kind == 4) d = max(d, dot(q, normalize(vec2(-side * 0.55, 1.0))) - 0.5 * hh); // determined
  return d;
}
float aaStep(float d) {
  float w = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(-w, w, d);
}
float boxD(vec2 q, vec2 b, float r) {
  vec2 d = abs(q) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
// a five-pointed star, near enough for a patch the size of a thumbnail
float starD(vec2 q, float r) {
  float a = atan(q.x, q.y);
  float k = 0.62 + 0.38 * cos(5.0 * a);
  return length(q) - r * k;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
int role = int(vRole + 0.5);
// under the first-person lens the headgear is left out of the colour pass
// (it still casts), and the face is not painted on a head that is not there
if (uHideHead > 0.5 && role != 1) discard;
vec3 bodyCol = uPal[role];
float facePanel = 0.0;
if (role == 1) {
  // the outfit, painted over the body in the detail colour
  int costume = int(uCostume + 0.5);
  float trimK = 0.0;
  float trunk = step(0.5, vPart.x);
  float legs = step(0.5, vPart.y);
  if (costume == 1) {
    // spots: one jittered dot per cell of a lattice in the bind pose
    vec3 p = vBind / 0.25;
    vec3 cell = floor(p);
    vec3 jit = fract(sin(vec3(dot(cell, vec3(12.9, 78.2, 37.7)), dot(cell, vec3(39.3, 11.1, 83.4)),
      dot(cell, vec3(73.1, 52.7, 9.2)))) * 43758.5) - 0.5;
    float d = length(fract(p) - 0.5 - jit * 0.3) - 0.24;
    trimK = aaStep(d * 0.25);
  } else if (costume == 2) {
    // hoops round the trunk, stopping under the face
    float band = abs(fract(vBind.y / 0.24) - 0.5) - 0.25;
    trimK = aaStep(band * 0.24) * trunk * step(vBind.y, 1.86);
  } else if (costume == 3) {
    // dungarees: the lower bean and the legs, a bib, two straps, buttons
    float pants = step(vBind.y, 1.26) * trunk + legs * step(0.2, vBind.y);
    float bib = step(0.0, vBind.z) * aaStep((abs(vBind.x) - 0.2) * 1.0) * step(vBind.y, 1.52) * trunk;
    float strap = aaStep(abs(abs(vBind.x) - 0.19) - 0.045) * step(vBind.y, 1.78) * trunk;
    trimK = max(max(pants, bib), strap);
    float btn = length(vec2(abs(vBind.x) - 0.19, vBind.y - 1.47)) - 0.028;
    bodyCol = mix(bodyCol, uPal[5], aaStep(btn) * step(0.0, vBind.z) * trunk);
    trimK *= 1.0 - aaStep(btn) * step(0.0, vBind.z);
  } else if (costume == 4) {
    /*
      The spacesuit. The cloth is the suit's white, whatever the body
      colour; the detail colour is the commander's stripes (a band round
      each upper arm and round the hips), the elbow and knee rings, the
      chunky cuffs of the gloves and boots and the rim of the mission patch;
      the body colour is the patch's field and the flag's canton, so the
      suit is still yours. Seams are soft darker lines, and the gloves and
      boots a grey the suit's white is dulled to. All in the bind pose, so
      it rides the body however it bends.
    */
    bodyCol = uPal[9];
    vec3 grey = uPal[9] * 0.56;
    float arms = (1.0 - trunk) * (1.0 - legs);
    // along the arm from the shoulder, in the A-pose it was drawn in
    vec2 sh = vec2(abs(vBind.x) - 0.58, vBind.y - 1.62);
    float t = dot(sh, vec2(0.7513, -0.6600));
    float glove = step(0.745, t) * arms;
    bodyCol = mix(bodyCol, grey, glove);
    float ring = aaStep(abs(t - 0.4) - 0.03) + aaStep(abs(t - 0.155) - 0.04) + aaStep(abs(t - 0.705) - 0.05);
    trimK = max(trimK, min(ring, 1.0) * arms);
    // the seam where each arm and leg leaves the bean: the fillet band
    float seam = aaStep(abs(vPart.x - 0.5) - 0.1);
    // the boots: grey soles and a chunky cuff, and a knee ring above them
    float boot = step(vBind.y, 0.17) * legs;
    bodyCol = mix(bodyCol, grey, boot);
    trimK = max(trimK, (aaStep(abs(vBind.y - 0.2) - 0.035) + aaStep(abs(vBind.y - 0.31) - 0.022)) * legs);
    // the trunk: a stripe round the hips, seams at the waist and down the back
    trimK = max(trimK, aaStep(abs(vBind.y - 0.62) - 0.035) * trunk);
    seam = max(seam, aaStep(abs(vBind.y - 1.2) - 0.008) * trunk);
    seam = max(seam, aaStep(abs(vBind.x) - 0.008) * step(vBind.z, -0.05) * trunk * step(0.4, vBind.y) * step(vBind.y, 1.9));
    bodyCol *= 1.0 - 0.18 * seam;
    float front = step(0.12, vBind.z) * trunk;
    // the chest unit: a grey box with a darker bezel and three lamps
    vec2 cb = vec2(vBind.x, vBind.y - 1.4);
    float box = aaStep(boxD(cb, vec2(0.2, 0.1), 0.03)) * front;
    float bezel = aaStep(abs(boxD(cb, vec2(0.2, 0.1), 0.03)) - 0.012) * front;
    bodyCol = mix(bodyCol, grey * 0.9, box);
    bodyCol = mix(bodyCol, uPal[5], bezel * 0.7);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float lamp = aaStep(length(cb - vec2(-0.1 + 0.1 * fi, 0.02)) - 0.026) * front;
      vec3 lc = i == 0 ? uPal[2] : (i == 1 ? uPal[6] : uPal[7]);
      bodyCol = mix(bodyCol, lc, lamp);
    }
    // a slot under the lamps
    bodyCol = mix(bodyCol, uPal[5], aaStep(boxD(cb - vec2(0.0, -0.05), vec2(0.12, 0.01), 0.008)) * front);
    // the mission patch on the left breast: the body colour inside a ring
    // of the detail colour, a white star on it
    vec2 pq = vec2(vBind.x - 0.34, vBind.y - 1.68);
    float patchD = length(pq) - 0.1;
    float onPatch = aaStep(patchD) * front;
    bodyCol = mix(bodyCol, uPal[1], onPatch);
    bodyCol = mix(bodyCol, uPal[2], aaStep(abs(patchD + 0.012) - 0.014) * front);
    bodyCol = mix(bodyCol, uPal[7], aaStep(starD(pq, 0.05)) * onPatch);
    // and a flag on the right: stripes of the detail colour and white,
    // with a canton of the body colour
    vec2 fq2 = vec2(vBind.x + 0.34, vBind.y - 1.68);
    float flag = aaStep(boxD(fq2, vec2(0.1, 0.065), 0.01)) * front;
    float stripes = step(0.5, fract((fq2.y + 0.065) / 0.043));
    vec3 flagCol = mix(uPal[7], uPal[2], stripes);
    flagCol = mix(flagCol, uPal[1], step(fq2.x, -0.01) * step(0.0, fq2.y));
    bodyCol = mix(bodyCol, flagCol, flag);
  } else if (costume == 5) {
    /*
      The beaver onesie: fur all over in the look's fur shade, whatever the
      body colour, a grain of darker tufts through it, a cream belly and
      paws gone dark. The tail, the ears and the snout are modelled (their
      own roles, below and in bodyShape's beaverPieces).
    */
    vec3 fur = uPal[11];
    bodyCol = fur;
    vec3 tp = vBind / vec3(0.09, 0.15, 0.09);
    vec3 cell = floor(tp);
    vec3 jit = fract(sin(vec3(dot(cell, vec3(12.9, 78.2, 37.7)), dot(cell, vec3(39.3, 11.1, 83.4)),
      dot(cell, vec3(73.1, 52.7, 9.2)))) * 43758.5) - 0.5;
    vec3 tq = fract(tp) - 0.5 - jit * 0.4;
    float tuft = aaStep((length(tq * vec3(1.0, 0.45, 1.0)) - 0.2) * 0.09);
    bodyCol *= 1.0 - 0.16 * tuft;
    // the paws: the mittens and the feet
    vec2 sh = vec2(abs(vBind.x) - 0.58, vBind.y - 1.62);
    float t = dot(sh, vec2(0.7513, -0.6600));
    float arms = (1.0 - trunk) * (1.0 - legs);
    float paw = max(step(0.745, t) * arms, step(vBind.y, 0.17) * legs);
    bodyCol = mix(bodyCol, fur * 0.5, paw);
    // the belly: a cream oval down the front of the trunk
    float bellyD = length(vec2(vBind.x / 0.36, (vBind.y - 1.1) / 0.46)) - 1.0;
    bodyCol = mix(bodyCol, uPal[12], aaStep(bellyD * 0.3) * step(0.0, vBind.z) * trunk);
  }
  bodyCol = mix(bodyCol, uPal[2], trimK);

  // the face: a light panel filling the window sunk into the front of the
  // bean (bodyShape's FaceWindow), and the eyes on it, both painted from
  // the bind position so they ride the head however it bends
  vec2 fq = vec2(vBind.x, vBind.y - uWin.z);
  float front = step(0.05, vBind.z) * trunk;
  float e = length(fq / uWin.xy);
  facePanel = aaStep((e - 0.9) * uWin.y) * front * (1.0 - uHideHead);
  vec3 panel = uPal[0];
  bool helmet = int(uHat + 0.5) == 8;
  if (helmet) {
    // under the helmet the face panel is the visor: gold glass with the
    // face still showing through it, and a sheen across the top
    panel = mix(uPal[0], vec3(0.5, 0.27, 0.035), 0.82);
    // darker toward the rim, like curved glass, and a sheen across the top
    panel *= 1.0 - 0.35 * smoothstep(0.5, 0.95, e);
    float sheen = aaStep(abs(dot(fq, vec2(0.55, 0.83)) - 0.55 * uWin.y) - 0.06 * uWin.y);
    panel = mix(panel, vec3(1.0, 0.86, 0.55), sheen * 0.6);
  }
  bodyCol = mix(bodyCol, panel, facePanel);
  float faceSide = sign(fq.x + 1e-5);
  vec2 eq = vec2(abs(fq.x) - 0.33 * uWin.x, fq.y - 0.08 * uWin.y);
  float eyeD = bodyEye(eq, faceSide, uWin.x, uWin.y);
  int kind = int(uFace + 0.5);
  if (kind == 3) eyeD = min(eyeD, length(vec2(fq.x, fq.y + 0.5 * uWin.y)) - 0.09 * uWin.x);
  float eye = aaStep(eyeD) * facePanel;
  bodyCol = mix(bodyCol, helmet ? uPal[4] * 0.6 + vec3(0.05, 0.03, 0.0) : uPal[4], eye);
  // and a wet glint high in each open eye
  if (kind != 2) {
    float g = length(eq - vec2(-0.035 * uWin.x * faceSide, 0.1 * uWin.y * max(uLid, 0.06))) - 0.035 * uWin.x;
    bodyCol = mix(bodyCol, mix(uPal[7], uPal[0], 0.15), aaStep(g) * eye * step(0.4, uLid));
  }
}
// the bandana is printed: dots of the detail colour on the cloth, which is
// what tells it from a beanie across a street
if (role == 3 && int(uHat + 0.5) == 5) {
  vec3 p = vBind / 0.13;
  float d = length(fract(p) - 0.5) - 0.28;
  bodyCol = mix(bodyCol, uPal[2], aaStep(d * 0.13));
}
// the beaver's tail: its scales, a crosshatch running diagonally across the
// paddle (s is along it, as bodyShape hangs it)
if (role == 13) {
  float s = dot(vBind, vec3(0.0, -0.722, -0.692));
  vec2 g = vec2(vBind.x + s, vBind.x - s) / 0.085;
  vec2 f = abs(fract(g) - 0.5);
  bodyCol = mix(bodyCol, bodyCol * 0.5, aaStep((min(f.x, f.y) - 0.09) * 0.085));
}
diffuseColor.rgb = bodyCol;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// a soft rim on the whole body, and a floor of light under the face: at dusk
// the scene's light falls away and a face with nothing of its own goes to a
// dark disc, which is the one part of this body that has to read. uFaceLift
// scales both; it is a uniform, so tuning it relinks nothing
float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.5);
totalEmissiveRadiance += diffuseColor.rgb * uFaceLift * (facePanel * (0.07 + 0.22 * rim) * uGlowK + 0.1 * rim);
// the gummy: a trace of light of its own, strongest in the core. Kept to a
// trace: any more and the body stops taking the scene's light
totalEmissiveRadiance += diffuseColor.rgb * uGummy * (0.55 + 0.45 * (1.0 - rim));`,
      )
  }
  material.customProgramCacheKey = () => 'playerBody-v7'

  return {
    material,
    setLook: (next) => {
      pal[1].set(next.shell)
      pal[2].set(next.trim)
      pal[3].set(next.accent)
      pal[4].set(next.glow)
      faceFor(next.glow, pal[0])
      gearPaint(next, pal)
      uniforms.uCostume.value = next.costume ?? 0
      uniforms.uHat.value = next.hat ?? 0
      setWin(next.build ?? 0)
    },
    setFace: (face) => {
      uniforms.uFace.value = face
    },
    setLid: (lid) => {
      uniforms.uLid.value = lid
    },
    hideHead: (hidden) => {
      uniforms.uHideHead.value = hidden ? 1 : 0
    },
    setGlow: (k) => {
      uniforms.uGlowK.value = k
    },
  }
}
