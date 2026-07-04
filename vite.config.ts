import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { email, github, linkedin, more, secondary, showcase } from './src/data/projects'
import { STOPS } from './src/data/experience'

const SITE = 'https://aleju03.github.io'

/**
 * The site is a client-rendered SPA, an empty <div id="root"> to anything that
 * doesn't run JS, so /llms.txt hands crawlers and language models the whole
 * portfolio as plain text, generated from the same data modules the React
 * versions render (it can't go stale independently).
 */
function renderLlmsTxt(): string {
  const parts: string[] = []

  parts.push('# Alejandro Jiménez')
  parts.push(
    '> Full-stack developer from Costa Rica. I build web apps end to end, from React frontends to the servers behind them.',
  )
  parts.push(
    `This is the plain-text rendering of ${SITE}, a client-side React app. ` +
      `A skimmable HTML résumé lives at ${SITE}/?v=simple and each showcase project below has its own page. ` +
      `The default site is an interactive playground with a draggable 3D name, a flyable paper plane, and a retro OS at ${SITE}/alejOS.`,
  )

  parts.push('## Selected work')
  for (const project of showcase) {
    const links = [
      project.live ? `Live: ${project.live}` : null,
      `Source: ${project.repo}`,
      `Page: ${SITE}/projects/${project.slug}`,
    ].filter((link): link is string => link !== null)
    parts.push(
      [
        `### ${project.name}`,
        project.description,
        ...project.details.story,
        `Built with ${project.tech.join(', ')}.`,
        links.join('\n'),
      ].join('\n\n'),
    )
  }

  parts.push('## More projects')
  parts.push(
    [
      ...secondary.map(
        (project) =>
          `- ${project.name}: ${project.description} Built with ${project.tech.join(', ')}. Source: ${project.repo}`,
      ),
      ...more.map((project) => `- ${project.name}: ${project.description} Source: ${project.repo}`),
    ].join('\n'),
  )

  parts.push('## Experience')
  parts.push(
    STOPS.map((stop) => `- ${stop.org}, ${stop.role} (${stop.period}). ${stop.detail} ${stop.url}`).join(
      '\n',
    ),
  )

  parts.push('## Contact')
  parts.push([`- GitHub: ${github}`, `- LinkedIn: ${linkedin}`, `- Email: ${email}`].join('\n'))

  return parts.join('\n\n') + '\n'
}

function llmsTxt(): Plugin {
  return {
    name: 'llms-txt',
    configureServer(server) {
      server.middlewares.use('/llms.txt', (_req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(renderLlmsTxt())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: renderLlmsTxt() })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), llmsTxt()],
  build: {
    // Three.js is intentionally isolated behind idle/interaction-triggered 3D
    // features. Keep warnings for chunks larger than that known vendor split.
    chunkSizeWarningLimit: 600,
  },
})
