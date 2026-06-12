# Portfolio

Personal portfolio for [aleju03](https://github.com/aleju03). Single-page site showcasing selected projects with live links and source.

## Stack

- React 19 + TypeScript + Vite
- Tailwind CSS v4 with light/dark themes (system preference by default, manual toggle persisted to localStorage)
- Motion for entrance and scroll-reveal animations (respects `prefers-reduced-motion`)
- Three.js for the hero dot-wave field (lazy-loaded in its own chunk, theme-aware)
- Command palette on Ctrl/Cmd+K: search projects, sections, and actions
- Playful details: click the hero to ripple the dot field, theme switches with a circular wipe (View Transitions API)
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
