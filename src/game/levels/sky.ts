import * as THREE from 'three'
import { HOUSE } from './houseWorld'
import { seeded } from '../core/rand'
import { canvasTexture, makeGlowTexture } from '../core/textures'
import { gfx } from '../world/quality'

/*
  Everything above the horizon, and the clock that drives it.

  A full day is DAY_LEN seconds, Minecraft-style. The sun and moon ride one
  orbit half a day apart; a painted day dome crossfades over the star dome, a
  shell of animated FBM clouds drifts over both (adapted from cortiz2894/
  stylized-components' SkyDome, MIT © Christian Ortiz), a twilight band flares
  at the horizon crossings, an amber haze hugs the skyline at night, and a
  red-eye flight strobes across on a slow circle. update() hands back the fog
  range, fog colour and hemisphere targets for the current moment, and the
  scene composes those with its own roam ramp. Boot lands mid-morning, so the
  world introduces itself in daylight — hang around and dusk comes to you.

  The clouds carry most of the weather: a cumulus deck under a low-frequency
  bank mask (so there are open patches and gathered banks rather than one
  even ceiling), a coverage that breathes over a couple of minutes, and a
  faster cirrus layer above it on the high tier. The other half of a sky that
  moves is not in this file at all — `world/birds.ts` owns the flocks, because
  they need the terrain height under them.

  This used to live in outsideWorld.ts alongside a hand-placed street, seven
  shell houses and three rings of fake towers painted on the horizon. The
  towers in particular were the honest trick of a closed world: you could see
  a city and never reach it. There is a real one out there now, so the fakes
  are gone and this module kept only the part that was never a lie — the sky.

  The sun carries the world's one moving shadow map: an ortho projection
  parked on the player. Its `castShadow` flag never changes after construction
  because doing that changes every lit material's shader program and used to
  make the front door a multi-second compilation boundary. Indoors and at
  night its uniform strength is zero and its hand-managed map sleeps; outside
  it refreshes only after meaningful camera travel or sun rotation. The
  house's baked interior maps follow the same no-auto-update rule.
*/

const DAY_LEN = 480 // seconds per full in-world day
const START_TOD = 0.36 // 0 midnight .. 0.5 noon; 0.36 = mid-morning

export interface SkyState {
  /** 0 night .. 1 day (smoothed on sun elevation) */
  day: number
  night: number
  /** peaks ~1 as the sun crosses the horizon, dawn and dusk */
  twilight: number
  /** sun elevation, -1..1 */
  sunEl: number
  /** 0 moon set .. 1 moon well up */
  moonUp: number
  /** 0 outside .. 1 fully inside the house shell */
  indoor: number
  fogNear: number
  fogFar: number
  fogColor: THREE.Color
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  /** multiply the roam hemisphere by this; >1 in daylight, eases indoors */
  dayBoost: number
}

export interface SkyHandles {
  update: (camPos: THREE.Vector3, todOverride?: number) => SkyState
  /** the world's one moving shadow caster. Its castShadow flag is stable;
      strength and explicit map updates handle indoor/night transitions */
  sun: THREE.DirectionalLight
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth01 = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------ canvas textures */

/*
  A dome texture must carry nothing sharp, and that is not a style note.

  A sphere's u coordinate collapses to a point at each pole, so the texture
  derivative there is effectively infinite and the GPU picks the coarsest mip
  it has — a 1x1 average of the whole image. The first cut of this texture had
  nine hundred one-pixel stars painted into it, and the consequence was a
  hard-edged, star-free, warm brown disc roughly forty-five degrees across
  pinned to the zenith: the average colour of the star field, stamped over the
  pole cap and the ring below it. It followed the camera because the zenith
  does.

  So the gradient stayed and the stars left. What remains is smooth enough
  that mipmaps are pointless and filtering is exact at any angle (they are
  switched off below either way), and the stars are real points now, which
  they should always have been — they twinkle, they never stretch at the pole,
  and they cost one draw call.
*/
const makeStarTexture = () =>
  canvasTexture([64, 512], (ctx, w, h) => {
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#04070f')
    sky.addColorStop(0.55, '#080e1c')
    sky.addColorStop(0.8, '#101a2c')
    sky.addColorStop(0.92, '#1d2437')
    sky.addColorStop(1, '#2a2530')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    // faint city glow bleeding up from the horizon band
    const glow = ctx.createLinearGradient(0, h * 0.74, 0, h)
    glow.addColorStop(0, 'rgba(220,150,80,0)')
    glow.addColorStop(1, 'rgba(220,150,80,0.16)')
    ctx.fillStyle = glow
    ctx.fillRect(0, h * 0.74, w, h * 0.26)
  })

/** one soft round dot, so a star is a disc rather than a hard square */
const makeStarSprite = () =>
  canvasTexture([32, 32], (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.75)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

const makeDayTexture = () =>
  canvasTexture([1024, 512], (ctx, w, h) => {
    const rand = seeded(0xdaf)
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#6f9fc9')
    sky.addColorStop(0.5, '#93b8d6')
    sky.addColorStop(0.78, '#bad2e0')
    sky.addColorStop(0.9, '#d9e6ea')
    sky.addColorStop(1, '#e4e9e2')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    // a faint painted haze layer high up; the real clouds are the animated
    // FBM shell in front of this dome, so these stay whisper-quiet. Every
    // blob is stamped three times, once per horizontal wrap — the texture
    // meets itself on the dome's seam meridian, and a blob cut at the canvas
    // edge used to draw that seam down the sky as a hard vertical line
    for (let i = 0; i < 7; i++) {
      const cx = rand() * w
      const cy = h * (0.1 + rand() * 0.3)
      const rx = 60 + rand() * 110
      for (let p = 0; p < 4; p++) {
        const ox = (rand() - 0.5) * rx * 1.4
        const oy = (rand() - 0.5) * rx * 0.3
        const rr = rx * (0.5 + rand() * 0.5)
        const alpha = 0.05 + rand() * 0.07
        for (const wrap of [-w, 0, w]) {
          const g = ctx.createRadialGradient(
            cx + wrap + ox, cy + oy, 2, cx + wrap, cy, rr)
          g.addColorStop(0, `rgba(244,248,250,${alpha})`)
          g.addColorStop(1, 'rgba(244,248,250,0)')
          ctx.fillStyle = g
          ctx.fillRect(0, 0, w, h)
        }
      }
    }
  })

const makeTwilightTexture = () =>
  canvasTexture([64, 128], (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(255,150,80,0)')
    g.addColorStop(0.62, 'rgba(255,145,72,0.18)')
    g.addColorStop(0.88, 'rgba(255,170,96,0.5)')
    g.addColorStop(1, 'rgba(255,196,120,0.62)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

/* ---------------------------------------------------------------- build */

interface BuildOpts {
  parent: THREE.Object3D
  trackTexture: (t: THREE.Texture) => void
  trackDisposable: (d: { dispose: () => void }) => void
}

export function buildSky(opts: BuildOpts): SkyHandles {
  const { parent, trackTexture, trackDisposable } = opts

  const track = (t: THREE.Texture) => {
    trackTexture(t)
    trackDisposable(t)
    return t
  }
  const mat = <T extends THREE.Material>(m: T): T => {
    trackDisposable(m)
    return m
  }
  /** dome textures are smooth gradients viewed at one fixed distance, so a mip
      chain buys nothing and costs the pole (see makeStarTexture's header) */
  const domeTex = (t: THREE.Texture) => {
    t.generateMipmaps = false
    t.minFilter = THREE.LinearFilter
    return track(t)
  }

  /*
    Everything that stands in for "infinitely far away" hangs off this group,
    and the group is parked on the camera every frame. It has to be marked
    dynamic: the scene freezes matrixAutoUpdate on everything that isn't, and
    a frozen sky stays where it was built — which, in a world you can walk out
    of, means walking out of your own sky.
  */
  const dome = new THREE.Group()
  dome.userData.dynamic = true
  parent.add(dome)

  /*
    Distant terrain is completely `fogColor` by the time it reaches the edge
    of the streamed ring. If the dome behind it is still textured there, that
    otherwise invisible edge reads as a huge flat blue slab across the world.
    Make both painted domes meet the live fog colour at and below the horizon,
    then release the blend gradually through the lowest eight degrees of sky.
    This stays in the existing dome programs instead of adding a full-width
    transparent haze draw.
  */
  const horizonFogU = { value: new THREE.Color('#0d1220') }
  const blendHorizon = <T extends THREE.MeshBasicMaterial>(material: T, key: string): T => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHorizonFog = horizonFogU
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n varying vec3 vSkyDir;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vSkyDir = position;')
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\n varying vec3 vSkyDir;\n uniform vec3 uHorizonFog;',
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
           float horizonFogK = 1.0 - smoothstep(0.0, 0.14, normalize(vSkyDir).y);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, uHorizonFog, horizonFogK);`,
        )
    }
    material.customProgramCacheKey = () => key
    return material
  }

  const starMat = mat(blendHorizon(new THREE.MeshBasicMaterial({
    map: domeTex(makeStarTexture()), side: THREE.BackSide, fog: false, depthWrite: false,
  }), 'sky-star-dome-horizon'))
  const starDome = new THREE.Mesh(new THREE.SphereGeometry(430, 24, 20), starMat)
  starDome.renderOrder = -10
  starDome.frustumCulled = false
  dome.add(starDome)

  // real stars, on a shell just inside the dome. Points never stretch at the
  // pole and cost one draw call, which is the whole reason they left the
  // texture; the phase attribute gives each one its own slow twinkle.
  const STARS = 1300
  const starPos = new Float32Array(STARS * 3)
  const starCol = new Float32Array(STARS * 3)
  const starPhase = new Float32Array(STARS)
  const starSize = new Float32Array(STARS)
  {
    const rand = seeded(0x57a2)
    for (let i = 0; i < STARS; i++) {
      // cosine-distributed in elevation, kept above a shallow horizon so the
      // shell's own bottom edge is never something you can look at
      const el = Math.asin(rand() * 0.98 - 0.08)
      const az = rand() * Math.PI * 2
      const r = 418
      starPos[i * 3] = Math.cos(el) * Math.cos(az) * r
      starPos[i * 3 + 1] = Math.sin(el) * r
      starPos[i * 3 + 2] = Math.cos(el) * Math.sin(az) * r
      const warm = rand() < 0.18
      const b = 0.45 + rand() * 0.55
      starCol[i * 3] = b * (warm ? 1 : 0.88)
      starCol[i * 3 + 1] = b * (warm ? 0.96 : 0.93)
      starCol[i * 3 + 2] = b * (warm ? 0.86 : 1)
      starPhase[i] = rand() * Math.PI * 2
      starSize[i] = rand() < 0.06 ? 5.5 + rand() * 3 : 2 + rand() * 2
    }
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3))
  starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1))
  trackDisposable(starGeo)
  const starTwinkle = { value: 0 }
  const starFade = { value: 1 }
  const starsMat = mat(new THREE.PointsMaterial({
    map: track(makeStarSprite()),
    vertexColors: true, transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: false, size: 3,
  }))
  starsMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTwinkle = starTwinkle
    shader.uniforms.uFade = starFade
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTwinkle;
         uniform float uFade;
         attribute float aPhase;
         attribute float aSize;
         varying float vTw;`,
      )
      .replace(
        'gl_PointSize = size;',
        `gl_PointSize = aSize;
         vTw = (0.55 + 0.45 * sin(uTwinkle * 1.7 + aPhase)) * uFade;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n varying float vTw;')
      .replace(
        '#include <premultiplied_alpha_fragment>',
        '#include <premultiplied_alpha_fragment>\n gl_FragColor.rgb *= vTw;',
      )
  }
  starsMat.customProgramCacheKey = () => 'sky-stars'
  const stars = new THREE.Points(starGeo, starsMat)
  stars.renderOrder = -9.9
  stars.frustumCulled = false
  dome.add(stars)

  const dayMat = mat(blendHorizon(new THREE.MeshBasicMaterial({
    map: domeTex(makeDayTexture()), side: THREE.BackSide, fog: false,
    depthWrite: false, transparent: true, opacity: 0,
  }), 'sky-day-dome-horizon'))
  const dayDome = new THREE.Mesh(new THREE.SphereGeometry(424, 24, 20), dayMat)
  dayDome.renderOrder = -9.7
  dayDome.frustumCulled = false
  dome.add(dayDome)

  /*
    The clouds: one shell of animated 3D value-noise FBM, computed in the
    fragment from the view direction. Sampling on the unit sphere rather than
    a planar projection is what keeps the shapes from smearing out at the
    horizon; the sun-facing shading is a second, offset FBM sample — where the
    density falls toward the sun the cloud face is lit, where it rises it is
    in its own shadow. Adapted from the SkyDome of cortiz2894/
    stylized-components (MIT © Christian Ortiz), cut down from eight octaves
    to three per sample: this runs on a cold iGPU over a third of the screen.

    Injected over a MeshBasicMaterial rather than written as a ShaderMaterial
    so tone mapping still applies — hand-rolled clouds above an ACES scene
    otherwise read as pasted-on paper cutouts.

    The first cut of this was technically a cloud layer and practically an
    empty sky, for three reasons worth keeping written down:

    - the coverage threshold sat at 0.55 against a three-octave FBM that
      averages 0.5 and rarely passes 0.75, so `cov` almost never reached 1
      and every cloud was a 30%-alpha smudge. The deck is cut lower and
      ramped harder now: fewer, denser, opaque-cored clouds beat a uniform
      haze of them.
    - the shell faded out below 9° of elevation, which is exactly where a
      walker looks. Clouds now run down to the horizon, where they take the
      fog's own colour (uHaze) so a bank at the skyline sits in the same air
      as the terrain in front of it — the fade existed because they did not.
    - it was one uniform deck. There is a low-frequency weather mask over it
      now (banks and open blue, drifting on their own slow clock) and a high
      cirrus layer above it on the high tier, drifting three times faster.
      Two speeds is what reads as depth on a dome that cannot parallax.

    The noise cells are squashed in y before sampling, which flattens the
    puffs into something layer-shaped and packs them toward the horizon, so
    the deck recedes instead of tiling at one apparent size overhead.
  */
  const cloudU = {
    uCloudTime: { value: 0 },
    uCover: { value: 0.53 },
    uCloudOpacity: { value: 0.85 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCloudLit: { value: new THREE.Color('#ffffff') },
    uCloudShade: { value: new THREE.Color('#b7c4d4') },
    uHaze: { value: new THREE.Color('#a9c0d4') },
  }
  const cloudMat = mat(new THREE.MeshBasicMaterial({
    side: THREE.BackSide, transparent: true, fog: false, depthWrite: false,
  }))
  cloudMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cloudU)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vDir = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vDir;
         uniform float uCloudTime;
         uniform float uCover;
         uniform float uCloudOpacity;
         uniform vec3 uSunDir;
         uniform vec3 uCloudLit;
         uniform vec3 uCloudShade;
         uniform vec3 uHaze;
         float cHash(vec3 p) {
           p = fract(p * vec3(127.1, 311.7, 74.7));
           p += dot(p, p.yzx + 19.19);
           return fract((p.x + p.y) * p.z);
         }
         float cNoise(vec3 p) {
           vec3 i = floor(p);
           vec3 f = fract(p);
           vec3 u = f * f * (3.0 - 2.0 * f);
           return mix(
             mix(mix(cHash(i), cHash(i + vec3(1,0,0)), u.x),
                 mix(cHash(i + vec3(0,1,0)), cHash(i + vec3(1,1,0)), u.x), u.y),
             mix(mix(cHash(i + vec3(0,0,1)), cHash(i + vec3(1,0,1)), u.x),
                 mix(cHash(i + vec3(0,1,1)), cHash(i + vec3(1,1,1)), u.x), u.y),
             u.z);
         }
         float cFbm(vec3 p) {
           float v = 0.0;
           float n = 0.0;
           v += 0.5 * cNoise(p); n += 0.5;
           p = p * 2.1 + vec3(1.7, 9.2, 5.4) + uCloudTime * 0.014;
           v += 0.25 * cNoise(p); n += 0.25;
           p = p * 2.1 + vec3(8.3, 2.8, 4.1);
           v += 0.125 * cNoise(p); n += 0.125;
           #ifdef RICH_SKY
             // the octave that gives a cloud a ragged rim instead of a
             // smoothstep silhouette; the lean tier goes without
             p = p * 2.3 + vec3(3.1, 6.7, 1.9);
             v += 0.0625 * cNoise(p); n += 0.0625;
           #endif
           return v / n;
         }`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
         {
           vec3 dir = normalize(vDir);
           // the deck runs all the way down to the skyline — the ground is in
           // front of it there, and uHaze below puts it in the same air. The
           // fade is only the last degree or so, where the dome's own far side
           // would otherwise show through under the fog line
           float horizon = smoothstep(0.0, 0.022, dir.y);
           if (horizon < 0.004) {
             gl_FragColor.a = 0.0;
           } else {
             vec3 flat3 = vec3(dir.x, dir.y * 0.42, dir.z);
             vec3 p = flat3 * 5.4;
             p.xz += vec2(0.82, 0.57) * (uCloudTime * 0.011);
             // the weather: banks and open blue, on their own slow drift
             float bank = cNoise(flat3 * 1.1 + vec3(uCloudTime * 0.004, 0.0, 0.0));
             float cover = uCover - (bank - 0.5) * 0.24;
             float f = cFbm(p);
             float cov = smoothstep(cover, cover + 0.09, f);
             float f2 = cFbm(p + normalize(uSunDir) * 0.3);
             float litK = clamp(0.5 + (f - f2) * 7.5, 0.0, 1.0);
             vec3 col = mix(uCloudShade, uCloudLit, litK);
             // the silver lining: the edge of a cloud in front of the sun
             float rim = pow(max(dot(dir, normalize(uSunDir)), 0.0), 7.0);
             col += uCloudLit * rim * 0.5 * litK;
             float a = cov;
             #ifdef RICH_SKY
               // the high layer: thinner, faster, and always lit — it is
               // above the deck, so it never sits in the deck's shadow
               vec3 q = vec3(dir.x, dir.y * 0.22, dir.z) * 5.6
                        + vec3(uCloudTime * 0.032, 0.0, uCloudTime * 0.021);
               float wisp = cNoise(q) * 0.66 + cNoise(q * 2.4) * 0.34;
               float aw = smoothstep(0.5, 0.78, wisp) * 0.5 * (1.0 - cov);
               a = cov + aw;
               col = mix(mix(uCloudShade, uCloudLit, 0.9), col, cov / max(a, 0.001));
             #endif
             // a cloud at the skyline is seen through the same air as the
             // ground under it; without this it floats in front of the fog.
             // Not all the way to the fog colour — a bank on the horizon has
             // to keep enough of itself to still read as a cloud
             col = mix(uHaze, col, 0.3 + 0.7 * smoothstep(0.0, 0.26, dir.y));
             gl_FragColor.rgb = col;
             gl_FragColor.a = clamp(a, 0.0, 1.0) * horizon * uCloudOpacity;
           }
         }`,
      )
    if (gfx.richSky) shader.fragmentShader = '#define RICH_SKY\n' + shader.fragmentShader
  }
  cloudMat.customProgramCacheKey = () => `sky-clouds-${gfx.richSky ? 'r' : 'p'}`
  // 64x40 rather than the 20x12 the other domes get, and the reason is the
  // noise: `vDir` is the *interpolated vertex position*, so across a coarse
  // triangle the view direction is a chord instead of an arc and every cloud
  // cell is sheared to the facet it lands on. At the old low frequency that
  // was invisible; at this one it drew straight-edged rectangles of cloud
  // across the sky. Five thousand triangles on a dome that never moves is
  // nothing — the fill cost this shader is actually made of is unchanged.
  const cloudDome = new THREE.Mesh(new THREE.SphereGeometry(412, 64, 40), cloudMat)
  cloudDome.renderOrder = -9.5
  cloudDome.frustumCulled = false
  dome.add(cloudDome)

  const twilightMat = mat(new THREE.MeshBasicMaterial({
    map: domeTex(makeTwilightTexture()), side: THREE.BackSide, fog: false,
    depthWrite: false, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending,
  }))
  const twilightBand = new THREE.Mesh(
    new THREE.CylinderGeometry(400, 400, 88, 48, 1, true), twilightMat)
  twilightBand.position.y = 26
  twilightBand.renderOrder = -9.6
  twilightBand.frustumCulled = false
  dome.add(twilightBand)

  // sun: disc + warm halo riding one orbit; the moon rides it half a day out
  const sun = new THREE.Group()
  // the disc's colour is deliberately over 1: ACES rolls it off into a blown
  // white core with warm edges, which is what "looking at the sun" means. At
  // plain #fff3c8 it tone-mapped down to a matte beige sticker
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(16, 24),
    mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 2.5, 1.9), fog: false })),
  )
  const sunHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(98, 98),
    mat(new THREE.MeshBasicMaterial({
      map: track(makeGlowTexture('rgba(255,236,180,0.9)', 'rgba(255,210,140,0)')),
      transparent: true, opacity: 0.7, fog: false,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })),
  )
  sunHalo.position.z = -0.5
  sun.add(sunHalo, sunDisc)
  // renderOrder must live on the meshes, not the group: a group's renderOrder
  // becomes a *groupOrder* that outranks every renderOrder comparison, which
  // is how the sun spent a while being painted behind the day dome. Between
  // the day dome (-9.7) and the clouds (-9.5): a low sun shines through the
  // sky gradient but an overcast drift still crosses its face.
  sunHalo.renderOrder = -9.62
  sunDisc.renderOrder = -9.61
  sunDisc.frustumCulled = sunHalo.frustumCulled = false
  sun.userData.dynamic = true
  dome.add(sun)

  const moon = new THREE.Group()
  const moonDisc = new THREE.Mesh(
    new THREE.CircleGeometry(11.6, 24),
    mat(new THREE.MeshBasicMaterial({ color: '#f2e9c9', fog: false })),
  )
  const moonHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 64),
    mat(new THREE.MeshBasicMaterial({
      map: track(makeGlowTexture('rgba(238,232,205,0.85)', 'rgba(238,232,205,0)')),
      transparent: true, opacity: 0.55, fog: false,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })),
  )
  moonHalo.position.z = -0.5
  moon.add(moonHalo, moonDisc)
  moonHalo.renderOrder = -9.62
  moonDisc.renderOrder = -9.61
  moonDisc.frustumCulled = moonHalo.frustumCulled = false
  moon.userData.dynamic = true
  dome.add(moon)

  // amber glow hugging the horizon — the city's light bouncing off the air,
  // and now there is a real city under it for that to be true of
  const hazeMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeGlowTexture('rgba(230,150,70,0.35)', 'rgba(230,150,70,0)')),
    transparent: true, fog: false, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.BackSide,
  }))
  const haze = new THREE.Mesh(new THREE.CylinderGeometry(300, 300, 52, 48, 1, true), hazeMat)
  haze.position.y = 12
  haze.renderOrder = -9
  haze.frustumCulled = false
  dome.add(haze)

  // the red-eye flight: one strobing spark on a slow, high circle
  const planeMat = mat(new THREE.MeshBasicMaterial({
    map: track(makeGlowTexture('rgba(255,244,235,0.95)', 'rgba(255,180,150,0)')),
    transparent: true, opacity: 0, fog: false,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  const redEye = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), planeMat)
  redEye.renderOrder = -8.9
  redEye.frustumCulled = false
  redEye.userData.dynamic = true
  parent.add(redEye)

  const sunLight = new THREE.DirectionalLight('#fff2dc', 0)
  sunLight.target.position.set(0, 0, 10)
  sunLight.userData.dynamic = true
  // the live outdoor shadow: one modest map following the player. The box
  // reaches a chunk or so in every direction — past that, daylight fog has
  // eaten enough contrast that a missing shadow is cheaper than a bigger map
  sunLight.castShadow = true
  sunLight.shadow.mapSize.set(gfx.shadowMap, gfx.shadowMap)
  sunLight.shadow.bias = -0.0004
  sunLight.shadow.normalBias = 0.5
  // Keep the shadow in every material's program from the first compile onward.
  // Its map is refreshed explicitly below; toggling castShadow at the house
  // threshold invalidates the lighting program cache and is catastrophically
  // expensive on a cold driver.
  sunLight.shadow.autoUpdate = false
  const sunCam = sunLight.shadow.camera
  sunCam.left = -55
  sunCam.right = 55
  sunCam.top = 55
  sunCam.bottom = -55
  sunCam.near = 1
  sunCam.far = 220
  // without this the camera keeps the constructor's ±5 box and the "shadow"
  // is a five-unit stamp lost somewhere up the light's axis
  sunCam.updateProjectionMatrix()
  parent.add(sunLight, sunLight.target)

  /* --------------------------------------------------------------- update */

  const state: SkyState = {
    day: 0, night: 1, twilight: 0, sunEl: -1, moonUp: 1, indoor: 1,
    fogNear: 26, fogFar: 176,
    fogColor: new THREE.Color('#0d1220'),
    hemiSky: new THREE.Color('#66748f'),
    hemiGround: new THREE.Color('#2a231a'),
    dayBoost: 1,
  }
  // night fog used to be a near-black brown, which turned every silhouette
  // past the fog line into a hole punched in the sky. A dark slate blue reads
  // as air instead, and matches the band the star dome paints at the horizon
  const FOG_NIGHT = new THREE.Color('#0d1220')
  const FOG_DAY = new THREE.Color('#a9c0d4')
  const FOG_DUSK = new THREE.Color('#a56a3d')
  const HEMI_SKY_NIGHT = new THREE.Color('#66748f')
  const HEMI_SKY_DAY = new THREE.Color('#cfe2f2')
  const HEMI_GROUND_NIGHT = new THREE.Color('#2a231a')
  const HEMI_GROUND_DAY = new THREE.Color('#5f6a52')
  const SUN_LOW = new THREE.Color('#ffb066')
  const SUN_HIGH = new THREE.Color('#fff2dc')
  const DOME_DUSK = new THREE.Color('#ffb87a')
  const CLOUD_LIT_DAY = new THREE.Color('#ffffff')
  const CLOUD_LIT_DUSK = new THREE.Color('#ffc493')
  const CLOUD_LIT_NIGHT = new THREE.Color('#39435c')
  const CLOUD_SHADE_DAY = new THREE.Color('#93a8c4')
  const CLOUD_SHADE_DUSK = new THREE.Color('#b57e59')
  const CLOUD_SHADE_NIGHT = new THREE.Color('#1a2233')

  const birth = performance.now()
  const shadowAnchor = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN)
  let shadowAngle = Number.NaN
  const SHADOW_TRAVEL = 10
  const SHADOW_TURN = THREE.MathUtils.degToRad(7)
  /** how far past the house shell the daylight comes back up; see `indoor` */
  const INDOOR_FADE = 1.6

  const update = (camPos: THREE.Vector3, todOverride?: number) => {
    const now = performance.now()
    const tod = todOverride !== undefined
      ? todOverride
      : (START_TOD + (now - birth) / (1000 * DAY_LEN)) % 1
    const a = (tod - 0.25) * Math.PI * 2
    const sunEl = Math.sin(a)
    const moonEl = -sunEl
    const day = smooth01((sunEl + 0.06) / 0.28)
    const night = 1 - day
    const twilight = Math.max(0, 1 - Math.abs(sunEl) / 0.26)
    const moonUp = smooth01(moonEl / 0.3)
    /*
      Is the camera in the house, damping the sun and the daylight ambience so
      noon cannot torch the interior.

      This used to ramp on how deep inside the shell the camera was:
      `smooth01(min(dxIn, dzIn) / 1.1)`, zero at the wall and one a metre in.
      That reads as a doorway transition and it is one, but the perimeter it
      measures from is the whole rectangle, and most of that perimeter is not a
      door. It is a wall with a window in it.

      So walking up to any window ran the ramp backwards. Measured at noon,
      over the last 0.8 units of the approach: the sun goes from 0.239 to 1.670
      (seven times), the hemisphere boost from 1.63 to 2.83, and the sun's
      shadows snap from off to fully on. These are global, so what changes is
      not the light in the room, it is the light on the lawn, and the visible
      bug is the ground outside shifting shade on every frame the player moves
      and holding still the moment they stop.

      Put the ramp outside the shell instead. Anywhere within the rectangle is
      simply indoors, and the fade happens over the doorstep, where the player
      really is leaving. The front door sits on `HOUSE.minZ` with about a
      unit and a half of path beyond it, so the transition still completes
      before they are properly out in the yard.
    */
    const dxIn = Math.min(camPos.x - HOUSE.minX, HOUSE.maxX - camPos.x)
    const dzIn = Math.min(camPos.z - HOUSE.minZ, HOUSE.maxZ - camPos.z)
    const indoor = smooth01(1 + Math.min(dxIn, dzIn) / INDOOR_FADE)

    state.day = day
    state.night = night
    state.twilight = twilight
    state.sunEl = sunEl
    state.moonUp = moonUp
    state.indoor = indoor
    // the fog has to end before the streamed ring does. The world loads four
    // chunks out, and the nearest point of that boundary is never closer than
    // 256 units whatever the player's position inside their own chunk, so a
    // daylight far plane of 240 hides the edge with room to spare
    state.fogNear = 26 + day * 30
    state.fogFar = 176 + day * 64
    state.fogColor.lerpColors(FOG_NIGHT, FOG_DAY, day)
    // golden hour used to be a 45% nudge and read as ordinary grey haze; the
    // whole point of a low sun is that the air itself goes amber
    if (twilight > 0.001) state.fogColor.lerp(FOG_DUSK, twilight * 0.72)
    horizonFogU.value.copy(state.fogColor)
    state.hemiSky.lerpColors(HEMI_SKY_NIGHT, HEMI_SKY_DAY, day)
    state.hemiGround.lerpColors(HEMI_GROUND_NIGHT, HEMI_GROUND_DAY, day)
    state.dayBoost = 1 + 2.1 * day * (1 - 0.7 * indoor)

    // the domes and the celestial bodies ride with the camera: the world is
    // endless now, so a sky pinned to the origin would slide off it — and it
    // rides in y as well, because a mountain 300 units up would otherwise put
    // the horizon band under the player's feet
    dome.position.copy(camPos)
    starTwinkle.value = (now - birth) / 1000
    starFade.value = night * night

    // sun and moon ride inside the camera-parked dome now, so their positions
    // are offsets, not world coordinates; lookAt still wants world space
    sun.visible = sunEl > -0.14
    if (sun.visible) {
      sun.position.set(Math.cos(a) * 380, sunEl * 380, 80)
      sun.lookAt(camPos.x, camPos.y, camPos.z + 8)
    }
    moon.visible = moonEl > -0.14
    if (moon.visible) {
      moon.position.set(-Math.cos(a) * 380, moonEl * 380, 80)
      moon.lookAt(camPos.x, camPos.y, camPos.z + 8)
    }
    sunLight.position.set(
      camPos.x + Math.cos(a) * 60, camPos.y + Math.max(0.02, sunEl) * 60, camPos.z + 12.6)
    sunLight.target.position.set(camPos.x, camPos.y, camPos.z + 10)
    // the twilight term keeps a low sun burning: on the bare elevation curve
    // alone, golden hour was the greyest moment of the day instead of the one
    // everything else in the scene is warmest at
    sunLight.intensity =
      (2.3 * Math.pow(Math.max(0, sunEl), 0.65) + twilight * 0.9 * (sunEl > 0 ? 1 : 0.25)) *
      (1 - 0.88 * indoor)
    sunLight.color.lerpColors(SUN_LOW, SUN_HIGH, clamp01(sunEl * 1.6))
    // `castShadow` stays true forever so the door cannot change shader
    // variants. Fade the uniform contribution instead, and only ask for a map
    // refresh after enough travel / solar motion to matter. A grazing sun is
    // faded too: a near-horizontal ortho box smears one texel row across half
    // the world, which reads worse than no shadow at all.
    const shadowStrength =
      smooth01((sunEl - 0.04) / 0.1) * (1 - smooth01((indoor - 0.72) / 0.18))
    sunLight.shadow.intensity = shadowStrength
    if (shadowStrength > 0.001) {
      const moved = !Number.isFinite(shadowAnchor.x) || shadowAnchor.distanceTo(camPos) >= SHADOW_TRAVEL
      const turned =
        !Number.isFinite(shadowAngle) ||
        Math.abs(Math.atan2(Math.sin(a - shadowAngle), Math.cos(a - shadowAngle))) >= SHADOW_TURN
      if (moved || turned) {
        sunLight.shadow.needsUpdate = true
        shadowAnchor.copy(camPos)
        shadowAngle = a
      }
    }

    dayMat.opacity = day
    // the whole painted sky leans amber as the sun grazes the horizon; the
    // basic material's colour multiplies its map, so this is free
    dayMat.color.setRGB(1, 1, 1).lerp(DOME_DUSK, twilight * 0.85)
    twilightMat.opacity = twilight * 0.8
    hazeMat.opacity = night

    // clouds: white cotton at noon, embers at the horizon crossings, a faint
    // slate drift over the stars at night
    const ct = (now - birth) / 1000
    cloudU.uCloudTime.value = ct
    cloudU.uSunDir.value.set(Math.cos(a), Math.max(sunEl, 0.12), 0.21)
    cloudU.uCloudLit.value
      .copy(CLOUD_LIT_NIGHT).lerp(CLOUD_LIT_DAY, day).lerp(CLOUD_LIT_DUSK, twilight * 0.9)
    cloudU.uCloudShade.value
      .copy(CLOUD_SHADE_NIGHT).lerp(CLOUD_SHADE_DAY, day).lerp(CLOUD_SHADE_DUSK, twilight * 0.8)
    // night clouds have to stay a suggestion: at daylight opacity the deck
    // reads as smoke over the stars rather than cloud under them
    cloudU.uCloudOpacity.value = 0.3 + day * 0.66 + twilight * 0.12
    // the weather breathes: a two-and-a-half minute swing between a scattered
    // sky and a covered one, slow enough to be a mood rather than an effect
    cloudU.uCover.value = 0.53 - Math.sin(ct * 0.041) * 0.06
    cloudU.uHaze.value.copy(state.fogColor)

    // the red-eye, strobing through its slow circle
    const t = now / 1000
    const pa = t * 0.028
    redEye.position.set(camPos.x + Math.cos(pa) * 260, camPos.y + 190, camPos.z + Math.sin(pa) * 260)
    redEye.lookAt(camPos.x, camPos.y, camPos.z)
    planeMat.opacity =
      (0.08 + Math.pow(Math.max(0, Math.sin(t * 5.2)), 24) * 0.85) * (0.35 + 0.65 * night)

    return state
  }

  return { update, sun: sunLight }
}
