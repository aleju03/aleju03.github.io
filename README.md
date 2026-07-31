# Portfolio

Personal portfolio for [aleju03](https://github.com/aleju03). Single-page site showcasing selected projects with live links and source.

## Stack

- React 19 + TypeScript + Vite
- Tailwind CSS v4 with light/dark themes (system preference by default, manual toggle persisted to localStorage)
- Motion for entrance and scroll-reveal animations (respects `prefers-reduced-motion`)
- Three.js for the hero dot-wave field (lazy-loaded in its own chunk, theme-aware)
- Howler for the score. Every cue is synthesized at runtime in an `OfflineAudioContext` and handed over as a blob, so no audio ships
- Command palette on Ctrl/Cmd+K: search projects, sections, and actions
- Playful details: click the hero to ripple the dot field, theme switches with a circular wipe (View Transitions API)

## The flight path

The page is choreographed as one continuous flight. A blue dashed contrail, the same line the paper plane inks behind itself, is drawn down the whole document by your scroll, from the name to the machine at the foot of the site, with folded-paper waypoints opening at each chapter. It rides the hero's existing canvas rather than a second one: that canvas is already fixed to the viewport with its world pinned to the document, so a curve laid out in document pixels stays glued to the sections for free.

The flight ends on **the machine**. The dead CRT that has been lying in the corner of this site since the footer existed stands up as you scroll, and its tube lights: the raster paints itself down the glass, the coil shakes the field out with one degauss shudder, and a terminal comes up listing what is running. Hold your pointer against the glass and the picture bends around it and splits into red, green and blue, because the three electron guns are deflected by different amounts. It is the same thing that happened to anyone who put a speaker next to a monitor in 2003. Move away and the geometry springs back with a wobble. Click and it boots into AlejOS.

None of it is a gate: the chapter reads fine without touching anything, and reduced motion drops the tube, the cursor and the 3D entirely and leaves a plain, readable page. Sound is off under `prefers-reduced-motion` and can be killed from the nav.

## Three ways in

AlejOS has three entrances, and they differ in what they make you wait for:

| route | what loads | first frame |
| --- | --- | --- |
| `/pc` | the desktop in a flat bezel, no three.js at all | instant |
| `/alejOS` | the desktop on the 3D CRT, in the room, no open world | ~4 s cold |
| `/world` | everything, on your feet, ready to walk out | ~12 s cold |

`/alejOS` used to load the whole procedural planet before it would show you the login screen, which is several seconds of chunk building and outdoor shader compilation for scenery behind a door most visitors never open. It now builds the room only; stand up and walk the house for free, and opening the front door streams the world in behind a short cover. `/world` is the route that pays for it up front. (It was `/room` before the two came apart. Old links still work and quietly redirect.)
- Phosphor icons, simple-icons for the tools grid, Geist + Geist Mono (self-hosted via Fontsource)

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
npm run preview  # serve the production build
```

## Content

Project data (names, descriptions, tech, links) lives in `src/data/projects.ts`. Thumbnails are real screenshots pulled from each repo's README, stored in `public/projects/`.
