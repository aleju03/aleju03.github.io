import type { SimpleIcon } from 'simple-icons'
import {
  siCaddy,
  siCloudflare,
  siDart,
  siFastapi,
  siFastify,
  siFirebase,
  siFlutter,
  siHetzner,
  siJavascript,
  siNodedotjs,
  siReact,
  siShadcnui,
  siSqlite,
  siTanstack,
  siTurso,
  siTypescript,
} from 'simple-icons'

export interface TechBrand {
  icon?: SimpleIcon
  /** near-black brand marks render in the text color so they survive dark mode */
  mono?: boolean
}

/** brand marks for the tech names used in projects.ts; Recharts has no
 * simple-icons entry and falls back to a chart glyph in the badge component */
export const techBrands: Record<string, TechBrand> = {
  TypeScript: { icon: siTypescript },
  JavaScript: { icon: siJavascript },
  React: { icon: siReact },
  'React 19': { icon: siReact },
  'TanStack Start': { icon: siTanstack, mono: true },
  'Node.js': { icon: siNodedotjs },
  Caddy: { icon: siCaddy },
  Hetzner: { icon: siHetzner },
  SQLite: { icon: siSqlite, mono: true },
  Fastify: { icon: siFastify, mono: true },
  Turso: { icon: siTurso },
  'Cloudflare R2': { icon: siCloudflare },
  FastAPI: { icon: siFastapi },
  Flutter: { icon: siFlutter },
  Dart: { icon: siDart },
  Firebase: { icon: siFirebase },
  'shadcn/ui': { icon: siShadcnui, mono: true },
}
