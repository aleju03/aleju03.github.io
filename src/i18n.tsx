/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { showcase, secondary, more } from './data/projects'
import type { GalleryImage, SecondaryProject, ShowcaseProject, SmallProject } from './data/projects'

export type Language = 'en' | 'es'

const STORAGE_KEY = 'portfolio-language'

const dictionaries = {
  en: {
    localTime: 'Local time in Costa Rica',
    nav: {
      work: 'Work',
      experience: 'Experience',
      about: 'About',
      contact: 'Contact',
      backToTop: 'Back to top',
      openPalette: 'Open command palette',
      github: 'GitHub profile',
      linkedin: 'LinkedIn profile',
      switchLight: 'Switch to light theme',
      switchDark: 'Switch to dark theme',
      language: 'Language',
      switchVersion: 'Switch version',
    },
    hero: {
      fixName: 'fix my name',
      intro:
        'Full-stack developer from Costa Rica. I build web apps end to end, from React frontends to the servers behind them.',
      viewWork: 'View work',
      flightHint: {
        desktop: 'wasd to fly\nshift boost\nspace swoop',
        touch: 'tap the plane to fly',
        joystick: 'Flight joystick',
        boostAria: 'Speed boost',
        swoopAria: 'Swoop',
        boost: 'boost',
        swoop: 'swoop',
      },
    },
    sections: {
      selectedWork: 'Selected work',
      moreProjects: 'More projects',
      experience: 'Experience',
      about: 'About',
      tools: 'Tools I’ve worked with',
      contact: 'Get in touch',
      allRepositories: 'All repositories',
    },
    work: {
      viewDetails: 'View details for',
      source: 'Source',
    },
    modal: {
      builtWith: 'Built with',
      buildingIt: 'Building it',
      learned: 'What I learned',
      close: 'Close project details',
      screenshot: 'Show screenshot',
      prev: 'Previous screenshot',
      next: 'Next screenshot',
      gallery: 'Project screenshots',
      expand: 'View full size',
      closeZoom: 'Close full-size view',
    },
    about: {
      imageAlt:
        'Hand-drawn illustration of a developer at a desk beside a server tower and a monstera plant',
      paragraphs: [
        "I'm a full-stack developer who likes shipping things end to end: the interface, the API behind it, and the server it all runs on.",
        'Most of my work runs on React and TypeScript up front, with Python or Node.js behind it. I deploy on Vercel for frontends and run my own server for the always-on pieces.',
        "I've followed AI development closely since before ChatGPT, back in the text-davinci-002 days, and these days it's part of how I build. I lean on agent workflows and custom skills I write myself to move faster on whatever I'm working on, whatever the stack.",
        "More than any of that, I care about how things feel. Whatever I ship should look good and feel good to use, whether you're on a phone or a big screen.",
      ],
    },
    contact: {
      imageAlt: 'Hand-drawn illustration of a paper airplane looping over rounded hills',
      body: 'Open to interesting projects and good conversations about software.',
      chatTease: 'or boot the old machine and leave an anonymous message in the chat',
      footer: 'Alejandro Jiménez, Costa Rica',
      footerQuote: "There's always something to build",
      wreckAria: 'Boot AlejOS',
    },
    palette: {
      navigate: 'Navigate',
      projects: 'Projects',
      actions: 'Actions',
      top: 'Top',
      toggleTheme: 'Toggle theme',
      openTerminal: 'Open terminal',
      bootAlejOS: 'Boot AlejOS',
      desktopMode: 'desktop mode',
      sendEmail: 'Send an email',
      openGithub: 'Open GitHub profile',
      openLinkedin: 'Open LinkedIn profile',
      placeholder: 'Search projects, sections, actions',
      close: 'Close command palette',
      noMatches: 'Nothing matches',
    },
    versions: {
      full: {
        title: 'Look around',
        blurb: 'The whole thing, made to be explored.',
      },
      simple: {
        title: 'just the résumé',
        blurb: 'The short version, made to be skimmed.',
      },
    },
    chooser: {
      greeting: "Hey, I'm Alejandro.",
      lead: 'I built this two ways.',
      note: 'Switch whenever.',
      keep: 'Stay here',
      current: "You're here",
    },
    simple: {
      role: 'Full-stack developer',
      location: 'Costa Rica',
      skills: 'Skills',
      viewProject: 'View project',
      live: 'Live',
      back: 'Back to overview',
      otherVersion: 'See the other version',
    },
  },
  es: {
    localTime: 'Hora local en Costa Rica',
    nav: {
      work: 'Proyectos',
      experience: 'Experiencia',
      about: 'Sobre mí',
      contact: 'Contacto',
      backToTop: 'Volver arriba',
      openPalette: 'Abrir paleta de comandos',
      github: 'Perfil de GitHub',
      linkedin: 'Perfil de LinkedIn',
      switchLight: 'Cambiar a tema claro',
      switchDark: 'Cambiar a tema oscuro',
      language: 'Idioma',
      switchVersion: 'Cambiar versión',
    },
    hero: {
      fixName: 'arreglar mi nombre',
      intro:
        'Desarrollador full-stack de Costa Rica. Construyo aplicaciones web completas, desde el frontend en React hasta el servidor donde corren.',
      viewWork: 'Ver proyectos',
      flightHint: {
        desktop: 'wasd para volar\nshift impulso\nespacio derrape',
        touch: 'toca el avión para volar',
        joystick: 'Joystick de vuelo',
        boostAria: 'Impulso de velocidad',
        swoopAria: 'Derrape',
        boost: 'impulso',
        swoop: 'derrape',
      },
    },
    sections: {
      selectedWork: 'Proyectos destacados',
      moreProjects: 'Más proyectos',
      experience: 'Experiencia',
      about: 'Sobre mí',
      tools: 'Herramientas con las que he trabajado',
      contact: 'Hablemos',
      allRepositories: 'Todos los repositorios',
    },
    work: {
      viewDetails: 'Ver detalles de',
      source: 'Código',
    },
    modal: {
      builtWith: 'Construido con',
      buildingIt: 'Cómo lo construí',
      learned: 'Qué aprendí',
      close: 'Cerrar detalles del proyecto',
      screenshot: 'Mostrar captura',
      prev: 'Captura anterior',
      next: 'Captura siguiente',
      gallery: 'Capturas del proyecto',
      expand: 'Ver a tamaño completo',
      closeZoom: 'Cerrar vista a tamaño completo',
    },
    about: {
      imageAlt:
        'Ilustración dibujada a mano de un desarrollador en un escritorio junto a un servidor y una monstera',
      paragraphs: [
        'Soy un desarrollador full-stack al que le gusta construir las cosas completas: la interfaz, la API detrás y el servidor donde corre todo.',
        'Casi todo lo que hago usa React y TypeScript en el frontend, con Python o Node.js en el backend. Los frontends los despliego en Vercel, y tengo mi propio servidor para lo que necesita estar corriendo todo el tiempo.',
        'Sigo de cerca el desarrollo de la IA desde antes de ChatGPT, en la época de text-davinci-002, y hoy es parte de cómo construyo. Me apoyo en flujos de trabajo con agentes y en skills que yo mismo escribo para avanzar más rápido en lo que sea que esté haciendo, sin importar el stack.',
        'Pero más que todo eso, me importa cómo se siente lo que hago. Quiero que todo se vea bien y sea agradable de usar, igual en el teléfono que en una pantalla grande.',
      ],
    },
    contact: {
      imageAlt: 'Ilustración dibujada a mano de un avión de papel sobre colinas redondeadas',
      body: 'Abierto a proyectos interesantes y buenas conversaciones sobre software.',
      chatTease: 'o enciende la compu vieja y deja un mensaje anónimo en el chat',
      footer: 'Alejandro Jiménez, Costa Rica',
      footerQuote: 'Siempre hay algo que construir',
      wreckAria: 'Iniciar AlejOS',
    },
    palette: {
      navigate: 'Navegar',
      projects: 'Proyectos',
      actions: 'Acciones',
      top: 'Inicio',
      toggleTheme: 'Cambiar tema',
      openTerminal: 'Abrir terminal',
      bootAlejOS: 'Iniciar AlejOS',
      desktopMode: 'modo escritorio',
      sendEmail: 'Enviar correo',
      openGithub: 'Abrir perfil de GitHub',
      openLinkedin: 'Abrir perfil de LinkedIn',
      placeholder: 'Buscar proyectos, secciones, acciones',
      close: 'Cerrar paleta de comandos',
      noMatches: 'Sin resultados para',
    },
    versions: {
      full: {
        title: 'Date una vuelta',
        blurb: 'Todo el sitio, hecho para explorarse.',
      },
      simple: {
        title: 'solo el cv',
        blurb: 'La versión corta, hecha para hojearse.',
      },
    },
    chooser: {
      greeting: 'Hola, soy Alejandro.',
      lead: 'Hice esto de dos formas.',
      note: 'Cambia cuando quieras.',
      keep: 'Me quedo aquí',
      current: 'Estás aquí',
    },
    simple: {
      role: 'Desarrollador full-stack',
      location: 'Costa Rica',
      skills: 'Habilidades',
      viewProject: 'Ver proyecto',
      live: 'En vivo',
      back: 'Volver al inicio',
      otherVersion: 'Ver la otra versión',
    },
  },
}

type Dictionary = typeof dictionaries.en

const showcaseEs: Record<string, Partial<ShowcaseProject> & { details: Partial<ShowcaseProject['details']> }> = {
  'Live Score Tracker': {
    description:
      'Rankings por país, mejores jugadas y un visor de repeticiones para osu!mania, un juego de ritmo competitivo, además de un feed en vivo que transmite los puntajes apenas se registran. El frontend usa TanStack Start, y detrás hay un servicio en Node que procesa los puntajes y manda las actualizaciones al navegador por SSE.',
    imageAlt: 'Panel principal con rankings por país, mejores jugadas recientes y un feed de puntajes en vivo',
    details: {
      story: [
        'Live Score Tracker sigue la escena competitiva de un juego de ritmo: quién sube en los rankings, quién acaba de hacer una gran jugada y qué está jugando la comunidad. El frontend está hecho con TanStack Start, y detrás hay un servicio en Node siempre encendido que hace el trabajo pesado.',
        'Lo más interesante fue el pipeline en tiempo real. El servicio recibe los puntajes desde un feed de la comunidad, los guarda en SQLite y maneja el enriquecimiento de datos, las tablas de posiciones y el renderizado de repeticiones con una cola de trabajos sobre esa misma base de datos. El navegador carga una foto inicial del estado y se suscribe a un stream de Server-Sent Events, y si la conexión se cae, el cliente recupera exactamente los eventos que se perdió.',
        'El frontend corre en Vercel, y el servicio en vivo con su base de datos vive en un VPS de Hetzner que yo administro, con Caddy al frente y varias capas de caché entre la API externa y el navegador para que las páginas se mantengan rápidas sin gastarse las cuotas.',
      ],
      learned: [
        'Transmitir actualizaciones en vivo con SSE y recuperar los eventos perdidos al reconectar',
        'Construir una cola de trabajos durable sobre SQLite sin infraestructura extra',
        'Configurar y administrar un VPS de producción en Hetzner con Caddy como proxy inverso',
        'Combinar capas de caché con un limitador token-bucket para mantener la app rápida sin agotar las cuotas de la API',
      ],
      gallery: [
        {
          src: '/projects/mania-hub.png',
          alt: 'Panel principal con rankings por país, mejores jugadas recientes y un feed de puntajes en vivo',
          caption: 'El panel principal con rankings, mejores jugadas recientes y el feed de puntajes en vivo.',
        },
        {
          src: '/projects/mania-live-2.png',
          alt: 'Tabla de rankings por país con estadísticas de jugadores y movimiento de posiciones',
          caption: 'Rankings por país con movimiento semanal.',
        },
        {
          src: '/projects/tracker.png',
          alt: 'Feed del tracker en vivo con muchas actualizaciones de puntajes recientes',
          caption: 'El tracker en vivo, transmitiendo jugadas al navegador conforme llegan.',
        },
        {
          src: '/projects/mania-replay.png',
          alt: 'Visor de repeticiones renderizando una jugada con notas y juicios',
          caption: 'El visor de repeticiones renderizando un archivo de replay parseado con skins personalizadas.',
        },
      ],
    },
  },
  'Wallpaper Archive': {
    description:
      'Explora, descarga y rankea wallpapers. En el modo Arena eliges entre dos fondos y cada voto actualiza el ranking. Una API en Fastify guarda los rankings en Turso y sirve las imágenes desde Cloudflare R2.',
    imageAlt: 'Galería de Wallpaper Archive',
    details: {
      story: [
        'Empezó como una forma más rápida de ver y descargar wallpapers para mi propio uso, y terminó convirtiéndose en una galería pública con un modo Arena, donde dos fondos compiten y un rating Elo decide cuáles son los mejores de todos los tiempos.',
        'La mayor parte del trabajo real está en el pipeline de imágenes. A cada wallpaper se le generan miniaturas, se le extraen metadatos y se revisa por hash que no esté repetido, para que la misma imagen sacada de dos fuentes distintas aparezca solo una vez. Una API en Fastify guarda los rankings y metadatos en Turso, y los originales se sirven desde Cloudflare R2.',
        'También hay un panel de administración privado desde el que manejo todo el archivo, con un dashboard de almacenamiento, un cargador que importa desde archivos locales o un repo de GitHub, un buscador de duplicados que usa esos mismos hashes de imagen, y estadísticas de cada proveedor, resolución y carpeta de la colección.',
      ],
      learned: [
        'Servir miles de imágenes de forma barata desde object storage',
        'Usar SQLite en el edge con Turso y hacer que una app real quepa en planes gratuitos',
        'Detectar imágenes duplicadas con hashing en vez de comparar píxeles',
      ],
      gallery: [
        {
          src: '/projects/wallpaper-archive.png',
          alt: 'Galería de Wallpaper Archive',
          caption: 'Explorando la colección con filtros por proveedor y resolución.',
        },
        {
          src: '/projects/wallpaper-arena.png',
          alt: 'Modo Arena con dos wallpapers compitiendo',
          caption: 'Modo Arena, donde elegir el mejor wallpaper alimenta los ratings Elo.',
        },
        {
          src: '/projects/wallpaper-leaderboard.png',
          alt: 'Tabla de campeones de Arena ordenada por rating Elo',
          caption: 'Campeones de Arena, ordenados por rating, batallas y porcentaje de victorias.',
        },
      ],
      extra: {
        label: 'El panel de administración',
        gallery: [
          {
            src: '/projects/wallpaper-admin.png',
            alt: 'Dashboard de administración con estadísticas de la colección y los archivos más pesados',
            caption: 'El dashboard, siguiendo el almacenamiento y los archivos más pesados de la colección.',
          },
          {
            src: '/projects/wallpaper-admin-upload.png',
            alt: 'Pantalla de carga importando wallpapers desde archivos locales o GitHub',
            caption: 'El cargador, importando wallpapers nuevos desde archivos locales o un repo de GitHub.',
          },
          {
            src: '/projects/wallpaper-admin-duplicates.png',
            alt: 'Buscador de duplicados agrupando wallpapers casi idénticos por similitud',
            caption: 'El buscador de duplicados, agrupando imágenes casi idénticas por similitud de hash.',
          },
          {
            src: '/projects/wallpaper-admin-stats.png',
            alt: 'Estadísticas desglosadas por proveedor, categoría, resolución y tamaño de archivo',
            caption: 'Estadísticas de la colección, desglosadas por proveedor, categoría, resolución y tamaño.',
          },
        ],
      },
    },
  },
  HealthFlow: {
    description:
      'Dashboard personal de salud para registrar peso, composición corporal, hidratación, pasos y ejercicio, con vistas históricas y resúmenes por periodo.',
    imageAlt: 'Dashboard histórico de HealthFlow con métricas de salud',
    details: {
      story: [
        'Un dashboard personal de salud para peso, composición corporal, hidratación, pasos y ejercicio, con vistas históricas y resúmenes por periodo. Fue mi primera vez poniendo un backend en Python detrás de un frontend en React.',
        'FastAPI resultó ser un excelente primer framework de API, pero lo que más me enseñó fue el modelo de datos. Necesitaba cuentas reales con registro e inicio de sesión, además de años de métricas diarias bien estructuradas para que las vistas históricas y los resúmenes cargaran rápido. En el frontend usé shadcn/ui y animaciones para que un dashboard CRUD se sintiera pulido y no frío.',
      ],
      learned: [
        'Diseñar y documentar una API REST con FastAPI',
        'Modelar una base de datos relacional desde cero, con autenticación real incluida',
        'Pulir una interfaz cargada de datos con shadcn/ui, Recharts y motion',
      ],
      gallery: [
        {
          src: '/projects/healthflow.png',
          alt: 'Dashboard histórico de HealthFlow con métricas de salud',
          caption: 'La vista histórica, resumiendo cada métrica por periodo con deltas de tendencia.',
        },
        {
          src: '/projects/healthflow-2.png',
          alt: 'Dashboard principal de HealthFlow con composición corporal y metas diarias',
          caption: 'El dashboard principal con composición corporal, metas diarias y actividad.',
        },
        {
          src: '/projects/healthflow-4.png',
          alt: 'Vista histórica detallada con gráficas por métrica',
          caption: 'Historial detallado con gráficas por métrica.',
        },
        {
          src: '/projects/healthflow-5.png',
          alt: 'Asistente de importación de datos con tipos seleccionables',
          caption: 'El asistente de importación de datos.',
        },
      ],
    },
  },
  'Pokémon TCG Searcher': {
    description:
      'App Android para buscar cartas Pokémon, explorar sets y revisar precios de mercado, construida sobre la API de pokemontcg.io.',
    imageAlt: 'Pantalla de búsqueda de cartas de Pokémon TCG Searcher',
    details: {
      story: [
        'Sí, otra app de Pokémon, ya sé. Tarde o temprano todo desarrollador hace una, y la mía además fue mi primera app móvil, construida con Flutter para un curso universitario. Permite buscar cualquier carta, explorar sets y revisar precios de mercado usando la API pública de Pokémon TCG.',
        'Viniendo del mundo web, el árbol de widgets de Flutter y el manejo de estado con Provider me obligaron a pensar distinto. Pasé la mayor parte del tiempo optimizando el uso de la API: pedir solo los campos que cada pantalla necesita y paginar los resultados para que la app se mantuviera rápida con datos móviles. Y el inicio de sesión con Google a través de Firebase me hizo pelear con toda la configuración de OAuth, huellas SHA-1 incluidas.',
      ],
      learned: [
        'Fundamentos de Flutter y Dart, desde el árbol de widgets hasta navegación y datos asíncronos',
        'Tratar las llamadas a la API como un presupuesto: pedir solo los campos necesarios, paginar y hacer menos llamadas',
        'Configurar Google OAuth con Firebase Auth en Android',
        'Definir el alcance y entregar una app real con la fecha límite de un curso',
      ],
      gallery: [
        {
          src: '/projects/pokemon-tcg.png',
          alt: 'Pantalla de búsqueda de cartas de Pokémon TCG Searcher',
          caption: 'Búsqueda de cartas con ordenamiento por precio.',
        },
        {
          src: '/projects/poketcg-details.png',
          alt: 'Pantalla de detalles de carta con estadísticas y ataques',
          caption: 'Detalles de carta con estadísticas, ataques y precio de mercado.',
        },
        {
          src: '/projects/poketcg-market.png',
          alt: 'Vista de mercado con cartas ordenadas por precio',
          caption: 'La vista de mercado, donde cada carta se ordena por precio.',
        },
        {
          src: '/projects/poketcg-sets.png',
          alt: 'Explorador de sets agrupados por serie',
          caption: 'Explorando sets agrupados por serie.',
        },
      ],
    },
  },
  Aula: {
    description:
      'App móvil para escuelas donde docentes crean tareas, envían mensajes y administran grupos, con interfaces separadas para docentes y administradores.',
    imageAlt: 'Pantalla principal docente de Aula con resumen de grupos',
    details: {
      story: [
        'Aula permite que docentes y administradores escolares manejen sus clases desde el teléfono. Los docentes crean tareas con archivos adjuntos y fechas límite, envían mensajes a estudiantes y dan seguimiento a sus grupos, mientras los administradores supervisan los grupos de toda la institución. Dependiendo de quién inicie sesión, la app muestra pantallas distintas.',
        'Corre en React Native con Expo, con Firebase como backend. Lo que más me enseñó fueron los datos y el estado. Del lado de los datos tuve que decidir cómo organizar todo en Firestore, qué colecciones crear y cómo se relacionan tareas, grupos y mensajes. Del lado del estado, Redux Toolkit mantiene en un solo lugar al usuario autenticado, su rol y los datos que cada pantalla necesita, para que todo se mantenga sincronizado al moverse por la app.',
      ],
      learned: [
        'Manejar estado global con Redux Toolkit, desde el usuario autenticado y su rol hasta los datos de cada pantalla',
        'Organizar datos en Firestore, eligiendo colecciones y referencias entre documentos',
        'Mostrar skeleton placeholders mientras cargan los datos, la primera vez que usé ese patrón en lugar de un spinner',
        'Dividir una app en dos experiencias por rol con Expo Router',
        'Construir una interfaz móvil limpia con React Native Paper',
      ],
      gallery: [
        {
          src: '/projects/aula-2.png',
          alt: 'Pantalla principal docente de Aula con resumen de grupos',
          caption: 'La pantalla principal docente, resumiendo grupos y miembros de un vistazo.',
        },
        {
          src: '/projects/aula-3.png',
          alt: 'Formulario para crear tareas con archivo adjunto y etapas',
          caption: 'Creando una tarea con archivo adjunto, fecha límite y etapas.',
        },
        {
          src: '/projects/aula-4.png',
          alt: 'Bandeja de mensajes con pestañas de recibidos y enviados',
          caption: 'La mensajería interna entre docentes y estudiantes.',
        },
        {
          src: '/projects/aula.png',
          alt: 'Pantalla de inicio de sesión con ilustración escolar',
          caption: 'Inicio de sesión con el ID de estudiante o docente asignado por la institución.',
        },
      ],
    },
  },
}

const secondaryEs: Record<string, Partial<SecondaryProject>> = {
  SnakeDocker: {
    description:
      'Snake multijugador con procesamiento distribuido: workers especializados en Docker, balanceo dinámico de carga y juego por WebSockets.',
    imageAlt: 'Logotipo de SnakeDocker',
  },
  DocIndexer: {
    description:
      'Indexación y búsqueda distribuida de documentos: un coordinador en FastAPI reparte el procesamiento de texto entre workers usando colas de Redis.',
    imageAlt: 'Marca de DocIndexer',
  },
}

const moreEs: Record<string, Partial<SmallProject>> = {
  'aleju03.github.io': {
    description: 'Este portafolio, con un hero 3D, una terminal y un pequeño OS escondido dentro.',
  },
  WebNBA: {
    description: 'Explorador de partidos y estadísticas de NBA construido con React.',
  },
  'admin-dashboard': {
    description: 'Dashboard administrativo construido con React.',
  },
}

function mergeGallery(source: GalleryImage[], override?: GalleryImage[]) {
  if (!override) return source
  return source.map((image, i) => ({ ...image, ...override[i] }))
}

function localizeShowcase(language: Language) {
  if (language === 'en') return showcase
  return showcase.map((project) => {
    const translation = showcaseEs[project.name]
    if (!translation) return project
    return {
      ...project,
      ...translation,
      details: {
        ...project.details,
        ...translation.details,
        gallery: mergeGallery(project.details.gallery, translation.details.gallery),
        extra: project.details.extra && {
          ...project.details.extra,
          ...translation.details.extra,
          gallery: mergeGallery(
            project.details.extra.gallery,
            translation.details.extra?.gallery,
          ),
        },
      },
    }
  })
}

function localizeSecondary(language: Language) {
  if (language === 'en') return secondary
  return secondary.map((project) => ({ ...project, ...secondaryEs[project.name] }))
}

function localizeMore(language: Language) {
  if (language === 'en') return more
  return more.map((project) => ({ ...project, ...moreEs[project.name] }))
}

interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: Dictionary
  projects: {
    showcase: ShowcaseProject[]
    secondary: SecondaryProject[]
    more: SmallProject[]
  }
}

const I18nContext = createContext<I18nValue | null>(null)

function readInitialLanguage(): Language {
  if (typeof localStorage === 'undefined') return 'en'
  return localStorage.getItem(STORAGE_KEY) === 'es' ? 'es' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(readInitialLanguage)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language)
    document.documentElement.lang = language
  }, [language])

  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      t: dictionaries[language],
      projects: {
        showcase: localizeShowcase(language),
        secondary: localizeSecondary(language),
        more: localizeMore(language),
      },
    }),
    [language],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider')
  return context
}
