import type { WireWeapon } from '../../net/weaponProtocol'

/*
  What the tool belt can carry and where each thing is kept, as plain data
  with nothing behind it, so the switcher on the React side
  (components/os/ToolSwitcher.tsx) and CrtScene's own chunk can read the
  layout without pulling in the belt, which loads with the world.

  `SLOTS` is the order the mouse wheel steps through, across everything.
  `COLUMNS` is Garry's Mod's weapon selection: one column per number key,
  the slots listed under it, and a key pressed again stepping down its own
  column (toolbelt.ts's `column()`). 1 is your hands, 2 the tools (the
  physgun, the tool gun, the portal gun once it has been handed over, and the
  camera), 3 the weapons.
*/

export type ToolId = 'hands' | 'physgun' | 'toolgun' | 'portalgun' | 'camera' | WireWeapon
export const SLOTS: readonly (ToolId | null)[] = ['hands', 'physgun', 'toolgun', 'portalgun', 'pistol', 'crossbow', 'rocket', 'camera']
/** the slots under each number key: 1 hands, 2 tools, 3 weapons */
export const COLUMNS: readonly (readonly number[])[] = [[0], [1, 2, 3, 7], [4, 5, 6]]
/** which column a slot is kept in (-1: none) */
export const columnOf = (slot: number): number => COLUMNS.findIndex((c) => c.includes(slot))
