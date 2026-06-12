import {
  ArrowSquareOutIcon,
  GithubLogoIcon,
  FolderIcon,
} from '@phosphor-icons/react'
import { showcase, secondary, more, github, linkedin, email } from '../../data/projects'
import { sounds } from './sounds'

/*
  The AlejOS apps themselves: explorer, notepad, mail composer. They lean
  into the early-2000s chrome (address bar, menu bar, inset fields) without
  copying any real OS pixel for pixel. The registry lives in apps.tsx.
*/

interface ProjectRow {
  name: string
  description: string
  live?: string
  repo: string
}

const allProjects: ProjectRow[] = [...showcase, ...secondary, ...more].map((p) => ({
  name: p.name,
  description: p.description,
  live: (p as { live?: string }).live,
  repo: p.repo,
}))

const inset =
  'rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

export function ProjectsApp() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-stone-300 bg-stone-200 px-3 py-2">
        <span className="text-xs text-stone-500">Address</span>
        <p className={`${inset} flex-1 font-mono`}>C:\Aleju\Projects</p>
      </div>
      <ul className="flex-1 overflow-y-auto bg-white p-1.5">
        {allProjects.map((p) => {
          const url = p.live ?? p.repo
          return (
            <li key={p.repo}>
              <div className="group flex w-full items-center gap-3 rounded-sm px-2.5 py-2 hover:bg-blue-600/10">
                <FolderIcon size={26} weight="duotone" className="shrink-0 text-blue-600" />
                <button
                  type="button"
                  onClick={() => {
                    sounds.open()
                    window.open(url, '_blank', 'noreferrer')
                  }}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                >
                  <p className="truncate text-sm font-medium text-stone-800">{p.name}</p>
                  <p className="truncate text-xs text-stone-500">{p.description}</p>
                </button>
                <span className="flex shrink-0 items-center gap-3 font-mono text-xs">
                  {p.live && (
                    <a
                      href={p.live}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-blue-700 hover:underline"
                    >
                      <ArrowSquareOutIcon size={13} />
                      live
                    </a>
                  )}
                  <a
                    href={p.repo}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-stone-500 hover:text-stone-800 hover:underline"
                  >
                    <GithubLogoIcon size={13} />
                    repo
                  </a>
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="border-t border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-500">
        {allProjects.length} objects
      </p>
    </div>
  )
}

export function AboutApp() {
  const link = 'text-blue-700 underline decoration-dotted underline-offset-2 hover:text-blue-800'
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-4 border-b border-stone-300 bg-stone-200 px-3 py-1 text-xs text-stone-600 select-none">
        <span>File</span>
        <span>Edit</span>
        <span>Format</span>
        <span>Help</span>
      </div>
      <div className="flex-1 overflow-y-auto bg-white p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-stone-800">
        {`Alejandro Jiménez
full-stack developer — Costa Rica

I build web apps end to end: React frontends, Node
backends, and the server they run on. I deploy on
Vercel for frontends and run my own server for the
always-on pieces.

stack
  react · typescript · node · python · docker · caddy

links
  github   → `}
        <a href={github} target="_blank" rel="noreferrer" className={link}>
          github.com/aleju03
        </a>
        {`
  linkedin → `}
        <a href={linkedin} target="_blank" rel="noreferrer" className={link}>
          alejandro-jiménez-ulloa
        </a>
        {`
  email    → `}
        <a href={`mailto:${email}`} className={link}>
          {email}
        </a>
      </div>
    </div>
  )
}

export function ContactApp() {
  const field = `${inset} w-full focus-visible:border-blue-600`
  return (
    <form
      className="flex h-full flex-col gap-3 bg-stone-100 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        const subject = encodeURIComponent(String(data.get('subject') ?? ''))
        const body = encodeURIComponent(String(data.get('body') ?? ''))
        sounds.open()
        location.href = `mailto:${email}?subject=${subject}&body=${body}`
      }}
    >
      <label className="flex items-center gap-3 text-xs text-stone-600">
        <span className="w-14">To</span>
        <input readOnly value={email} aria-label="To" className={`${field} bg-stone-50`} tabIndex={-1} />
      </label>
      <label className="flex items-center gap-3 text-xs text-stone-600">
        <span className="w-14">Subject</span>
        <input
          name="subject"
          data-no-focus-ring
          defaultValue="Hey Alejandro"
          aria-label="Subject"
          className={field}
        />
      </label>
      <textarea
        name="body"
        data-no-focus-ring
        placeholder="Write your message..."
        aria-label="Message"
        className={`${field} min-h-0 flex-1 resize-none py-2`}
      />
      <div className="flex justify-end">
        <button
          type="submit"
          className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-5 py-1.5 text-xs font-medium text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}

