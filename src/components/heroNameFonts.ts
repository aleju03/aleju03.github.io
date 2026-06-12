export type HeroNameFontId = 'clash' | 'helvetiker' | 'optimer' | 'mono'

export interface HeroNameFontPreset {
  id: HeroNameFontId
  label: string
  typeface: string
  staticFontFamily: string
  size: number
  gap: number
  lineSpacing: number
  accent: {
    width: number
    height: number
    x: number
    y: number
    rotation: number
  }
}

export const HERO_NAME_FONTS: Record<HeroNameFontId, HeroNameFontPreset> = {
  clash: {
    id: 'clash',
    label: 'Clash',
    typeface: '/fonts/clash-display-semibold.typeface.json',
    staticFontFamily: "'Clash Display', 'Geist Variable', ui-sans-serif, system-ui, sans-serif",
    size: 5,
    gap: 1.1,
    lineSpacing: 5.4,
    accent: { width: 1.7, height: 0.65, x: 0.3, y: 0.85, rotation: 0.5 },
  },
  helvetiker: {
    id: 'helvetiker',
    label: 'Helvetiker',
    typeface: '/fonts/helvetiker_bold.typeface.json',
    staticFontFamily: "'Arial Black', Impact, 'Geist Variable', ui-sans-serif, system-ui, sans-serif",
    size: 5,
    gap: 0.9,
    lineSpacing: 7.1,
    accent: { width: 1.65, height: 0.62, x: 0.25, y: 1.05, rotation: 0.5 },
  },
  optimer: {
    id: 'optimer',
    label: 'Optimer',
    typeface: '/fonts/optimer_bold.typeface.json',
    staticFontFamily: "Georgia, 'Times New Roman', serif",
    size: 5,
    gap: 0.75,
    lineSpacing: 7.3,
    accent: { width: 1.55, height: 0.58, x: 0.22, y: 1.0, rotation: 0.48 },
  },
  mono: {
    id: 'mono',
    label: 'Mono',
    typeface: '/fonts/droid_sans_mono_regular.typeface.json',
    staticFontFamily:
      "'Geist Mono Variable', 'SFMono-Regular', Consolas, 'Liberation Mono', ui-monospace, monospace",
    size: 5,
    gap: 0.45,
    lineSpacing: 6.9,
    accent: { width: 1.45, height: 0.5, x: 0.2, y: 0.85, rotation: 0.48 },
  },
}

const DEFAULT_HERO_NAME_FONT_ID: HeroNameFontId = 'optimer'

function isHeroNameFontId(value: string | null): value is HeroNameFontId {
  return value === 'clash' || value === 'helvetiker' || value === 'optimer' || value === 'mono'
}

export function getHeroNameFontPreset() {
  if (typeof window === 'undefined') return HERO_NAME_FONTS[DEFAULT_HERO_NAME_FONT_ID]

  const fontId = new URLSearchParams(window.location.search).get('nameFont')
  return HERO_NAME_FONTS[isHeroNameFontId(fontId) ? fontId : DEFAULT_HERO_NAME_FONT_ID]
}
