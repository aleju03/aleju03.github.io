import type { Language } from '../i18n'

export interface Stop {
  org: string
  role: string
  period: string
  detail: string
  url: string
  /** 'full' fills the tile edge to edge, for marks with their own background baked in */
  logo: { src: string; alt: string; tile: 'light' | 'dark' | 'full' }
  poweredByClaude?: boolean
  translations?: Partial<Record<Language, Pick<Stop, 'role' | 'period' | 'detail'>>>
}

/** career/study stops, shared by the full Experience section and the simple résumé */
export const STOPS: Stop[] = [
  {
    org: 'Tecnológico de Costa Rica',
    role: 'Computer Engineering student',
    period: '2021 - present',
    detail: 'Studying at the San Carlos campus, graduating in October 2026.',
    url: 'https://www.tec.ac.cr',
    logo: { src: '/experience/tec.png', alt: 'Tecnológico de Costa Rica logo', tile: 'light' },
    translations: {
      es: {
        role: 'Estudiante de Ingeniería en Computación',
        period: '2021 - presente',
        detail: 'Estudiando en la sede San Carlos, con graduación prevista para octubre de 2026.',
      },
    },
  },
  {
    org: 'Hackathon 4.0 COL-CR',
    role: 'Participant',
    period: 'May 2024',
    detail: 'International hackathon held with Universidad Javeriana in Colombia.',
    url: 'https://ingenieria.javeriana.edu.co/hackathon',
    logo: { src: '/experience/hackathon.png', alt: 'Hackathon 4.0 COL-CR logo', tile: 'light' },
    translations: {
      es: {
        role: 'Participante',
        period: 'Mayo 2024',
        detail: 'Hackathon internacional realizado con la Universidad Javeriana en Colombia.',
      },
    },
  },
  {
    org: 'Bufost',
    role: 'Software development intern',
    period: 'Oct - Nov 2025',
    detail:
      'Contributed to a Next.js and Firebase app, mostly the admin authentication, dashboard, and navigation, plus route and session security, following SOLID principles.',
    url: 'https://www.bufost.com',
    logo: { src: '/experience/bufost.png', alt: 'Bufost logo', tile: 'full' },
    translations: {
      es: {
        role: 'Practicante de desarrollo de software',
        period: 'Oct - Nov 2025',
        detail:
          'Colaboré en una app en Next.js y Firebase, sobre todo en la autenticación, el panel de administración y la navegación, además de la seguridad de rutas y sesiones, siguiendo los principios SOLID.',
      },
    },
  },
  {
    org: 'Bitcode Enterprise',
    role: 'Professional practice',
    period: 'Feb - Jun 2026',
    detail: 'Contributed to an internal app for managing their clients and developers.',
    url: 'https://bitcode-enterprise.com',
    logo: { src: '/experience/bitcode.svg', alt: 'Bitcode Enterprise logo', tile: 'dark' },
    poweredByClaude: true,
    translations: {
      es: {
        role: 'Práctica profesional',
        period: 'Feb - Jun 2026',
        detail: 'Colaboré en una app interna para administrar sus clientes y desarrolladores.',
      },
    },
  },
]
