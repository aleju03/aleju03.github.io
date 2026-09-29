import type { ModeClient, ModeCtx } from './types'

/*
  The build contest, the client's half. Everything that matters is the
  server's: the plots are ordinary chunk claims (claims.js `assign`), so the
  edit guard, the "claimed by NAME" note and the blue edge sparks that
  Cubeland already has are the plot boundary, and only the owner's client can
  change their plot; the tp on `world-round-tp` puts each builder on their
  plot and then walks the whole party round the gallery, one plot per twenty
  seconds; the votes are counted by the server, who never tells anyone a
  running total.

  This module holds the walkers at the viewing spot during the gallery (a
  tour is not the time to wander off), and turns the number keys 1 to 5 into
  a mark for the plot on show. Building itself is Cubeland's bare hands, so
  the tools are left alone.
*/

export function createBuild(c: ModeCtx): ModeClient {
  const s = c.store
  const gallery = () => s.phase === 'playing' && s.obj.stage === 'gallery'
  const shown = () => (s.obj.gal as { plot: number } | undefined)?.plot ?? 0
  return {
    frozen: () => s.phase === 'countdown' || gallery(),
    // 1-5 are the marks here and the tool columns everywhere else, so the belt is put away while the gallery is on
    locked: gallery,
    tick(input) {
      if (!gallery() || shown() === s.you) return
      for (let n = 1; n <= 5; n++) {
        if (input.pressed(`vote${n}` as 'vote1')) {
          c.host.send({ type: 'world-round-cmd', cmd: 'vote', n })
          c.host.cue('vote')
        }
      }
    },
    objective: () => {
      if (gallery()) {
        return shown() === s.you
          ? { en: 'Your plot is on show', es: 'Tu parcela está en exhibición' }
          : { en: 'Press 1 to 5 to mark this build', es: 'Pulsa de 1 a 5 para puntuar esta obra' }
      }
      return { en: 'Build on your plot, inside the blue edge', es: 'Construye en tu parcela, dentro del borde azul' }
    },
  }
}
