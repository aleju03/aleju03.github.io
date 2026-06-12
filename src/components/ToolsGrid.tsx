import type { CSSProperties } from 'react'
import { brandIcons } from '../data/brandIcons'
import type { BrandIcon } from '../data/brandIcons'

interface Tool {
  name: string
  url: string
  icon: BrandIcon
  /** near-black brand marks render in the text color so they survive dark mode */
  mono?: boolean
}

const CATEGORIES: { label: string; tools: Tool[] }[] = [
  {
    label: 'Languages',
    tools: [
      { name: 'TypeScript', url: 'https://www.typescriptlang.org', icon: brandIcons.typescript },
      {
        name: 'JavaScript',
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
        icon: brandIcons.javascript,
      },
      { name: 'Python', url: 'https://www.python.org', icon: brandIcons.python },
    ],
  },
  {
    label: 'Frontend',
    tools: [
      { name: 'React', url: 'https://react.dev', icon: brandIcons.react },
      { name: 'TanStack', url: 'https://tanstack.com', icon: brandIcons.tanstack, mono: true },
      { name: 'Vite', url: 'https://vite.dev', icon: brandIcons.vite },
      { name: 'Tailwind CSS', url: 'https://tailwindcss.com', icon: brandIcons.tailwind },
      { name: 'Flutter', url: 'https://flutter.dev', icon: brandIcons.flutter },
      { name: 'Expo', url: 'https://expo.dev', icon: brandIcons.expo, mono: true },
    ],
  },
  {
    label: 'Backend',
    tools: [
      { name: 'Node.js', url: 'https://nodejs.org', icon: brandIcons.node },
      { name: 'Express', url: 'https://expressjs.com', icon: brandIcons.express, mono: true },
      { name: 'FastAPI', url: 'https://fastapi.tiangolo.com', icon: brandIcons.fastapi },
      { name: 'Fastify', url: 'https://fastify.dev', icon: brandIcons.fastify, mono: true },
    ],
  },
  {
    label: 'Data',
    tools: [
      { name: 'SQLite', url: 'https://sqlite.org', icon: brandIcons.sqlite, mono: true },
      { name: 'Turso', url: 'https://turso.tech', icon: brandIcons.turso },
      { name: 'Redis', url: 'https://redis.io', icon: brandIcons.redis },
      { name: 'Firebase', url: 'https://firebase.google.com', icon: brandIcons.firebase },
    ],
  },
  {
    label: 'Infra',
    tools: [
      { name: 'Docker', url: 'https://www.docker.com', icon: brandIcons.docker },
      { name: 'Caddy', url: 'https://caddyserver.com', icon: brandIcons.caddy },
      {
        name: 'Azure DevOps',
        url: 'https://azure.microsoft.com/en-us/products/devops',
        icon: brandIcons.azureDevops,
      },
      { name: 'Argo CD', url: 'https://argoproj.github.io/cd/', icon: brandIcons.argo },
      { name: 'Vercel', url: 'https://vercel.com', icon: brandIcons.vercel, mono: true },
      { name: 'Hetzner', url: 'https://www.hetzner.com', icon: brandIcons.hetzner },
    ],
  },
]

function ToolChip({ tool }: { tool: Tool }) {
  const brand = tool.mono ? 'currentColor' : `#${tool.icon.hex}`
  return (
    <li>
      <a
        href={tool.url}
        target="_blank"
        rel="noreferrer"
        style={{ '--brand': brand } as CSSProperties}
        className="flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1.5 pr-3.5 pl-2.5 text-sm text-stone-700 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-(--brand) hover:shadow-md dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300"
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 bg-(--brand)"
          style={{
            mask: `url(${tool.icon.src}) center / contain no-repeat`,
            WebkitMask: `url(${tool.icon.src}) center / contain no-repeat`,
          }}
        />
        {tool.name}
      </a>
    </li>
  )
}

export function ToolsGrid() {
  return (
    <dl className="flex flex-col gap-5">
      {CATEGORIES.map(({ label, tools }) => (
        <div key={label} className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-0">
          <dt className="w-28 shrink-0 font-mono text-xs text-stone-500">{label}</dt>
          <dd>
            <ul className="flex flex-wrap gap-2">
              {tools.map((tool) => (
                <ToolChip key={tool.name} tool={tool} />
              ))}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  )
}
