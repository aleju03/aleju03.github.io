import type { ModeClient, ModeCtx, WalkerPose } from './types'

/*
  Deathmatch, the client's half. The server deals the teams, counts the kills
  (health.js's onDeath -> the mode's `died`), refuses friendly fire and ends
  the round; this module only puts each side where its side starts.

  Nuketown's spawns come in two halves, one back yard each (Level.teamSpawns,
  team 'a' first). The round moves everyone to their side's yard when play
  begins, and a death brings you back to your own yard rather than the level's
  random spawn, which is what makes a fight a fight and not a lottery. Free
  for all (no teams) draws from both yards.
*/

export function createDeathmatch(c: ModeCtx): ModeClient {
  const spawnFor = (): WalkerPose | null => {
    const me = c.store.mine
    if (!me) return null
    const team = me.team === 'a' ? 0 : me.team === 'b' ? 1 : -1
    const list = team >= 0 ? c.host.teamSpawns(team) : [...c.host.teamSpawns(0), ...c.host.teamSpawns(1)]
    if (!list.length) return null
    const s = list[Math.floor(Math.random() * list.length)]
    return { x: s.x, y: s.y ?? 0, z: s.z, yaw: s.yaw }
  }
  return {
    playing() {
      const s = spawnFor()
      if (s) c.host.teleport(s.x, s.z, undefined, s.yaw)
    },
    respawnSpot: spawnFor,
    // a countdown is a held breath: nobody moves until the whistle
    frozen: () => c.store.phase === 'countdown',
  }
}
