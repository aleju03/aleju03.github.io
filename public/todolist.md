# AlejOS todo list

- [ ] **1. Wormhole entrance transition** — make the entrance transition of wormhole more of a thing, right now it feels like only the one from when you click on the portfolio to enter the pc was thought of, but there's not really much of a part when you enter the 3d scenario, it just kinda micro stutters as it simply loads the 3d scene thing with the pc.

- [ ] **2. Games folder** — add a "Games" folder in the desktop of the pc, in there put the games and also add: Pong, Snake, Memory Match, 2048, Whack a Mole, Flappy Bird. Each game must have a leaderboard that saves the score to the db so that every user can see all the scores other visitors have set, to try to beat. Also add a VSRG game in there, all with windows xp vibe and assets feel of course, all games must be very polished and complete, so Minesweeper needs work still (e.g. difficulty selection). Also add a new online 1v1 game inspired by the minesweeper one from Squidcraft Games by Eufonia Studio:

  <details>
  <summary>1v1 Minesweeper rules (Squidcraft Games)</summary>

  🧱 **Map structure and components.** The physical environment is a key element for the game's visual feel. The Board: a horizontal grid on the ground made of blocks. In the original Eufonia Studio event it was roughly a 10x10 area of tiles (adapt to whatever size you prefer). State blocks: tiles must change appearance to represent three clear states — Hidden/Original: dirt or grass blocks. Dug: a tilled dirt, sand, or stone block indicating the space has already been safely uncovered. Numbers: instead of plain text, an uncovered tile should display particles or numeric textures from 1 to 8, corresponding to the mines in the adjacent blocks.

  👥 **Game format and life system.** Matchmaking: a straight elimination 1v1 format. It can be structured with a bracket/key system. Life system: each player has a fixed number of lives (usually 1 to 3). Stepping on a mine costs one life. Losing all lives means permanent elimination from the event.

  🕹️ **Phase 1: Mine placement (hidden strategy).** This is the mechanic that sets Squid Craft Games apart from conventional Minesweeper. Simultaneous blind phase: at the start of the round, the board is visually split in half with a temporary barrier, or players get a partial blindness effect. Mine limit: each player is allowed to "plant" a strict number of mines (e.g. 5 mines per player). Planting logic: a player interacts with their desired tiles to save those coordinates on the server. The opponent can't see where you place them. Mandatory memorization: each player must memorize exactly their own coordinates to avoid stepping on them later in the next phase.

  ⛏️ **Phase 2: Turn-based digging (the duel).** Once the mines are placed, the barrier is removed and active turn-based digging begins with fast, time-limited turns. Turn action: on your turn, you must pick a single tile from the whole board and "dig" it (break it or interact with it using a shovel). Safe result: if the tile is clean, the block transforms and reveals a number from 1 to 8. This number mathematically counts how many mines in total (both yours and the opponent's) are touching the 8 tiles surrounding that position. The turn passes to the opponent. Failed result (mine): if you dig a coordinate where either player planted a mine, the block detonates immediately, launching you into the air and costing you one life.

  </details>

- [x] **3. Room scenery** — ~~finish making the room scenery, right now it's too simple, make the outside of the window better, codex made it and it's so bad, it must feel like I'm looking at an outside world, not just a flat image, improve overall lighting, make the room feel much more alive, more realistic assets, lighting etc, using game optimization techniques to make it all feel good, look good, and run super smooth without compromising the visual quality.~~
  *Done 2026-07-03: the painted window backdrop was replaced with a real 3D exterior (star dome, moon, skyline, yard), the bedroom got a bed/nightstand/dresser/wardrobe/curtains/real office chair, per-room light rig with baked shadows, instanced props, streamed model loading. Pending: a walkthrough in a real browser to tune feel.*

- [ ] **4. Better player model** — get a better model for the player, the robot kinda thing we have rn looks out of theme.

- [ ] **5. Paper plane in the room** — as kind of easter egg, if we enter the pc via the paper plane from the portfolio getting sucked, when we are on the room scenario, have the paper plane lying there somewhere in the room.

- [ ] **6. 2003 taskbar clock + year switcher** — to give more of a sense of immersion, indicate the time in the taskbar where windows xp used to put it, pretending it's 2003, also something to change the time; the year I choose is the year the browser changes to work on, current default is 2003 because I was born in 2003.
  *Partially there: the taskbar already has a clock (but it shows the real time), and the 2003 fiction already exists in the BIOS copyright, the filesystem timestamps and the browser's Wayback year. Missing: the clock pretending it's 2003, and a UI to change the year that re-targets the browser's time-travel year.*

- [x] **7. Full house + yard** — ~~ampliate the room to be a full well decorated house we can navigate, with yard and everything. We do spawn on the room tho.~~
  *Done 2026-07-03: hallway, bathroom (with working mirror), living room + kitchen, fenced back yard with porch, bench, lanterns and fireflies. Spawn unchanged (bedroom). Built in `src/components/os/houseWorld.ts`.*

- [ ] **8. Backrooms easter egg** — when all of the above is done, add a backrooms easter egg, some place in the house where I can enter a wall and enter the backrooms, a 1:1 recreation as close to original as possible, assets, audios, etc, no entities tho, just a map. *(Unblocked now that the house exists.)*
