/**
 * Skill names + links only, no icon imports, so the simple version stays light
 * (the full-site ToolsGrid keeps its own simple-icons brand marks). Grouped the
 * same way as ToolsGrid; the simple résumé flattens these into one mono line.
 */
export interface Skill {
  name: string
  url: string
}

export const SKILL_GROUPS: { label: string; items: Skill[] }[] = [
  {
    label: 'Languages',
    items: [
      { name: 'TypeScript', url: 'https://www.typescriptlang.org' },
      { name: 'JavaScript', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
      { name: 'Python', url: 'https://www.python.org' },
    ],
  },
  {
    label: 'Frontend',
    items: [
      { name: 'React', url: 'https://react.dev' },
      { name: 'TanStack', url: 'https://tanstack.com' },
      { name: 'Vite', url: 'https://vite.dev' },
      { name: 'Tailwind CSS', url: 'https://tailwindcss.com' },
      { name: 'Flutter', url: 'https://flutter.dev' },
      { name: 'Expo', url: 'https://expo.dev' },
    ],
  },
  {
    label: 'Backend',
    items: [
      { name: 'Node.js', url: 'https://nodejs.org' },
      { name: 'Express', url: 'https://expressjs.com' },
      { name: 'FastAPI', url: 'https://fastapi.tiangolo.com' },
      { name: 'Fastify', url: 'https://fastify.dev' },
    ],
  },
  {
    label: 'Data',
    items: [
      { name: 'SQLite', url: 'https://sqlite.org' },
      { name: 'Turso', url: 'https://turso.tech' },
      { name: 'Redis', url: 'https://redis.io' },
      { name: 'Firebase', url: 'https://firebase.google.com' },
    ],
  },
  {
    label: 'Infra',
    items: [
      { name: 'Docker', url: 'https://www.docker.com' },
      { name: 'Caddy', url: 'https://caddyserver.com' },
      { name: 'Azure DevOps', url: 'https://azure.microsoft.com/en-us/products/devops' },
      { name: 'Argo CD', url: 'https://argoproj.github.io/cd/' },
      { name: 'Vercel', url: 'https://vercel.com' },
      { name: 'Hetzner', url: 'https://www.hetzner.com' },
    ],
  },
]

/** every skill, flattened in display order */
export const SKILLS: Skill[] = SKILL_GROUPS.flatMap((group) => group.items)
