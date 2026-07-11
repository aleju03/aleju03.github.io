import type * as THREE from 'three'

/*
  Central bookkeeping for everything the scene must give back on unmount.
  Level builders receive the two track callbacks and register every texture
  and disposable they create; the mount owner calls disposeAll() once in its
  cleanup. textures is exposed separately because the renderer also wants to
  warm each one up front (initTexture) so no upload lands mid-frame later.
*/

export interface Disposer {
  /** register a texture: warmed up front AND disposed on teardown */
  texture: <T extends THREE.Texture>(t: T) => T
  /** register anything with a dispose(); returns it for chaining */
  add: <D extends { dispose: () => void }>(d: D) => D
  textures: THREE.Texture[]
  disposeAll: () => void
}

export function createDisposer(): Disposer {
  const textures: THREE.Texture[] = []
  const disposables: Array<{ dispose: () => void }> = []
  return {
    textures,
    texture: (t) => {
      textures.push(t)
      // also on the disposal list — one call covers a texture's whole
      // lifecycle (dispose is idempotent, so double registration is fine)
      disposables.push(t)
      return t
    },
    add: (d) => {
      disposables.push(d)
      return d
    },
    disposeAll: () => {
      disposables.forEach((d) => d.dispose())
      disposables.length = 0
      textures.length = 0
    },
  }
}
