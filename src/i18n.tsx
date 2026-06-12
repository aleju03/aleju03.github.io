/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { showcase, secondary, more } from './data/projects'
import type { GalleryImage, SecondaryProject, ShowcaseProject, SmallProject } from './data/projects'

export type Language = 'en' | 'es'

const STORAGE_KEY = 'portfolio-language'

const dictionaries = {
  en: {
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
    },
    hero: {
      fixName: 'fix my name',
      intro:
        'Full-stack developer from Costa Rica. I build web apps end to end, from React frontends to the servers behind them.',
      viewWork: 'View work',
    },
    sections: {
      selectedWork: 'Selected work',
      moreProjects: 'More projects',
      experience: 'Experience',
      about: 'About',
      tools: 'Tools I work with',
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
    },
    about: {
      imageAlt:
        'Hand-drawn illustration of a developer at a desk beside a server tower and a monstera plant',
      paragraphs: [
        "I'm a full-stack developer who likes shipping things end to end: the interface, the API behind it, and the server it all runs on.",
        'Most of my work runs on React and TypeScript up front, with Python or Node.js behind it. I deploy on Vercel for frontends and run my own server for the always-on pieces.',
      ],
    },
    contact: {
      imageAlt: 'Hand-drawn illustration of a paper airplane looping over rounded hills',
      body: 'Open to interesting projects and good conversations about software.',
      footer: 'Alejandro Jiménez, Costa Rica',
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
  },
  es: {
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
    },
    hero: {
      fixName: 'arreglar mi nombre',
      intro:
        'Desarrollador full-stack de Costa Rica. Construyo aplicaciones web de punta a punta, desde frontends en React hasta los servidores que las sostienen.',
      viewWork: 'Ver proyectos',
    },
    sections: {
      selectedWork: 'Proyectos destacados',
      moreProjects: 'Más proyectos',
      experience: 'Experiencia',
      about: 'Sobre mí',
      tools: 'Herramientas que uso',
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
    },
    about: {
      imageAlt:
        'Ilustración dibujada a mano de un desarrollador en un escritorio junto a un servidor y una monstera',
      paragraphs: [
        'Soy un desarrollador full-stack al que le gusta lanzar productos completos: la interfaz, la API detrás de ella y el servidor donde todo corre.',
        'La mayoría de mi trabajo usa React y TypeScript en el frontend, con Python o Node.js en el backend. Despliego frontends en Vercel y administro mi propio servidor para las piezas que siempre deben estar encendidas.',
      ],
    },
    contact: {
      imageAlt: 'Ilustración dibujada a mano de un avión de papel sobre colinas redondeadas',
      body: 'Abierto a proyectos interesantes y buenas conversaciones sobre software.',
      footer: 'Alejandro Jiménez, Costa Rica',
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
  },
}

type Dictionary = typeof dictionaries.en

const showcaseEs: Record<string, Partial<ShowcaseProject> & { details: Partial<ShowcaseProject['details']> }> = {
  'Mania Tracker': {
    description:
      'Rankings por país, seguimiento de puntajes en vivo, mejores jugadas y visor de repeticiones para osu!mania. Un frontend con TanStack Start y un servicio Node que ingiere puntajes y transmite actualizaciones al navegador por SSE.',
    imageAlt: 'Panel principal de Mania Tracker con rankings y puntajes en vivo',
    details: {
      story: [
        'Mania Tracker sigue la escena competitiva de un juego de ritmo: quién sube en los rankings, quién acaba de hacer una gran jugada y qué está jugando la comunidad. Un frontend con TanStack Start vive encima de un servicio Node siempre activo que hace el trabajo pesado.',
        'Los problemas interesantes estuvieron en el pipeline en tiempo real. El servicio ingiere puntajes desde un feed comunitario, mantiene proyecciones durables en SQLite y empuja enriquecimiento, tablas de líderes y renderizado de repeticiones a través de una cola de trabajos respaldada por la base de datos. El navegador obtiene una fotografía inicial y se suscribe a un stream de Server-Sent Events; si la conexión cae, el cliente reproduce exactamente los eventos que se perdió.',
        'El frontend corre en Vercel, mientras el servicio en vivo y su base de datos viven en un VPS de Hetzner que administro, con Caddy al frente y varias capas de caché entre la API externa y el navegador para que las páginas sigan rápidas sin gastar las cuotas.',
      ],
      learned: [
        'Transmitir actualizaciones en vivo con SSE y reproducir eventos perdidos al reconectar',
        'Construir una cola de trabajos durable sobre SQLite sin infraestructura extra',
        'Provisionar y operar un VPS de producción en Hetzner con Caddy como proxy inverso',
        'Combinar capas de caché y un limitador token-bucket para mantener la app rápida sin agotar cuotas de API',
      ],
      gallery: [
        {
          src: '/projects/mania-hub.png',
          alt: 'Panel principal de Mania Tracker con rankings y puntajes en vivo',
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
      'Explora, descarga y rankea wallpapers, con un modo Arena donde votos cara a cara deciden los mejores fondos. Una API en Fastify guarda rankings en Turso y sirve imágenes desde Cloudflare R2.',
    imageAlt: 'Galería de Wallpaper Archive',
    details: {
      story: [
        'Empezó como una forma más rápida de explorar y descargar wallpapers para mí, y creció hasta convertirse en una galería pública con modo Arena, donde dos fondos compiten y un rating Elo decide los mejores de todos los tiempos.',
        'La mayor parte del trabajo real está en el pipeline de imágenes. Cada wallpaper recibe miniaturas, metadatos extraídos y una revisión de duplicados por hash, para que una misma imagen tomada de dos fuentes aparezca solo una vez. Una API en Fastify mantiene rankings y metadatos en Turso mientras los originales se sirven desde Cloudflare R2.',
      ],
      learned: [
        'Servir miles de imágenes de forma barata desde object storage',
        'Usar SQLite en el edge con Turso y exprimir una app real dentro de free tiers',
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
    },
  },
  HealthFlow: {
    description:
      'Dashboard personal de salud para registrar peso, composición corporal, hidratación, pasos y ejercicio, con vistas históricas y resúmenes por periodo.',
    imageAlt: 'Dashboard histórico de HealthFlow con métricas de salud',
    details: {
      story: [
        'Un dashboard personal de salud para peso, composición corporal, hidratación, pasos y ejercicio, con vistas históricas y resúmenes por periodo. Fue mi primera vez poniendo un backend en Python detrás de un frontend en React.',
        'FastAPI resultó ser un excelente primer framework de API, pero la parte que más me enseñó fue el modelo de datos. Necesitaba cuentas reales con registro e inicio de sesión, además de años de métricas diarias estructuradas para que las vistas históricas y los resúmenes fueran rápidos. En el frontend usé shadcn/ui y animación para que un dashboard CRUD se sintiera pulido en lugar de clínico.',
      ],
      learned: [
        'Diseñar y documentar una API REST con FastAPI',
        'Modelar una base de datos relacional desde cero, con autenticación real encima',
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
        'Mi primera app móvil, construida con Flutter para un curso universitario. Permite buscar cualquier carta, explorar sets y revisar precios de mercado usando la API pública de Pokémon TCG.',
        'Viniendo de web, el árbol de widgets de Flutter y el estado con Provider fueron un cambio mental fuerte. Pasé la mayor parte del tiempo optimizando el uso de la API: pidiendo solo los campos que cada pantalla necesitaba y paginando resultados para que la app siguiera rápida en una conexión móvil. El inicio de sesión con Google por Firebase me enseñó las alegrías de configurar OAuth, huellas SHA-1 incluidas.',
      ],
      learned: [
        'Fundamentos de Flutter y Dart, desde el árbol de widgets hasta navegación y datos asíncronos',
        'Tratar las llamadas a API como un presupuesto: seleccionar campos, paginar y reducir viajes',
        'Configurar Google OAuth con Firebase Auth en Android',
        'Acotar y entregar una app real con fecha límite de curso',
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
        'Aula permite que docentes y administradores escolares manejen sus clases desde el teléfono. Los docentes crean tareas con archivos adjuntos y fechas límite, envían mensajes a estudiantes y dan seguimiento a sus grupos, mientras los administradores supervisan grupos de toda la institución. Según quién inicia sesión, la app muestra un conjunto distinto de pantallas.',
        'Corre en React Native con Expo, con Firebase como backend. Las dos cosas que más me enseñaron fueron los datos y el estado. En los datos tuve que definir cómo organizar todo en Firestore, qué colecciones crear y cómo tareas, grupos y mensajes se relacionan. En el estado, Redux Toolkit mantiene en un solo lugar el usuario autenticado, su rol y los datos que cada pantalla necesita, para que todo siga sincronizado al moverse por la app.',
      ],
      learned: [
        'Manejar estado global con Redux Toolkit, desde el usuario autenticado y su rol hasta los datos de cada pantalla',
        'Organizar datos en Firestore, eligiendo colecciones y referencias entre documentos',
        'Mostrar skeleton placeholders mientras cargan datos, mi primera vez usando ese patrón en lugar de un spinner',
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
      'Indexación y búsqueda distribuida de documentos: un coordinador en FastAPI reparte procesamiento de texto a workers mediante colas Redis.',
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
