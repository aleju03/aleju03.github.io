import { packLook, type PlayerLook } from '../../game/player/look'

/*
  The wardrobe's snapshots: a little photo of you in each hat, each build and
  each outfit, so the choice is made by looking rather than by reading a word
  and guessing.

  This module is only the bookkeeping. The pictures are taken by the
  character preview in `WorldIdentity.tsx`, with its own renderer and a second
  `buildPlayerBody()` rig standing just out of its shot, because a WebGL
  context is the one thing a page may not have many of: twenty-four
  thumbnails each owning a renderer would be twenty-four contexts, and
  browsers start throwing the oldest away at sixteen. So a snapshot is asked
  for here (`want`), the preview's frame loop takes a few a frame
  (`next`), draws it into a corner of its own canvas, copies that corner out
  into a plain 2D canvas (`put`) and then draws its normal frame over the
  top, all in one task, so nobody ever sees the corner.

  Three rules keep it light:

  - **Keyed by the whole look.** A snapshot is `frame:packLook(look)`, the 24
    wire characters, so a change of any colour is a new set of keys and the
    old pictures simply stop being asked for. Nothing is invalidated by hand,
    and a colour you go back to is still in the cache.
  - **Only what is on the sheet.** A snapshot nobody is showing any more is
    dropped from the queue the moment its `want` is released, so dragging
    through eight body colours queues eight sets and renders one.
  - **A few a frame**, and never one whose body geometry has not been built
    yet (`next` takes a readiness test): a variant costs a couple of dozen
    milliseconds to build, so a snapshot waits for it rather than forcing it.
    The sheet only shows while the walk is paused, so while one is waiting
    the preview works `bodyShape.ts`'s queue with most of each frame instead
    of the walk's thin share, and the whole wardrobe lands in about a
    second rather than one picture at a time.
*/

/** what a snapshot frames: the head and whatever is on it, or the whole body */
export type ThumbFrame = 'head' | 'body'

export interface ThumbJob {
  key: string
  look: PlayerLook
  frame: ThumbFrame
}

export const thumbKey = (look: PlayerLook, frame: ThumbFrame) => `${frame}:${packLook(look)}`

export interface ThumbStore {
  /** ask for a snapshot; the returned function stops asking */
  want: (job: ThumbJob) => () => void
  /** the finished picture, if there is one */
  get: (key: string) => HTMLCanvasElement | undefined
  /** hear when `key` lands */
  subscribe: (key: string, fn: () => void) => () => void
  /** the next snapshot worth taking, skipping any that `ready` refuses */
  next: (ready: (job: ThumbJob) => boolean) => ThumbJob | undefined
  /** hand a finished picture back */
  put: (key: string, pic: HTMLCanvasElement) => void
}

/** how many finished pictures are kept: every row twice over, which is two
    colourways' worth of going back and forth */
const KEEP = 64

export function createThumbStore(): ThumbStore {
  const done = new Map<string, HTMLCanvasElement>()
  const wanted = new Map<string, { job: ThumbJob; n: number }>()
  const subs = new Map<string, Set<() => void>>()
  return {
    want: (job) => {
      const w = wanted.get(job.key)
      if (w) w.n++
      else wanted.set(job.key, { job, n: 1 })
      return () => {
        const v = wanted.get(job.key)
        if (v && --v.n <= 0) wanted.delete(job.key)
      }
    },
    get: (key) => done.get(key),
    subscribe: (key, fn) => {
      let s = subs.get(key)
      if (!s) subs.set(key, (s = new Set()))
      s.add(fn)
      return () => {
        s.delete(fn)
        if (!s.size) subs.delete(key)
      }
    },
    next: (ready) => {
      for (const { job } of wanted.values()) {
        if (!done.has(job.key) && ready(job)) return job
      }
      return undefined
    },
    put: (key, pic) => {
      done.delete(key)
      done.set(key, pic)
      // oldest first out, but never one somebody is looking at right now
      for (const k of done.keys()) {
        if (done.size <= KEEP) break
        if (!wanted.has(k)) done.delete(k)
      }
      subs.get(key)?.forEach((fn) => fn())
    },
  }
}
