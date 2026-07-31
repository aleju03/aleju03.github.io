/*
  The cover over walking out of the front door.

  Deliberately NOT BootCover. That one is a loading screen and it is honest
  about being one (a progress bar, a stage caption, the whole apparatus), which
  is right for a cold boot the visitor is already waiting through. Slamming the
  same thing up because somebody opened a door reads as the site breaking, not
  as going outside. This is a cut: the room fades out, a beat passes, the world
  fades in. If the wait runs long a small caption arrives to say it is still
  going, and only then.

  Same hard constraint as BootCover, for the same reason: the main thread is
  BLOCKED for most of what this covers, because compiling the outdoor shader
  variants is the expensive part. So everything here is a CSS animation on
  opacity: no rAF, no React state, no transition driven by a JS timer. All of
  it keeps running on the compositor through a multi-second stall, which is
  exactly the stretch the visitor needs to be told is still going.
*/

export default function StepOutCover({ label }: { label: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
      <style>{`
        @keyframes stepout-in { from { opacity: 0 } to { opacity: 1 } }
        /* the caption is held back: a short load should read as a cut with no
           furniture at all, and only a long one needs explaining */
        @keyframes stepout-say { 0%, 100% { opacity: 0 } 25%, 75% { opacity: 1 } }
      `}</style>
      <div
        className="absolute inset-0 bg-stone-950"
        style={{ animation: 'stepout-in 320ms ease-out both' }}
      />
      <p
        className="absolute inset-x-0 bottom-16 text-center font-mono text-[11px] tracking-[0.32em] text-stone-500 lowercase"
        style={{ animation: 'stepout-say 5.4s ease-in-out 900ms infinite' }}
      >
        {label}
      </p>
    </div>
  )
}
