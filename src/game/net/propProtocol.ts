/*
 * Sandbox wire records, kept separate from presence so headless physics can
 * use them without a browser. Poses use centimetres and quaternion ten-
 * thousandths. The optional six-number tail is velocity for a handoff only;
 * ordinary movement is ten integers, and idle props send no rows.
 */
export type PropPose = number[]
export interface NetProp {
  id: number
  owner: number
  name: string
  authority: number
  epoch: number
  kind: string
  scale: number
  mass?: number
  pose: PropPose
  lock: 'hand' | 'seat' | 'keys' | null
  part: number[] | null
  life: number[] | null
  transfer?: { to: number; lock: 'hand' | 'seat' | 'keys' | null; waiting: number }
}
export interface NetJoint {
  id: number
  a: number
  b: number
  kind: 'weld' | 'axis' | 'rope' | 'nocollide'
  frames: number[]
}
export type PropServerMessage = { level: string } & (
  | { type: 'world-prop-snapshot'; props: NetProp[]; joints: NetJoint[] }
  | { type: 'world-prop-spawn'; prop: NetProp; nonce: number }
  | { type: 'world-prop-state'; props: NetProp[] }
  | { type: 'world-prop-move'; rows: PropPose[] }
  | { type: 'world-prop-remove'; ids: number[] }
  | { type: 'world-prop-hit'; id: number; amount: number; ignite: boolean }
  | { type: 'world-prop-break'; id: number; how: 'break' | 'explode' }
  | { type: 'world-prop-explosion'; from: number; at: number[]; power: number; radius: number }
  | { type: 'world-prop-joint'; joint: NetJoint; nonce: number }
  | { type: 'world-prop-unjoint'; id: number }
  | { type: 'world-prop-denied'; op: string; reason: string; nonce?: number }
)
export type PropClientMessage = { level: string } & (
  | { type: 'world-prop-spawn'; nonce: number; kind: string; scale: number; mass: number; pose: PropPose }
  | { type: 'world-prop-move' | 'world-prop-ack'; rows: PropPose[] }
  | { type: 'world-prop-claim'; id: number; reason: 'hand' | 'seat' | 'keys' | 'collision' | 'release'; source?: number }
  | { type: 'world-prop-hit'; id: number; amount: number; ignite: boolean }
  | { type: 'world-prop-remove'; id: number }
  | { type: 'world-prop-cleanup'; target: string }
  | { type: 'world-prop-break'; id: number; epoch: number; how: 'break' | 'explode' }
  | { type: 'world-prop-explosion'; id?: number; epoch?: number; at: number[]; power: number; radius: number }
  | { type: 'world-prop-meta'; id: number; epoch: number; part: number[] | null; life: number[] | null }
  | { type: 'world-prop-joint'; id: number; b: number; kind: NetJoint['kind']; frames: number[]; nonce: number }
  | { type: 'world-prop-unjoint'; id: number }
)
