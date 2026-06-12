export interface GalleryImage {
  src: string
  alt: string
  caption: string
}

export interface ProjectDetails {
  /** first-person paragraphs about the experience of building it */
  story: string[]
  learned: string[]
  /** modal gallery; the first entry doubles as the opening shot */
  gallery: GalleryImage[]
}

export interface ShowcaseProject {
  name: string
  description: string
  tech: string[]
  image: string
  imageAlt: string
  /** 'wide' fills the media pane, 'phone' centers a portrait shot on a tile */
  imageKind: 'wide' | 'phone'
  /** crop anchor for wide images; 'left-top' keeps sidebars and headings readable */
  imagePos?: 'top' | 'left-top'
  live?: string
  liveLabel?: string
  repo: string
  details: ProjectDetails
}

export interface SecondaryProject {
  name: string
  description: string
  tech: string[]
  image: string
  imageAlt: string
  /** dark tile for light marks, light tile for colored marks */
  tile: 'dark' | 'light'
  repo: string
}

export interface SmallProject {
  name: string
  description: string
  repo: string
}

export const showcase: ShowcaseProject[] = [
  {
    name: 'Mania Tracker',
    description:
      'Country rankings, live score tracking, top plays, and a replay viewer for osu!mania. A TanStack Start frontend with a Node service behind it that ingests scores and streams updates to the browser over SSE.',
    tech: ['TypeScript', 'React 19', 'TanStack Start', 'Node.js', 'SQLite', 'Caddy', 'Hetzner'],
    image: '/projects/mania-hub.png',
    imageAlt: 'Mania Tracker home dashboard with rankings and live scores',
    imageKind: 'wide',
    live: 'https://mania-tracker.com',
    liveLabel: 'mania-tracker.com',
    repo: 'https://github.com/aleju03/mania-hub',
    details: {
      story: [
        'Mania Tracker follows the competitive scene of a rhythm game, tracking who is climbing the rankings, who just set a big score, and what everyone is playing. A TanStack Start frontend sits on top of an always-on Node service that does the heavy lifting.',
        'The interesting problems were all in the real-time pipeline. The service ingests scores from a community feed, keeps durable projections in SQLite, and pushes everything else, like enrichment, leaderboards, and replay rendering, through a database-backed job queue. Browsers fetch a snapshot on page load and subscribe to a Server-Sent Events stream, and if the connection drops the client replays exactly the events it missed.',
        'The frontend lives on Vercel, while the live service and its database run on a Hetzner VPS I manage myself, with Caddy in front and several cache layers between the upstream API and the browser so pages stay instant without burning through API quotas.',
      ],
      learned: [
        'Streaming live updates over SSE and replaying missed events on reconnect, instead of reaching for WebSockets',
        'Building a durable job queue on plain SQLite without any extra infrastructure',
        'Provisioning and running a production VPS on Hetzner with Caddy as the reverse proxy',
        'Stacking cache layers and a token-bucket rate limiter to keep the app fast without blowing through API quotas',
      ],
      gallery: [
        {
          src: '/projects/mania-hub.png',
          alt: 'Mania Tracker home dashboard with rankings and live scores',
          caption: 'The home dashboard with rankings, recent top plays, and the live score feed.',
        },
        {
          src: '/projects/mania-live-2.png',
          alt: 'Country rankings table with player stats and rank movement',
          caption: 'Country rankings with weekly rank movement.',
        },
        {
          src: '/projects/mania-live-3.png',
          alt: 'Live tracker feed of scores streaming in real time',
          caption: 'The live tracker, streaming scores to the browser as they happen.',
        },
        {
          src: '/projects/mania-replay.png',
          alt: 'Replay viewer rendering a play with falling notes and judgments',
          caption: 'The replay viewer rendering a parsed replay file with custom skins.',
        },
      ],
    },
  },
  {
    name: 'Wallpaper Archive',
    description:
      'Browse, download, and rank wallpapers, with an Arena mode where head-to-head votes decide the best backgrounds. A Fastify API keeps rankings in Turso and serves images from Cloudflare R2.',
    tech: ['JavaScript', 'React', 'Fastify', 'Turso', 'Cloudflare R2'],
    image: '/projects/wallpaper-archive.png',
    imageAlt: 'Wallpaper Archive gallery grid',
    imageKind: 'wide',
    live: 'https://wallpaper-archive.vercel.app',
    liveLabel: 'wallpaper-archive.vercel.app',
    repo: 'https://github.com/aleju03/Wallpaper-Archive',
    details: {
      story: [
        'It started as a faster way to browse and download wallpapers for myself, then grew into a public gallery with an Arena mode, where wallpapers go head-to-head and an Elo rating decides the all-time best.',
        'Most of the real work lives in the image pipeline. Every wallpaper gets thumbnails, extracted metadata, and a hash-based duplicate check, so the same image scraped from two sources only shows up once. A Fastify API keeps rankings and metadata in Turso while the originals are served from Cloudflare R2.',
      ],
      learned: [
        'Serving thousands of images cheaply from object storage',
        'Running SQLite at the edge with Turso and squeezing a real app into free tiers',
        'Catching duplicate images with hashing instead of comparing pixels',
      ],
      gallery: [
        {
          src: '/projects/wallpaper-archive.png',
          alt: 'Wallpaper Archive gallery grid',
          caption: 'Browsing the collection with provider and resolution filters.',
        },
        {
          src: '/projects/wallpaper-arena.png',
          alt: 'Arena mode with two wallpapers facing off',
          caption: 'Arena mode, where picking the better wallpaper feeds the Elo ratings.',
        },
        {
          src: '/projects/wallpaper-leaderboard.png',
          alt: 'Arena champions leaderboard ranked by Elo rating',
          caption: 'Arena champions, ranked by rating, battles, and win rate.',
        },
      ],
    },
  },
  {
    name: 'HealthFlow',
    description:
      'Personal health dashboard tracking weight, body composition, hydration, steps, and exercise, with historical views and period summaries.',
    tech: ['React', 'FastAPI', 'SQLite', 'Recharts', 'shadcn/ui'],
    image: '/projects/healthflow.png',
    imageAlt: 'HealthFlow history dashboard with health metrics',
    imageKind: 'wide',
    imagePos: 'left-top',
    repo: 'https://github.com/aleju03/HealthFlow',
    details: {
      story: [
        'A personal health dashboard for weight, body composition, hydration, steps, and exercise, with history views and period summaries. It was my first time putting a Python backend behind a React frontend.',
        'FastAPI turned out to be a great first API framework, but the part that taught me the most was the data model. It needed real accounts with registration and login, plus years of daily metrics structured so the history and summary views stay fast. On the frontend I leaned on shadcn/ui and animation to make a CRUD dashboard feel polished rather than clinical.',
      ],
      learned: [
        'Designing and documenting a REST API with FastAPI',
        'Modeling a relational database from scratch, with real user auth on top',
        'Polishing a data-heavy UI with shadcn/ui, Recharts, and motion',
      ],
      gallery: [
        {
          src: '/projects/healthflow.png',
          alt: 'HealthFlow history dashboard with health metrics',
          caption: 'The history view, summarizing each metric over a period with trend deltas.',
        },
        {
          src: '/projects/healthflow-2.png',
          alt: 'HealthFlow home dashboard with body composition and daily goals',
          caption: 'The home dashboard with body composition, daily goals, and activity.',
        },
        {
          src: '/projects/healthflow-4.png',
          alt: 'Detailed history view with per-metric line charts',
          caption: 'Detailed history with per-metric line charts.',
        },
        {
          src: '/projects/healthflow-5.png',
          alt: 'Data import wizard with selectable data types',
          caption: 'The data import wizard.',
        },
      ],
    },
  },
  {
    name: 'Pokémon TCG Searcher',
    description:
      'Android app for searching Pokémon cards, browsing sets, and checking market prices, built on the pokemontcg.io API.',
    tech: ['Flutter', 'Dart', 'Firebase'],
    image: '/projects/pokemon-tcg.png',
    imageAlt: 'Pokémon TCG Searcher card search screen',
    imageKind: 'phone',
    repo: 'https://github.com/aleju03/pokemon_tcg_app',
    details: {
      story: [
        'My first mobile app, built with Flutter for a university course. It lets you search any card, browse sets, and check market prices through the public Pokémon TCG API.',
        "Coming from web, Flutter's widget tree and Provider-based state were a real mind shift. I spent most of my time optimizing API usage, requesting only the fields each screen needs and paginating results so the app stays fast on a phone connection. Google sign-in through Firebase taught me the joys of OAuth configuration, SHA-1 fingerprints included.",
      ],
      learned: [
        'Flutter and Dart fundamentals, from the widget tree to navigation and async data',
        'Treating API calls as a budget by selecting fields, paginating, and cutting round trips',
        'Wiring up Google OAuth with Firebase Auth on Android',
        'Scoping and shipping a real app on a course deadline',
      ],
      gallery: [
        {
          src: '/projects/pokemon-tcg.png',
          alt: 'Pokémon TCG Searcher card search screen',
          caption: 'Card search with price sorting.',
        },
        {
          src: '/projects/poketcg-details.png',
          alt: 'Card details screen with stats and attacks',
          caption: 'Card details with stats, attacks, and market price.',
        },
        {
          src: '/projects/poketcg-market.png',
          alt: 'Market view with cards ranked by price',
          caption: 'The market view, where every card is ranked by price.',
        },
        {
          src: '/projects/poketcg-sets.png',
          alt: 'Sets browser grouped by series',
          caption: 'Browsing sets grouped by series.',
        },
      ],
    },
  },
]

export const secondary: SecondaryProject[] = [
  {
    name: 'SnakeDocker',
    description:
      'Multiplayer Snake with distributed processing: specialized Docker workers, dynamic load balancing, and WebSocket gameplay.',
    tech: ['Python', 'Docker', 'WebSockets'],
    image: '/projects/snake-logo.png',
    imageAlt: 'SnakeDocker wordmark',
    tile: 'dark',
    repo: 'https://github.com/aleju03/distributed-snake-game',
  },
  {
    name: 'DocIndexer',
    description:
      'Distributed document indexing and search: a FastAPI coordinator farms text processing out to workers over Redis queues.',
    tech: ['Python', 'FastAPI', 'Redis', 'Docker'],
    image: '/projects/doc-indexer.svg',
    imageAlt: 'DocIndexer mark',
    tile: 'dark',
    repo: 'https://github.com/aleju03/doc-indexer',
  },
]

export const more: SmallProject[] = [
  {
    name: 'WebNBA',
    description: 'NBA games and stats browser built with React.',
    repo: 'https://github.com/aleju03/WebNBA',
  },
  {
    name: 'Aula',
    description: 'School management app for assignments, messaging, and classroom coordination.',
    repo: 'https://github.com/aleju03/Aula',
  },
  {
    name: 'admin-dashboard',
    description: 'Admin dashboard built with React.',
    repo: 'https://github.com/aleju03/admin-dashboard',
  },
]

export const github = 'https://github.com/aleju03'
export const linkedin = 'https://www.linkedin.com/in/alejandro-jim%C3%A9nez-ulloa-692196329/'
export const email = 'alejimenezu@gmail.com'
