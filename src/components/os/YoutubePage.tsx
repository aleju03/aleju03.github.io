import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MagnifyingGlassIcon, SpeakerHighIcon, SpeakerSimpleXIcon, WarningIcon } from '@phosphor-icons/react'
import { sounds, getVolume, isMuted, subscribeVolume } from './sounds'
import { getPcGain, subscribePcGain } from './pcAudio'
import {
  canSearchVideo,
  embedSrc,
  known,
  recentSearch,
  rememberSearch,
  runSearch,
  searchUrl,
  searched,
  watchUrl,
  type VideoResult,
  type YoutubeTarget,
} from './browserYouTube'

/*
  YouTube, rendered by a browser that is itself inside a portfolio. The rules
  about addresses, embeds and the search proxy are in browserYouTube.ts; this
  is what they look like.

  Two things shape the component rather than the page.

  **The player is driven over postMessage, never by the iframe API script.**
  Same deal as the television in the living room: no third-party JS on the
  page, and the only outbound thing here is the embed itself.

  **Volume is the point of the whole app.** This is the one thing in AlejOS
  whose sound outlives the desk: put a song on, stand up, and it keeps playing
  *from the machine*, quieter as you cross the room. `pcAudio.ts` owns that
  falloff and this is its only consumer. The tray speaker multiplies it, so
  muting the OS mutes the video too. A speaker icon that silences the beeps
  but not the music would be a lie.
*/

/** either the results, or which flavour of nothing came back */
type Outcome = VideoResult[] | 'error' | 'offline' | undefined

export function YoutubePage({
  target,
  go,
}: {
  target: YoutubeTarget
  go: (url: string) => void
}) {
  const [fetched, setFetched] = useState<Record<string, VideoResult[] | 'error'>>({})
  const frame = useRef<HTMLIFrameElement | null>(null)
  const sent = useRef(-1)

  const pcGain = useSyncExternalStore(subscribePcGain, getPcGain)
  const master = useSyncExternalStore(subscribeVolume, () => (isMuted() ? 0 : getVolume()))

  const { video, query } = target
  const trimmed = (query ?? '').trim()
  const meta = video ? known.get(video) : undefined

  /*
    Derived, not stored. A cached search answers during render, a build with
    no server behind it answers during render, and the only thing that ever
    needs state is the round trip, which is the one case that genuinely
    arrives later.
  */
  const outcome: Outcome = !trimmed
    ? undefined
    : !canSearchVideo
      ? 'offline'
      : searched.get(trimmed) ?? fetched[trimmed]

  // the words stay in the box when a result is opened, and give the way back
  const seed = trimmed || (video ? recentSearch() : '')

  useEffect(() => {
    if (!trimmed) return
    rememberSearch(trimmed)
  }, [trimmed])

  useEffect(() => {
    if (!trimmed || !canSearchVideo || outcome) return
    let alive = true
    runSearch(trimmed)
      .then((r) => alive && setFetched((f) => ({ ...f, [trimmed]: r })))
      .catch(() => alive && setFetched((f) => ({ ...f, [trimmed]: 'error' })))
    return () => {
      alive = false
    }
  }, [trimmed, outcome])

  const post = (func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      'https://www.youtube-nocookie.com',
    )
  }

  /*
    Distance times the tray speaker, pushed only when it actually moves. Every
    one of these is a message into another origin's window, so a value that
    changed by a thousandth is a message nobody asked for; pcAudio quantises
    the distance half of it before it ever gets here.
  */
  useEffect(() => {
    if (!video) return
    const want = Math.round((100 * pcGain * master) / 5) * 5
    if (want === sent.current) return
    sent.current = want
    post('setVolume', [want])
    if (want === 0) post('mute')
    else post('unMute')
  }, [video, pcGain, master])

  // the player only answers once it has loaded, so the first push rides here
  const onFrameLoad = () => {
    const want = Math.round((100 * getPcGain() * (isMuted() ? 0 : getVolume())) / 5) * 5
    sent.current = want
    post('unMute')
    post('setVolume', [want])
    if (want === 0) post('mute')
  }

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim()
    if (!q) return
    sounds.click()
    go(searchUrl(q))
  }

  const quiet = video && pcGain < 0.99

  return (
    <div className="flex h-full flex-col bg-stone-100">
      {/* the period-correct chrome around somebody else's player */}
      <div className="flex items-center gap-3 border-b border-stone-300 bg-white px-4 py-2">
        <p className="shrink-0 font-display text-lg font-semibold text-stone-800">
          You<span className="rounded-sm bg-red-600 px-1.5 py-0.5 text-white">Tube</span>
        </p>
        <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={submit}>
          {/* uncontrolled and keyed on the query: the address is the state, so
              navigating re-seeds the box without a render-time echo of itself */}
          <input
            key={seed}
            name="q"
            defaultValue={seed}
            data-no-focus-ring
            aria-label="Search videos"
            placeholder="Search for a song, a video, anything"
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-sm border border-stone-400 bg-white px-2.5 py-1 text-sm text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]"
          />
          <button
            type="submit"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm border border-stone-400 bg-stone-200 px-3 py-1 text-xs text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] hover:border-red-600"
          >
            <MagnifyingGlassIcon size={13} weight="bold" />
            Search
          </button>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {video ? (
          <div className="mx-auto max-w-2xl p-4">
            <div className="overflow-hidden rounded-md border border-stone-400 bg-black shadow">
              <div className="relative aspect-video w-full">
                <iframe
                  ref={frame}
                  key={video}
                  src={embedSrc(video)}
                  title={meta?.title ?? 'YouTube video'}
                  onLoad={onFrameLoad}
                  /* no sandbox, strict-origin referrer: the generic web
                     frame's attributes turn this into Error 153 */
                  referrerPolicy="strict-origin-when-cross-origin"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  className="absolute inset-0 size-full border-0"
                />
              </div>
            </div>
            {meta && (
              <>
                <p className="mt-3 text-sm font-medium text-stone-800">{meta.title}</p>
                <p className="text-xs text-stone-500">
                  {meta.author}
                  {meta.views && ` · ${meta.views}`}
                </p>
              </>
            )}
            {/*
              A visitor who has never stood up has no idea the sound belongs to
              the machine, so the player says so once, and then reports itself
              as the room's speaker for as long as somebody is out there.
            */}
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-stone-500">
              {quiet ? <SpeakerSimpleXIcon size={13} /> : <SpeakerHighIcon size={13} />}
              {quiet
                ? `Playing on the computer, ${Math.round(pcGain * 100)}% as loud from where you are standing.`
                : 'Keeps playing when you stand up, and fades as you walk away from the desk.'}
            </p>
            {seed && (
              <button
                type="button"
                onClick={() => {
                  sounds.click()
                  go(searchUrl(seed))
                }}
                className="mt-2 cursor-pointer text-xs text-blue-700 underline decoration-dotted underline-offset-2"
              >
                ← back to the results
              </button>
            )}
          </div>
        ) : !trimmed ? (
          <div className="p-5">
            <p className="text-sm text-stone-600">
              Type a song into the box up there. Results play right in this window, and the sound
              comes out of this computer. Stand up and walk off and you will hear it from across
              the room.
            </p>
            <p className="mt-2 text-xs text-stone-400">
              Everything else on the modern web refuses to load inside another page. YouTube's
              player is the one thing that does not, so this is the only real website in here.
            </p>
          </div>
        ) : outcome === undefined ? (
          <p className="p-5 text-xs text-stone-500">Searching…</p>
        ) : outcome === 'offline' ? (
          <Notice
            title="This copy of the site has no server behind it"
            body="Searching goes through a small proxy on mine, and this build was made without its address, so there is nothing to ask. Paste a youtube.com link into the address bar and it will still play in here, sound and all."
          />
        ) : outcome === 'error' ? (
          <Notice
            title="No results came back"
            body="The search goes through my own server, which asks YouTube and reads the answer out of the page. Either it is having a moment or YouTube has rearranged that page again. A pasted link still plays."
          />
        ) : outcome.length === 0 ? (
          <Notice title="Nothing found" body="No videos came back for that one. Try fewer words." />
        ) : (
          <ul className="divide-y divide-stone-200 border-t border-stone-200">
            {outcome.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    sounds.open()
                    known.set(r.id, r)
                    go(watchUrl(r.id))
                  }}
                  className="flex w-full cursor-pointer items-start gap-3 bg-white px-4 py-2.5 text-left transition hover:bg-blue-50"
                >
                  <span className="relative shrink-0">
                    <img
                      src={r.thumb}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-[54px] w-24 rounded-sm border border-stone-300 bg-stone-200 object-cover"
                    />
                    {r.length && (
                      <span className="absolute right-0.5 bottom-0.5 rounded-xs bg-black/80 px-1 text-[10px] text-white">
                        {r.length}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 text-sm text-blue-700 underline decoration-dotted underline-offset-2">
                      {r.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-stone-500">
                      {r.author}
                      {r.views && ` · ${r.views}`}
                      {!r.length && ' · live'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md px-5 py-8">
      <p className="flex items-center gap-2 text-sm font-semibold text-stone-800">
        <WarningIcon size={18} weight="fill" className="text-amber-500" />
        {title}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-stone-600">{body}</p>
    </div>
  )
}
