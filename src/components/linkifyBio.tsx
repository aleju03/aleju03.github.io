import type { ReactNode } from 'react'

// The bio mentions one model name that not everyone will recognize. We render
// the paragraphs as plain strings everywhere, so this wraps just that term in a
// context link at render time instead of baking markup into the i18n strings.
const TERM = 'text-davinci-002'
const HREF = 'https://en.wikipedia.org/wiki/GPT-3'

const linkClass =
  'underline decoration-dotted decoration-stone-400 underline-offset-2 transition-colors hover:text-stone-900 dark:decoration-stone-600 dark:hover:text-stone-100'

export function linkifyBio(text: string): ReactNode {
  const idx = text.indexOf(TERM)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <a href={HREF} target="_blank" rel="noreferrer" className={linkClass}>
        {TERM}
      </a>
      {text.slice(idx + TERM.length)}
    </>
  )
}
