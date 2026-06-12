/*
  The CRT tube overlays: scanlines, a slow refresh beam sweeping down, and an
  edge vignette. Shared by the flat bezel mode and the 3D monitor glass.
*/
export function ScreenEffects({ rounded = false }: { rounded?: boolean }) {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[9000] opacity-50"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.10) 0px, rgba(0,0,0,0.10) 1px, transparent 1px, transparent 3px)',
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[9000] overflow-hidden">
        <div
          className="h-[28%] w-full motion-safe:animate-[os-beam_7s_linear_infinite]"
          style={{
            background:
              'linear-gradient(to bottom, transparent, rgba(255,255,255,0.045) 42%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.045) 58%, transparent)',
            willChange: 'transform',
          }}
        />
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 z-[9000] shadow-[inset_0_0_110px_rgba(0,0,0,0.42)] ${
          rounded ? 'sm:rounded-lg' : ''
        }`}
      />
    </>
  )
}
