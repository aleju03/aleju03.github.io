import { useEffect, useState } from 'react'

/*
  POST screen for the AJU 700FD. Green phosphor text that types itself out
  while the camera approaches the monitor, ending in the AlejOS bootloader.
  The container flickers awake via the os-flicker keyframes, like a tube
  warming up.
*/

const LINES: string[] = [
  'AJU 700FD BIOS v2.31',
  'Copyright (c) 2003 AJU Systems, Inc.',
  '',
  'Main Processor : AJ-7 700 MHz',
  '__MEM__',
  '',
  'Detecting IDE Primary Master ... ALEJU-40GB',
  'Detecting IDE Primary Slave  ... CD-ROM 52X',
  'Keyboard ................... OK',
  'Mouse ...................... OK',
  '',
  'Booting ALEJOS ...',
]

const LINE_DELAY_MS = 150
const MEM_TOTAL = 262144

export function BiosScreen() {
  const [shown, setShown] = useState(0)
  const [mem, setMem] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setShown((n) => {
        if (n >= LINES.length) {
          clearInterval(id)
          return n
        }
        return n + 1
      })
    }, LINE_DELAY_MS)
    return () => clearInterval(id)
  }, [])

  const memVisible = shown > LINES.indexOf('__MEM__')
  useEffect(() => {
    if (!memVisible) return
    const id = setInterval(() => {
      setMem((m) => {
        if (m >= MEM_TOTAL) {
          clearInterval(id)
          return MEM_TOTAL
        }
        return m + 32768
      })
    }, 40)
    return () => clearInterval(id)
  }, [memVisible])

  return (
    <div className="h-full overflow-hidden bg-black p-6 font-mono text-[13px] leading-relaxed text-green-400 motion-safe:animate-[os-flicker_0.9s_linear_both] sm:p-8 sm:text-sm">
      <div style={{ textShadow: '0 0 6px rgba(74,222,128,0.55)' }}>
        {LINES.slice(0, shown).map((line, i) =>
          line === '__MEM__' ? (
            <p key={i}>Memory Testing : {mem}K {mem >= MEM_TOTAL ? 'OK' : ''}</p>
          ) : (
            <p key={i}>{line || ' '}</p>
          ),
        )}
        <span className="inline-block h-[1.1em] w-[0.6em] translate-y-[0.2em] animate-pulse bg-green-400" />
      </div>
    </div>
  )
}
