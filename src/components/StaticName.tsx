/*
  Plain text rendering of the hero name. Shown while the voxel scene loads,
  and instead of it under reduced motion or when WebGL is unavailable.
  Styled to mirror the 3D blocks (uppercase, wide tracking, same accent) so the
  hand-off to the assembled name reads as the flat text gaining depth, not a
  swap. Always aria-hidden: the real <h1> lives in Hero as sr-only text.
*/
export function StaticName() {
  return (
    <div
      aria-hidden
      className="font-display text-[min(13vw,3.75rem)] font-semibold uppercase leading-[0.95] tracking-[0.02em] text-stone-900 sm:text-[min(13.5vw,6rem)] lg:text-9xl dark:text-stone-50"
    >
      Alejandro
      <br />
      <span className="text-blue-600 dark:text-blue-500">Jiménez</span>
    </div>
  )
}
