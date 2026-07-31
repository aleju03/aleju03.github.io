# Portfolio

Personal site for [aleju03](https://github.com/aleju03). A résumé page that hides an early-2000s desktop OS, a 3D room, and a walkable procedural planet behind it.

Three packages live here:

- **root**: the SPA (React 19 + TypeScript + Vite + Tailwind v4 + Three.js), deployed to GitHub Pages
- **`server/`**: the chat/arcade/presence WebSocket server (Node 22, `ws` + SQLite), deployed to a VPS
- **`npx-card/`**: run `npx aleju` in a terminal

## The site

The page scrolls as one continuous flight: a dashed contrail inked down the document, ending on a dead CRT that stands up and lights its tube. Press your pointer to the glass and the picture bends around it like a speaker held against a monitor in 2003. Click and it boots AlejOS, a desktop OS with a filesystem, apps, live chat and an arcade. Everything degrades: reduced motion gets a plain readable page, and no server means email fallbacks.

Nothing is shipped that wasn't generated: every sound is synthesized at runtime with WebAudio, and textures are drawn onto canvases. The planet is deterministic procgen, so multiplayer only sends poses over the wire, never terrain.

## Three ways in

| route | what loads | first frame |
| --- | --- | --- |
| `/pc` | the desktop in a flat bezel, no three.js at all | instant |
| `/alejOS` | the desktop on the 3D CRT, in the room, no open world | ~4 s cold |
| `/world` | everything, on your feet, ready to walk out | ~12 s cold |

The room and the open world load separately: `/alejOS` builds the room only, and opening the front door streams the planet in behind a short cover. `/world` pays for all of it up front.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
npm run preview  # serve the production build
```

`.env.example` documents `VITE_CHAT_URL`; without it, chat features fall back to email.

## Content

Project data lives in `src/data/projects.ts` (with `experience.ts` and `skills.ts`), which also generates `/llms.txt` at build time. Thumbnails are real screenshots in `public/projects/`.
