import argoIcon from 'simple-icons/icons/argo.svg?url'
import caddyIcon from 'simple-icons/icons/caddy.svg?url'
import cloudflareIcon from 'simple-icons/icons/cloudflare.svg?url'
import dartIcon from 'simple-icons/icons/dart.svg?url'
import dockerIcon from 'simple-icons/icons/docker.svg?url'
import expoIcon from 'simple-icons/icons/expo.svg?url'
import expressIcon from 'simple-icons/icons/express.svg?url'
import fastapiIcon from 'simple-icons/icons/fastapi.svg?url'
import fastifyIcon from 'simple-icons/icons/fastify.svg?url'
import firebaseIcon from 'simple-icons/icons/firebase.svg?url'
import flutterIcon from 'simple-icons/icons/flutter.svg?url'
import hetznerIcon from 'simple-icons/icons/hetzner.svg?url'
import javascriptIcon from 'simple-icons/icons/javascript.svg?url'
import nodeIcon from 'simple-icons/icons/nodedotjs.svg?url'
import pythonIcon from 'simple-icons/icons/python.svg?url'
import reactIcon from 'simple-icons/icons/react.svg?url'
import redisIcon from 'simple-icons/icons/redis.svg?url'
import shadcnIcon from 'simple-icons/icons/shadcnui.svg?url'
import sqliteIcon from 'simple-icons/icons/sqlite.svg?url'
import tailwindIcon from 'simple-icons/icons/tailwindcss.svg?url'
import tanstackIcon from 'simple-icons/icons/tanstack.svg?url'
import tursoIcon from 'simple-icons/icons/turso.svg?url'
import typescriptIcon from 'simple-icons/icons/typescript.svg?url'
import vercelIcon from 'simple-icons/icons/vercel.svg?url'
import viteIcon from 'simple-icons/icons/vite.svg?url'
import azureDevopsIcon from 'devicon/icons/azuredevops/azuredevops-original.svg?url'

export interface BrandIcon {
  src: string
  hex: string
  title: string
}

export const brandIcons = {
  argo: { src: argoIcon, hex: 'EF7B4D', title: 'Argo' },
  azureDevops: { src: azureDevopsIcon, hex: '0078D7', title: 'Azure DevOps' },
  caddy: { src: caddyIcon, hex: '1F88C0', title: 'Caddy' },
  cloudflare: { src: cloudflareIcon, hex: 'F38020', title: 'Cloudflare' },
  dart: { src: dartIcon, hex: '0175C2', title: 'Dart' },
  docker: { src: dockerIcon, hex: '2496ED', title: 'Docker' },
  expo: { src: expoIcon, hex: '1C2024', title: 'Expo' },
  express: { src: expressIcon, hex: '000000', title: 'Express' },
  fastapi: { src: fastapiIcon, hex: '009688', title: 'FastAPI' },
  fastify: { src: fastifyIcon, hex: '000000', title: 'Fastify' },
  firebase: { src: firebaseIcon, hex: 'DD2C00', title: 'Firebase' },
  flutter: { src: flutterIcon, hex: '02569B', title: 'Flutter' },
  hetzner: { src: hetznerIcon, hex: 'D50C2D', title: 'Hetzner' },
  javascript: { src: javascriptIcon, hex: 'F7DF1E', title: 'JavaScript' },
  node: { src: nodeIcon, hex: '5FA04E', title: 'Node.js' },
  python: { src: pythonIcon, hex: '3776AB', title: 'Python' },
  react: { src: reactIcon, hex: '61DAFB', title: 'React' },
  redis: { src: redisIcon, hex: 'FF4438', title: 'Redis' },
  shadcn: { src: shadcnIcon, hex: '000000', title: 'shadcn/ui' },
  sqlite: { src: sqliteIcon, hex: '003B57', title: 'SQLite' },
  tailwind: { src: tailwindIcon, hex: '06B6D4', title: 'Tailwind CSS' },
  tanstack: { src: tanstackIcon, hex: '000000', title: 'TanStack' },
  turso: { src: tursoIcon, hex: '4FF8D2', title: 'Turso' },
  typescript: { src: typescriptIcon, hex: '3178C6', title: 'TypeScript' },
  vercel: { src: vercelIcon, hex: '000000', title: 'Vercel' },
  vite: { src: viteIcon, hex: '9135FF', title: 'Vite' },
} satisfies Record<string, BrandIcon>
