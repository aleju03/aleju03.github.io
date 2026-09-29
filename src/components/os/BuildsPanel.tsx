import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { menuTick } from '../../game/core/sfx'
import { clipboard, type SlotInfo } from '../../game/sandbox/blueprint/clipboard'
import { useI18n } from '../../i18n'
import { builds, errorText, gallery, galleryAvailable, type GalleryEntry, type GalleryPage } from './buildsStore'

/*
  The builds book: the catalogue's last section, and where a machine you built
  is kept, sent to a friend or shown to everyone.

  It is drawn into the two pages of the spawn catalogue (SpawnMenu.tsx swaps
  its plates for these when the tab is open), so it is paper like the rest:
  the left page is your own slots, each a small pixel picture with its name
  and what you can do to it, and the pencilled save line that names whatever
  the tool gun's copy mode has put in your hands; the right page is the
  share line (a slot's code is pasted here to copy, someone else's is pasted
  to import) and the public gallery beneath it, newest or most spawned, ten
  to a page, where anybody can set a build down or keep it, and its author (or
  the owner) can strike it out.

  The book keeps no state of its own about what is stored: it reads the
  store's snapshot (buildsStore.ts), so the console's `/save` and a click
  here agree, and it works with no server at all (the gallery half then says
  so). Text fields pin the catalogue open the way the find line does, so the
  keyboard is theirs while they are focused.
*/

const INK = '#26211a'
const INK_SOFT = '#81745f'
const RED = '#c2412c'
const RULE = 'rgba(38,33,26,0.25)'

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))

/* --------------------------------------------------- shared little state -- */

interface Ui {
  code: string
  line: { tone: 'ok' | 'err'; text: string } | null
}
let ui: Ui = { code: '', line: null }
const uiSubs = new Set<() => void>()
const setUi = (patch: Partial<Ui>) => {
  ui = { ...ui, ...patch }
  for (const f of uiSubs) f()
}
const useUi = () =>
  useSyncExternalStore((f) => (uiSubs.add(f), () => uiSubs.delete(f)), () => ui)

const useSlots = () => {
  useSyncExternalStore(builds.subscribe, builds.slots)
  useEffect(() => {
    void builds.refresh()
  }, [])
  return builds.slots()
}
const useClipboard = () => useSyncExternalStore(clipboard.subscribe, clipboard.get)

function Btn({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        menuTick('pick')
        onClick()
      }}
      className="cursor-pointer border-b border-dashed bg-transparent px-0.5 font-mono text-[10.5px] italic enabled:hover:opacity-70 disabled:cursor-default disabled:opacity-40"
      style={{ color: RED, borderColor: RED }}
    >
      {children}
    </button>
  )
}

const Thumb = ({ src, size }: { src: string | null | undefined; size: number }) =>
  src ? (
    <img src={src} alt="" draggable={false} style={{ width: size, height: size, imageRendering: 'pixelated' }} />
  ) : (
    <span aria-hidden className="block border border-dashed" style={{ width: size, height: size, borderColor: RULE }} />
  )

/* ------------------------------------------------------------ left page -- */

export function BuildsLeft({ onPin }: { onPin: (on: boolean) => void }) {
  const { language, t } = useI18n()
  const s = t.sandbox.builds
  const slots = useSlots()
  const held = useClipboard()
  const [name, setName] = useState('')
  const say = (tone: 'ok' | 'err', text: string) => setUi({ line: { tone, text } })

  const doSave = async () => {
    const bp = clipboard.get()
    const n = name.trim()
    if (!bp || !n) return
    const ok = await builds.save({ ...bp, name: n })
    say(ok ? 'ok' : 'err', ok ? fill(s.saved, { name: n }) : s.saveFailed)
    if (ok) setName('')
  }
  const doPublish = async (n: string) => {
    if (!galleryAvailable()) return say('err', s.offline)
    if (!gallery.canPublish()) return say('err', s.signIn)
    const r = await builds.publish(n)
    say(r.ok ? 'ok' : 'err', r.ok ? fill(s.published, { name: n }) : r.reason[language])
  }
  const doCode = async (n: string) => {
    const code = await builds.code(n)
    if (code) setUi({ code, line: null })
  }

  return (
    <>
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-[26px] leading-[0.9] font-semibold tracking-tight" style={{ color: RED }}>
          {s.mine}
        </h2>
        <span className="font-mono text-[10.5px]" style={{ color: INK_SOFT }}>{slots.length} / 50</span>
      </div>
      <div aria-hidden className="mt-2 border-t-[3px] border-b" style={{ borderColor: INK, height: 5 }} />

      {/* the pencilled save line: names what the tool gun has copied */}
      <div className="mt-2 flex items-baseline gap-2 font-mono text-[11px]">
        <span className="shrink-0 text-[10.5px]" style={{ color: held ? INK : INK_SOFT }}>
          {held ? fill(s.inHands, { n: held.props.length }) : s.nothingCopied}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => onPin(true)}
          onBlur={() => onPin(false)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              void doSave()
            } else if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          disabled={!held}
          placeholder={s.namePlaceholder}
          className="min-w-0 flex-1 border-b-2 border-dotted bg-transparent px-0.5 pb-0.5 placeholder:italic disabled:opacity-40"
          style={{ borderColor: `${INK}55`, color: INK, outline: 'none', caretColor: RED }}
        />
        <Btn onClick={() => void doSave()} disabled={!held || !name.trim()}>{s.save}</Btn>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {slots.length === 0 ? (
          <p className="mt-4 max-w-[36ch] font-mono text-[12px] leading-relaxed italic" style={{ color: INK_SOFT }}>{s.empty}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-2">
            {slots.map((sl: SlotInfo) => (
              <li key={sl.name} className="flex min-w-0 gap-2 border-b border-dotted pb-1.5" style={{ borderColor: RULE }}>
                <Thumb src={sl.thumb} size={52} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-display truncate text-[12.5px] leading-tight font-semibold" title={sl.name}>{sl.name}</span>
                  <span className="font-mono text-[9.5px]" style={{ color: INK_SOFT }}>{fill(s.propsN, { n: sl.props })}</span>
                  <span className="mt-auto flex flex-wrap gap-x-2 gap-y-0.5">
                    <Btn onClick={() => void builds.spawn(sl.name)}>{s.setDown}</Btn>
                    <Btn onClick={() => void builds.take(sl.name)}>{s.take}</Btn>
                    <Btn onClick={() => void doCode(sl.name)}>{s.code}</Btn>
                    <Btn onClick={() => void doPublish(sl.name)}>{s.publish}</Btn>
                    <Btn onClick={() => void builds.remove(sl.name)}>{s.remove}</Btn>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-1 font-mono text-[9.5px]" style={{ color: INK_SOFT }}>{s.hint}</p>
    </>
  )
}

/* ----------------------------------------------------------- right page -- */

export function BuildsRight({ onPin }: { onPin: (on: boolean) => void }) {
  const { language, t } = useI18n()
  const s = t.sandbox.builds
  const { code, line } = useUi()
  const [sort, setSort] = useState<'new' | 'top'>('new')
  const [page, setPage] = useState(0)
  const [stamp, setStamp] = useState(0)
  // the answer to one (sort, page, stamp) request; a stale one is ignored, so
  // changing the page shows "fetching" without an effect having to clear it
  const key = `${sort}:${page}:${stamp}`
  const [res, setRes] = useState<{ key: string; page?: GalleryPage; error?: string } | null>(null)
  const say = (tone: 'ok' | 'err', text: string) => setUi({ line: { tone, text } })
  const data = res?.key === key ? (res.page ?? null) : null
  const failed = res?.key === key ? (res.error ?? null) : null

  useEffect(() => {
    if (!galleryAvailable()) return
    let live = true
    void gallery.list(sort, page).then((r) => {
      if (!live) return
      setRes(r.ok ? { key, page: r } : { key, error: r.error })
    })
    return () => {
      live = false
    }
  }, [sort, page, stamp, key])

  const copy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      say('ok', s.copied)
    } catch {
      /* no clipboard permission: the text is selected in the box for ctrl+c */
      say('err', s.copied)
    }
  }
  const doImport = async () => {
    const r = await builds.parse(code)
    if (!r.ok) return say('err', errorText(r.error)[language])
    const n = r.bp.name || s.importName
    const ok = await builds.save({ ...r.bp, name: n })
    say(ok ? 'ok' : 'err', ok ? fill(s.imported, { name: n }) : s.saveFailed)
  }
  const pull = async (e: GalleryEntry, mode: 'save' | 'spawn') => {
    const r = await gallery.pull(e.id)
    if (!r.ok) return say('err', errorText(r.error)[language])
    if (mode === 'spawn') {
      builds.spawnBlueprint(r.bp)
      setStamp((n) => n + 1)
    } else {
      const ok = await builds.save({ ...r.bp, name: e.name })
      say(ok ? 'ok' : 'err', ok ? fill(s.pulled, { name: e.name }) : s.saveFailed)
    }
  }
  const strike = async (e: GalleryEntry) => {
    const r = await gallery.remove(e.id)
    if (!r.ok) return say('err', errorText(r.error)[language])
    say('ok', s.gone)
    setStamp((n) => n + 1)
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1
  return (
    <>
      <div className="flex items-baseline gap-3">
        <h3 className="font-display truncate text-[22px] leading-none font-semibold">{s.share}</h3>
      </div>
      <div aria-hidden className="mt-2 border-t" style={{ borderColor: INK, height: 5 }} />
      <textarea
        value={code}
        onChange={(e) => setUi({ code: e.target.value })}
        onFocus={() => onPin(true)}
        onBlur={() => onPin(false)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
        }}
        spellCheck={false}
        autoComplete="off"
        rows={2}
        placeholder={s.pasteHere}
        className="w-full resize-none border border-dotted bg-transparent p-1 font-mono text-[10px] leading-tight break-all placeholder:italic"
        style={{ borderColor: `${INK}55`, color: INK, outline: 'none', caretColor: RED }}
      />
      <div className="mt-1 flex items-baseline gap-3">
        <Btn onClick={() => void copy()} disabled={!code}>{s.copyCode}</Btn>
        <Btn onClick={() => void doImport()} disabled={!code.trim()}>{s.import}</Btn>
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-[10px] italic"
          style={{ color: line?.tone === 'err' ? RED : INK_SOFT }}
        >
          {line?.text ?? s.shareHint}
        </span>
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <h3 className="font-display text-[20px] leading-none font-semibold">{s.gallery}</h3>
        <span className="flex gap-2 font-mono text-[10.5px]">
          {(['new', 'top'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                menuTick('tab')
                setSort(k)
                setPage(0)
              }}
              className="cursor-pointer bg-transparent"
              style={{ color: sort === k ? RED : INK_SOFT, textDecoration: sort === k ? 'underline' : undefined, textUnderlineOffset: 3 }}
            >
              {k === 'new' ? s.newest : s.top}
            </button>
          ))}
        </span>
      </div>
      <div aria-hidden className="mt-1 border-t" style={{ borderColor: INK, height: 4 }} />
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!galleryAvailable() ? (
          <p className="mt-3 font-mono text-[11.5px] italic" style={{ color: INK_SOFT }}>{s.offline}</p>
        ) : failed ? (
          <p className="mt-3 font-mono text-[11.5px] italic" style={{ color: RED }}>{errorText(failed)[language]}</p>
        ) : !data ? (
          <p className="mt-3 font-mono text-[11.5px] italic" style={{ color: INK_SOFT }}>{s.loading}</p>
        ) : data.builds.length === 0 ? (
          <p className="mt-3 font-mono text-[11.5px] italic" style={{ color: INK_SOFT }}>{s.empty2}</p>
        ) : (
          <ul className="space-y-1.5 pt-1.5">
            {data.builds.map((e) => (
              <li key={e.id} className="flex items-center gap-2 border-b border-dotted pb-1" style={{ borderColor: RULE }}>
                <Thumb src={e.thumb || null} size={40} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-display truncate text-[12.5px] leading-tight font-semibold" title={e.name}>{e.name}</span>
                  <span className="truncate font-mono text-[9.5px]" style={{ color: INK_SOFT }}>
                    {fill(s.by, { author: e.author })} · {fill(s.propsN, { n: e.props })} · {fill(s.spawnsN, { n: e.spawns })}
                  </span>
                </div>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <Btn onClick={() => void pull(e, 'spawn')}>{s.setDown}</Btn>
                  <Btn onClick={() => void pull(e, 'save')}>{s.save}</Btn>
                  {gallery.mayDelete(e) && <Btn onClick={() => void strike(e)}>{s.remove}</Btn>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {data && pages > 1 && (
        <div className="mt-1 flex items-baseline justify-end gap-3 font-mono text-[10px]" style={{ color: INK_SOFT }}>
          <Btn onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>{s.prev}</Btn>
          <span>{page + 1} / {pages}</span>
          <Btn onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>{s.next}</Btn>
        </div>
      )}
    </>
  )
}
