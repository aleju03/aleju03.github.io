/*
 * Persistent portal pairs and transient jump effects share the level relay,
 * but not a lifetime. A portal frame is position, outward normal and up;
 * an optional prop frame uses that body's local coordinates. No geometry,
 * textures or browser objects cross this boundary.
 */
export interface PortalWire {
  serial: number
  level: string
  frame: number[]
  ground: boolean
  inset: number
  skin: number
  ready: boolean
  site: 'moon' | 'earth' | null
  anchor: { prop: number; frame: number[] } | null
}
export interface PortalPairWire {
  owner: number
  portals: [PortalWire | null, PortalWire | null]
}
export type EffectClientMessage =
  | { type: 'world-portal'; color: 0 | 1; portal: PortalWire | null }
  | { type: 'world-air-hop'; level: string; seq: number; x: number; y: number; z: number }
export type EffectServerMessage =
  | ({ type: 'world-portal'; level: string } & PortalPairWire)
  | { type: 'world-portals'; level: string; pairs: PortalPairWire[] }
  | { type: 'world-portal-denied'; color: 0 | 1; serial: number }
  | { type: 'world-air-hop'; level: string; id: number; seq: number; x: number; y: number; z: number }
