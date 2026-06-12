import type { SimpleIcon } from 'simple-icons'
import {
  siCaddy,
  siCloudflare,
  siDart,
  siDocker,
  siExpo,
  siFastapi,
  siFastify,
  siFirebase,
  siFlutter,
  siHetzner,
  siPython,
  siJavascript,
  siNodedotjs,
  siRedis,
  siReact,
  siShadcnui,
  siSqlite,
  siTanstack,
  siTurso,
  siTypescript,
} from 'simple-icons'

export interface TechBrand {
  icon?: SimpleIcon
  url?: string
  /** near-black brand marks render in the text color so they survive dark mode */
  mono?: boolean
}

/** brand marks for the tech names used in projects.ts; Recharts has no
 * simple-icons entry and falls back to a chart glyph in the badge component */
export const techBrands: Record<string, TechBrand> = {
  TypeScript: { icon: siTypescript, url: 'https://www.typescriptlang.org' },
  JavaScript: {
    icon: siJavascript,
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  },
  Python: { icon: siPython, url: 'https://www.python.org' },
  React: { icon: siReact, url: 'https://react.dev' },
  'React 19': { icon: siReact, url: 'https://react.dev' },
  'React Native': { icon: siReact, url: 'https://reactnative.dev' },
  'TanStack Start': { icon: siTanstack, url: 'https://tanstack.com/start', mono: true },
  'Node.js': { icon: siNodedotjs, url: 'https://nodejs.org' },
  Caddy: { icon: siCaddy, url: 'https://caddyserver.com' },
  Hetzner: { icon: siHetzner, url: 'https://www.hetzner.com' },
  SQLite: { icon: siSqlite, url: 'https://sqlite.org', mono: true },
  Fastify: { icon: siFastify, url: 'https://fastify.dev', mono: true },
  Turso: { icon: siTurso, url: 'https://turso.tech' },
  'Cloudflare R2': {
    icon: siCloudflare,
    url: 'https://developers.cloudflare.com/r2/',
  },
  FastAPI: { icon: siFastapi, url: 'https://fastapi.tiangolo.com' },
  Recharts: { url: 'https://recharts.org' },
  Flutter: { icon: siFlutter, url: 'https://flutter.dev' },
  Dart: { icon: siDart, url: 'https://dart.dev' },
  Firebase: { icon: siFirebase, url: 'https://firebase.google.com' },
  Expo: { icon: siExpo, url: 'https://expo.dev', mono: true },
  'Redux Toolkit': { url: 'https://redux-toolkit.js.org' },
  'React Native Paper': { url: 'https://callstack.github.io/react-native-paper/' },
  'shadcn/ui': { icon: siShadcnui, url: 'https://ui.shadcn.com', mono: true },
  Docker: { icon: siDocker, url: 'https://www.docker.com' },
  WebSockets: { url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API' },
  Redis: { icon: siRedis, url: 'https://redis.io' },
}
