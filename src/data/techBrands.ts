import { brandIcons } from './brandIcons'
import type { BrandIcon } from './brandIcons'

export interface TechBrand {
  icon?: BrandIcon
  url?: string
  /** near-black brand marks render in the text color so they survive dark mode */
  mono?: boolean
}

/** brand marks for the tech names used in projects.ts; Recharts has no
 * simple-icons entry and falls back to a chart glyph in the badge component */
export const techBrands: Record<string, TechBrand> = {
  TypeScript: { icon: brandIcons.typescript, url: 'https://www.typescriptlang.org' },
  JavaScript: {
    icon: brandIcons.javascript,
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  },
  Python: { icon: brandIcons.python, url: 'https://www.python.org' },
  React: { icon: brandIcons.react, url: 'https://react.dev' },
  'React 19': { icon: brandIcons.react, url: 'https://react.dev' },
  'React Native': { icon: brandIcons.react, url: 'https://reactnative.dev' },
  'TanStack Start': { icon: brandIcons.tanstack, url: 'https://tanstack.com/start', mono: true },
  'Node.js': { icon: brandIcons.node, url: 'https://nodejs.org' },
  Caddy: { icon: brandIcons.caddy, url: 'https://caddyserver.com' },
  Hetzner: { icon: brandIcons.hetzner, url: 'https://www.hetzner.com' },
  SQLite: { icon: brandIcons.sqlite, url: 'https://sqlite.org', mono: true },
  Fastify: { icon: brandIcons.fastify, url: 'https://fastify.dev', mono: true },
  Turso: { icon: brandIcons.turso, url: 'https://turso.tech' },
  'Cloudflare R2': {
    icon: brandIcons.cloudflare,
    url: 'https://developers.cloudflare.com/r2/',
  },
  FastAPI: { icon: brandIcons.fastapi, url: 'https://fastapi.tiangolo.com' },
  Recharts: { url: 'https://recharts.org' },
  Flutter: { icon: brandIcons.flutter, url: 'https://flutter.dev' },
  Dart: { icon: brandIcons.dart, url: 'https://dart.dev' },
  Firebase: { icon: brandIcons.firebase, url: 'https://firebase.google.com' },
  Expo: { icon: brandIcons.expo, url: 'https://expo.dev', mono: true },
  'Redux Toolkit': { url: 'https://redux-toolkit.js.org' },
  'React Native Paper': { url: 'https://callstack.github.io/react-native-paper/' },
  'shadcn/ui': { icon: brandIcons.shadcn, url: 'https://ui.shadcn.com', mono: true },
  Docker: { icon: brandIcons.docker, url: 'https://www.docker.com' },
  WebSockets: { url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API' },
  Redis: { icon: brandIcons.redis, url: 'https://redis.io' },
}
