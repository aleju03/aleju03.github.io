import type { CSSProperties } from 'react'
import type { SimpleIcon } from 'simple-icons'
import {
  siArgo,
  siCaddy,
  siDocker,
  siExpo,
  siExpress,
  siFastapi,
  siFastify,
  siFirebase,
  siFlutter,
  siHetzner,
  siJavascript,
  siNextdotjs,
  siNodedotjs,
  siPostgresql,
  siPython,
  siReact,
  siRedis,
  siSqlite,
  siSupabase,
  siTailwindcss,
  siTanstack,
  siTurso,
  siTypescript,
  siUnity,
  siVercel,
  siVite,
} from 'simple-icons'
// devicon fills the simple-icons gaps: Azure DevOps + SQL Server (no Microsoft
// brands) and Java (only the black OpenJDK mark ships, not the classic cup)
import azureDevopsIcon from 'devicon/icons/azuredevops/azuredevops-original.svg'
import sqlServerIcon from 'devicon/icons/microsoftsqlserver/microsoftsqlserver-original.svg'
import javaIcon from 'devicon/icons/java/java-original.svg'

interface Tool {
  name: string
  url: string
  icon?: SimpleIcon
  /** image fallback for brands missing from simple-icons */
  img?: { src: string; hex: string }
  /** near-black brand marks render in the text color so they survive dark mode */
  mono?: boolean
}

const CATEGORIES: { label: string; tools: Tool[] }[] = [
  {
    label: 'Languages',
    tools: [
      { name: 'TypeScript', url: 'https://www.typescriptlang.org', icon: siTypescript },
      {
        name: 'JavaScript',
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
        icon: siJavascript,
      },
      { name: 'Python', url: 'https://www.python.org', icon: siPython },
      {
        name: 'Java',
        url: 'https://www.java.com',
        img: { src: javaIcon, hex: '#0074BD' },
      },
    ],
  },
  {
    label: 'Frontend',
    tools: [
      { name: 'React', url: 'https://react.dev', icon: siReact },
      { name: 'Next.js', url: 'https://nextjs.org', icon: siNextdotjs, mono: true },
      { name: 'TanStack', url: 'https://tanstack.com', icon: siTanstack, mono: true },
      { name: 'Vite', url: 'https://vite.dev', icon: siVite },
      { name: 'Tailwind CSS', url: 'https://tailwindcss.com', icon: siTailwindcss },
      { name: 'Flutter', url: 'https://flutter.dev', icon: siFlutter },
      { name: 'Expo', url: 'https://expo.dev', icon: siExpo, mono: true },
    ],
  },
  {
    label: 'Backend',
    tools: [
      { name: 'Node.js', url: 'https://nodejs.org', icon: siNodedotjs },
      { name: 'Express', url: 'https://expressjs.com', icon: siExpress, mono: true },
      { name: 'FastAPI', url: 'https://fastapi.tiangolo.com', icon: siFastapi },
      { name: 'Fastify', url: 'https://fastify.dev', icon: siFastify, mono: true },
    ],
  },
  {
    label: 'Data',
    tools: [
      { name: 'SQLite', url: 'https://sqlite.org', icon: siSqlite, mono: true },
      { name: 'PostgreSQL', url: 'https://www.postgresql.org', icon: siPostgresql },
      {
        name: 'SQL Server',
        url: 'https://www.microsoft.com/en-us/sql-server',
        img: { src: sqlServerIcon, hex: '#CC2927' },
      },
      { name: 'Turso', url: 'https://turso.tech', icon: siTurso },
      { name: 'Supabase', url: 'https://supabase.com', icon: siSupabase },
      { name: 'Firebase', url: 'https://firebase.google.com', icon: siFirebase },
      { name: 'Redis', url: 'https://redis.io', icon: siRedis },
    ],
  },
  {
    label: 'Infra',
    tools: [
      { name: 'Docker', url: 'https://www.docker.com', icon: siDocker },
      { name: 'Caddy', url: 'https://caddyserver.com', icon: siCaddy },
      {
        name: 'Azure DevOps',
        url: 'https://azure.microsoft.com/en-us/products/devops',
        img: { src: azureDevopsIcon, hex: '#0078D7' },
      },
      { name: 'Argo CD', url: 'https://argoproj.github.io/cd/', icon: siArgo },
      { name: 'Vercel', url: 'https://vercel.com', icon: siVercel, mono: true },
      { name: 'Hetzner', url: 'https://www.hetzner.com', icon: siHetzner },
    ],
  },
  {
    label: 'Game',
    tools: [{ name: 'Unity', url: 'https://unity.com', icon: siUnity, mono: true }],
  },
]

function ToolChip({ tool }: { tool: Tool }) {
  const brand = tool.img ? tool.img.hex : tool.mono ? 'currentColor' : `#${tool.icon!.hex}`
  return (
    <li>
      <a
        href={tool.url}
        target="_blank"
        rel="noreferrer"
        style={{ '--brand': brand } as CSSProperties}
        className="flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1.5 pr-3.5 pl-2.5 text-sm text-stone-700 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-(--brand) hover:shadow-md dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300"
      >
        {tool.img ? (
          <img src={tool.img.src} alt="" aria-hidden="true" className="h-4 w-4" />
        ) : (
          <svg role="img" aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill={brand}>
            <path d={tool.icon!.path} />
          </svg>
        )}
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
