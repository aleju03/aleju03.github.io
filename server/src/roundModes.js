/*
 * The mode table: every game the round engine (rounds.js) can run, one small
 * object each. Adding a sixth mode is adding an entry here, a client entry in
 * src/game/modes/defs.ts (names, blurb, colours, what the HUD says) and, if it
 * has verbs of its own, the cases of its `cmd`. Nothing else knows the modes
 * by name.
 *
 *   id, levels[]   the level ids it may run on (the first is the default)
 *   minPlayers     to start (1 in debug), maxPlayers to take part
 *   duration       seconds of "playing" (a mode may move `st.end` itself)
 *   pvp, respawnMs what the room's health.js is told: fighting on or off, and
 *                  how long the dead stay down (Infinity: for the round)
 *   options        host-tunable settings and their defaults (`opt` command)
 *   midJoin        a latecomer may `join` a round in progress
 *   prepare(E)     at the countdown: pick teams/roles/courses, spawn props.
 *                  Returns a reason string to refuse the start
 *   start(E)       when play begins
 *   tick(E, dt)    about five times a second while playing
 *   pose(E,p,ws)   each pose report of a participant (movement gating)
 *   cmd(E,p,m,ws) a mode's own verbs (`world-round-cmd` with cmd = its name)
 *   mayShoot(E,p,w)   may this participant fire weapon w (0 pistol 1 crossbow 2 rocket)
 *   playerHit(E,sp,vp,w,at,sws,vws)  a validated shot hit a player; true means
 *                  the mode took it (no hit points are taken)
 *   propHit(E,p,propId,w,ws)         a validated shot hit a shared prop
 *   guard(E,p,source,victimWs)       false refuses damage (health.js's veto)
 *   died(E,p,killerPart,kind)        a participant's hit points reached zero
 *   left(E,p,why), check(E)          somebody left; are there enough of us
 *   result(E, why)  -> { win: [ids], team, note? } decides who won
 *   end(E), cleanup(E)               after the result / on the way to the lobby
 *
 * `E` is the engine's kit (rounds.js): the state (`E.st`, `E.st.data` for the
 * mode's private memory, `E.st.obj` for what every screen shows), participants,
 * `tell`, `tp`, `score`, `health`, `props`, `claims`, `finish`. Times inside
 * `obj` whose key ends in `At` are server milliseconds; clients convert them
 * with the `now` of the message that carried them.
 *
 * Everything here is server-side rules only. Positions are the ones the
 * server has watched the player report (ws.world), never a claim by the
 * client, except where a verb's own payload is cross-checked against them.
 */
import { PROP_KINDS } from './props.js';
import {
  NUKE_SCATTER, CUBE_ORIGIN, CUBE_B, CHUNK, PLOT_FIELDS, STREET_LOOP, CUBE_LOOP_BLOCKS,
} from './roundData.js';

const HIDE_MS = 30_000;
const SEEK_MS = 240_000;
const BUILD_MS = 300_000;
const GALLERY_MS = 20_000;
const TEAMS = ['a', 'b'];
const DEG = Math.PI / 180;
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** deal people onto teams evenly, in a random order */
function dealTeams(E, parts, teams) {
  const order = E.shuffle(parts);
  order.forEach((p, i) => {
    p.team = teams[i % teams.length];
  });
}
const teamCount = (E, team) => E.parts().filter((p) => p.team === team).length;
const smallerTeam = (E) => (teamCount(E, 'a') <= teamCount(E, 'b') ? 'a' : 'b');

/** hold a participant where they stood when the hiding began, and put them
    back if they wander (a client that ignores the freeze is walked home) */
function holdStill(E, p, ws, until) {
  const t = E.now();
  if (t >= until) return;
  const w = ws.world;
  if (!p.anchor) {
    p.anchor = { x: w.x, z: w.z, yaw: w.yaw };
    return;
  }
  if (dist2(w.x, w.z, p.anchor.x, p.anchor.z) > 3 && t - (p.lastTp ?? 0) > 1000) {
    p.lastTp = t;
    E.tp(p.id, p.anchor.x, p.anchor.z, p.anchor.yaw);
  }
}

/* -------------------------------------------------------- deathmatch */

const deathmatch = {
  id: 'deathmatch',
  levels: ['nuketown'],
  minPlayers: 2,
  maxPlayers: 16,
  duration: 300,
  pvp: true,
  respawnMs: 3000,
  midJoin: true,
  // teams or free for all; the kill limit (0: 40 for a team, 20 alone)
  options: { teams: true, limit: 0 },
  limit: (E) => {
    const set = E.opt('limit', 0);
    return set > 0 ? Math.min(200, Math.floor(set)) : E.opt('teams', true) ? 40 : 20;
  },
  start(E) {
    const teams = E.opt('teams', true);
    if (teams) dealTeams(E, E.parts(), TEAMS);
    E.st.obj = { limit: deathmatch.limit(E), teams };
  },
  joined(E, p) {
    if (E.opt('teams', true)) p.team = smallerTeam(E);
  },
  guard(E, p, src) {
    // no friendly fire: the same colour never hurts you (yourself, the fall
    // and the lava always do)
    if (!E.opt('teams', true) || !src.by || src.by === p.id) return true;
    const k = E.partOf(src.by);
    return !(k && k.team && k.team === p.team);
  },
  died(E, p, killer) {
    p.b++;
    if (killer && killer !== p) {
      killer.a++;
      killer.score++;
    }
    deathmatch.check(E);
  },
  check(E) {
    const teams = E.opt('teams', true);
    const limit = deathmatch.limit(E);
    if (teams) {
      const sum = { a: 0, b: 0 };
      for (const p of E.parts()) if (p.team) sum[p.team] += p.a;
      if (sum.a >= limit || sum.b >= limit) return E.finish('limit');
      if (teamCount(E, 'a') === 0 || teamCount(E, 'b') === 0) E.finish('last');
    } else if (E.parts().some((p) => p.a >= limit)) E.finish('limit');
  },
  result(E) {
    const parts = E.parts();
    if (E.opt('teams', true)) {
      const sum = { a: 0, b: 0 };
      for (const p of parts) if (p.team) sum[p.team] += p.a;
      // a team that walked out entirely loses whatever the kills say
      const na = teamCount(E, 'a');
      const nb = teamCount(E, 'b');
      if (na === 0 && nb > 0) sum.b += 1e6;
      else if (nb === 0 && na > 0) sum.a += 1e6;
      if (sum.a === sum.b) return { win: [], team: '', note: 'draw' };
      const team = sum.a > sum.b ? 'a' : 'b';
      return { win: parts.filter((p) => p.team === team).map((p) => p.id), team };
    }
    const top = Math.max(...parts.map((p) => p.a));
    const win = parts.filter((p) => p.a === top && top > 0).map((p) => p.id);
    return { win, team: '', ...(win.length > 1 ? { note: 'tie' } : {}) };
  },
};

/* ------------------------------------------------------ hide and seek */

const hide = {
  id: 'hide',
  levels: ['nuketown', 'overworld', 'cubeland'],
  minPlayers: 2,
  maxPlayers: 12,
  duration: (HIDE_MS + SEEK_MS) / 1000,
  pvp: false,
  respawnMs: null,
  options: { seekers: 0 }, // 0: one seeker, two from eight players
  start(E) {
    const parts = E.parts();
    const asked = E.opt('seekers', 0);
    const n = Math.max(1, Math.min(Math.floor(parts.length / 2) || 1, asked > 0 ? asked : parts.length >= 8 ? 2 : 1));
    E.shuffle(parts).forEach((p, i) => {
      p.role = i < n ? 'seeker' : 'hider';
      p.team = p.role === 'seeker' ? 'b' : 'a';
    });
    E.st.data.seekAt = E.st.t0 + E.time(HIDE_MS);
    E.st.data.alive = new Map(parts.filter((p) => p.role === 'hider').map((p) => [p.id, E.st.t0]));
    E.st.obj = { seekAt: E.st.data.seekAt };
  },
  pose(E, p, ws) {
    if (p.role === 'seeker') holdStill(E, p, ws, E.st.data.seekAt);
  },
  mayShoot: (E, p, w) => p.role === 'seeker' && w === 0 && E.now() >= E.st.data.seekAt,
  guard: () => false, // a tag is not damage
  playerHit(E, sp, vp, w) {
    if (sp.role === 'seeker' && vp.role === 'hider' && w === 0 && E.now() >= E.st.data.seekAt) hide.tag(E, vp, sp);
    return true; // whatever else it was, the pistol here takes no hit points
  },
  cmd(E, p, m, ws) {
    if (m.cmd !== 'tag' || p.role !== 'seeker' || E.now() < E.st.data.seekAt) return;
    if (!Number.isInteger(m.target)) return;
    const t = E.now();
    if (t - (p.lastTag ?? 0) < 600) return;
    p.lastTag = t;
    const v = E.partOf(m.target);
    const vws = E.byId(m.target);
    if (!v || v.role !== 'hider' || !vws?.world) return;
    // a punch reaches arm's length, by the positions the server has watched
    if (dist2(ws.world.x, ws.world.z, vws.world.x, vws.world.z) > 4 || Math.abs(ws.world.y - vws.world.y) > 4) return;
    hide.tag(E, v, p);
  },
  /** a hider is caught and joins the seekers */
  tag(E, v, by) {
    if (v.role !== 'hider') return;
    v.role = 'seeker';
    v.team = 'b';
    v.b = Math.max(0, Math.floor((E.now() - E.st.data.seekAt) / 1000));
    v.out = false;
    E.st.data.alive.delete(v.id);
    by.a++;
    by.score += 3;
    E.tell('caught', { id: v.id, by: by.id });
    E.dirty();
    if (E.st.data.alive.size === 0) {
      E.st.data.last = v.id;
      E.finish('last');
    } else E.st.data.last = 0;
  },
  tick(E) {
    const left = E.parts().filter((p) => p.role === 'hider');
    if (E.now() >= E.st.data.seekAt && left.length === 0) return E.finish('last');
    for (const p of left) p.b = Math.max(0, Math.floor((E.now() - E.st.data.seekAt) / 1000));
  },
  check(E) {
    const parts = E.parts();
    if (!parts.some((p) => p.role === 'hider')) E.finish('last');
    else if (!parts.some((p) => p.role === 'seeker')) {
      // the last seeker walked out: the next hider in line takes the job
      const p = parts.find((q) => q.role === 'hider');
      p.role = 'seeker';
      p.team = 'b';
      E.st.data.alive.delete(p.id);
    }
  },
  result(E, why) {
    const parts = E.parts();
    const hiders = parts.filter((p) => p.role === 'hider');
    for (const p of hiders) p.score += 1 + Math.floor(p.b / 10);
    if (hiders.length) return { win: hiders.map((p) => p.id), team: 'a' };
    // everyone was found: the last one to be caught wins the round
    const last = E.st.data.last;
    return last ? { win: [last], team: 'a', note: 'last' } : { win: parts.filter((p) => p.role === 'seeker').map((p) => p.id), team: 'b' };
  },
};

/* ---------------------------------------------------------- prop hunt */

/** what the decoys are made of: everyday clutter, nothing that explodes */
const DECOYS = `crate crate_small pallet barrel trashcan hydrant cone bucket milk_crate lawn_chair
  wheelie_bin chair table couch bathtub mattress tv melon block barrier cinder sawhorse tyre
  dumpster fridge vending stop_sign plank pipe girder`.split(/\s+/).filter(Boolean);
const DECOY_COUNT = 60;
const WRONG_SHOT_HP = 5;

const prophunt = {
  id: 'prophunt',
  levels: ['nuketown'],
  minPlayers: 2,
  maxPlayers: 12,
  duration: (HIDE_MS + SEEK_MS) / 1000,
  pvp: true,
  respawnMs: Infinity,
  prepare(E) {
    // the clutter the props hide among: sixty everyday things over the map's
    // clear spots, spawned as the system's, so nobody's protection or cap
    // applies to them and every hand may move them
    if (!E.props) return 'noprops';
    const spots = E.shuffle(NUKE_SCATTER).slice(0, DECOY_COUNT);
    const rows = spots.map(([x, z]) => ({
      kind: DECOYS[Math.floor(E.rand() * DECOYS.length)],
      x: x + (E.rand() - 0.5) * 2,
      y: 1.4,
      z: z + (E.rand() - 0.5) * 2,
      yaw: E.rand() * Math.PI * 2,
    }));
    E.st.data.decoys = E.props.spawnSystem(E.st.level, rows);
    return null;
  },
  start(E) {
    const parts = E.parts();
    const nh = parts.length >= 6 ? 2 : 1;
    E.shuffle(parts).forEach((p, i) => {
      p.role = i < nh ? 'hunter' : 'prop';
      p.team = p.role === 'hunter' ? 'b' : 'a';
    });
    E.st.data.seekAt = E.st.t0 + E.time(HIDE_MS);
    E.st.obj = { seekAt: E.st.data.seekAt, decoys: E.st.data.decoys?.length ?? 0 };
  },
  pose(E, p, ws) {
    if (p.role === 'hunter') holdStill(E, p, ws, E.st.data.seekAt);
  },
  mayShoot: (E, p, w) => p.role === 'hunter' && w <= 1 && E.now() >= E.st.data.seekAt,
  guard(E, p, src) {
    if (p.role === 'prop') {
      // only a real hit on the hitbox: a hunter's pistol or bolt
      const k = src.by ? E.partOf(src.by) : null;
      return !!k && k.role === 'hunter' && (src.kind === 'pistol' || src.kind === 'crossbow');
    }
    // hunters are hurt by their own mistakes and the world, never a friend
    return !src.by;
  },
  cmd(E, p, m) {
    if (m.cmd !== 'disguise' || p.role !== 'prop' || p.out) return;
    const kind = typeof m.kind === 'string' ? m.kind : '';
    if (kind && !PROP_KINDS.has(kind)) return;
    if (E.st.dg.get(p.id) === (kind || undefined)) return;
    E.disguise(p.id, kind);
  },
  propHit(E, p, propId, w, ws) {
    // a shot that only hit a real prop costs the hunter
    if (p.role !== 'hunter' || p.out) return;
    const t = E.now();
    if (t - (p.lastWrong ?? 0) < 250) return;
    p.lastWrong = t;
    E.health.hurt(ws, WRONG_SHOT_HP, { by: 0, kind: 'env' });
  },
  died(E, p, killer) {
    p.out = true;
    if (p.role === 'prop') {
      E.disguise(p.id, '');
      if (killer && killer.role === 'hunter') {
        killer.a++;
        killer.score += 3;
      }
      E.tell('found', { id: p.id, by: killer?.id ?? 0 });
    }
    prophunt.check(E);
  },
  check(E) {
    const parts = E.parts();
    const props = parts.filter((p) => p.role === 'prop' && !p.out);
    const hunters = parts.filter((p) => p.role === 'hunter' && !p.out);
    if (!props.length) E.finish('hunted');
    else if (!hunters.length) E.finish('survived');
  },
  tick(E) {
    // props left, for the counter
    const n = E.parts().filter((p) => p.role === 'prop' && !p.out).length;
    if (E.st.obj.left !== n) {
      E.st.obj.left = n;
      E.dirty();
    }
  },
  result(E, why) {
    const parts = E.parts();
    const alive = parts.filter((p) => p.role === 'prop' && !p.out);
    for (const p of alive) {
      p.score += 5;
      p.b = Math.floor((E.now() - E.st.t0) / 1000);
    }
    if (why === 'hunted' || alive.length === 0) return { win: parts.filter((p) => p.role === 'hunter').map((p) => p.id), team: 'b' };
    return { win: alive.map((p) => p.id), team: 'a' };
  },
  cleanup(E) {
    if (E.props && E.st.data.decoys?.length) E.props.removeSystem(E.st.level, E.st.data.decoys);
    for (const id of [...E.st.dg.keys()]) E.disguise(id, '');
  },
};

/* --------------------------------------------------------------- race */

const race = {
  id: 'race',
  levels: ['overworld', 'cubeland'],
  minPlayers: 2,
  maxPlayers: 8,
  duration: 480,
  pvp: false,
  respawnMs: null,
  options: { laps: 2 },
  prepare(E) {
    const foot = E.st.level !== 'overworld';
    const laps = Math.max(1, Math.min(3, Math.round(E.opt('laps', 2))));
    let cps;
    let grid;
    if (!foot) {
      cps = STREET_LOOP.cps.map(([x, z, r]) => [x, z, r]);
      grid = [STREET_LOOP.grid.x, STREET_LOOP.grid.z, STREET_LOOP.grid.yaw * DEG];
    } else {
      const w = ([bx, bz, r]) => [bx * CUBE_B + CUBE_ORIGIN.x + 1, bz * CUBE_B + CUBE_ORIGIN.z + 1, r * CUBE_B];
      cps = CUBE_LOOP_BLOCKS.cps.map(w);
      const g = w([CUBE_LOOP_BLOCKS.grid[0], CUBE_LOOP_BLOCKS.grid[1], 0]);
      grid = [g[0], g[1], Math.PI]; // facing -z... toward the first checkpoint (smaller z)
    }
    E.st.data.course = { cps, laps, foot, grid };
    E.st.obj = { cps: cps.map(([x, z, r]) => [Math.round(x), Math.round(z), r]), laps, foot: foot ? 1 : 0, grid: grid.map((v) => Math.round(v * 100) / 100) };
    // with one car in the fleet, cars race one at a time against the clock
    if (!foot) E.st.data.order = [];
    return null;
  },
  start(E) {
    const d = E.st.data;
    const t = E.now();
    for (const p of E.parts()) {
      p.a = 0; // checkpoints passed
      p.b = 0; // finish time, ms (0: not yet)
      p.lastCp = t;
    }
    if (d.course.foot) {
      d.goAt = t + E.time(3000);
      E.st.obj.goAt = d.goAt;
      for (const p of E.parts()) p.startAt = d.goAt;
      // a staggered start line, on the grid's row
      E.parts().forEach((p, i) => E.tp(p.id, d.course.grid[0] + (i - 3.5) * 3, d.course.grid[1], d.course.grid[2]));
    } else {
      d.order = E.shuffle(E.parts().map((p) => p.id));
      d.turn = -1;
      d.results = [];
      race.nextTurn(E);
    }
  },
  /** car mode: the next driver takes the grid, everyone else waits by it */
  nextTurn(E) {
    const d = E.st.data;
    d.turn++;
    if (d.turn >= d.order.length) return E.finish('done');
    const id = d.order[d.turn];
    const g = d.course.grid;
    const t = E.now();
    d.goAt = t + E.time(8000);
    d.turnEnd = d.goAt + E.time(150_000);
    const p = E.partOf(id);
    p.a = 0;
    p.lastCp = d.goAt;
    p.startAt = d.goAt;
    E.st.obj.turn = id;
    E.st.obj.goAt = d.goAt;
    E.st.obj.turnEndAt = d.turnEnd;
    E.tp(id, g[0], g[1], g[2]);
    for (const q of E.parts()) if (q.id !== id) E.tp(q.id, g[0] - 6, g[1] + 9, g[2]);
    E.tell('turn', { id });
    E.dirty();
  },
  tick(E) {
    const d = E.st.data;
    const t = E.now();
    if (!d.course.foot) {
      if (t >= d.turnEnd) {
        const p = E.partOf(d.order[d.turn]);
        if (p && !p.b) p.dnf = true;
        race.nextTurn(E);
      }
    } else if (E.parts().every((p) => p.b || p.dnf)) E.finish('done');
  },
  cmd(E, p, m, ws) {
    if (m.cmd !== 'cp') return;
    const d = E.st.data;
    const c = d.course;
    const t = E.now();
    if (!Number.isInteger(m.i) || m.i !== p.a || p.b || p.dnf || t < (d.goAt ?? 0)) return;
    if (!c.foot && d.order[d.turn] !== p.id) return;
    const total = c.cps.length * c.laps;
    if (p.a >= total) return;
    const [cx, cz, r] = c.cps[p.a % c.cps.length];
    const w = ws.world;
    // the server's own last sight of the driver has to be at the ring (the pose
    // lags, so allow a car's length or two), and what was claimed agrees
    if (dist2(w.x, w.z, cx, cz) > r + 16) return;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.z) || dist2(m.x, m.z, cx, cz) > r + 10) return;
    // plausible speed: no faster from the last ring than the machine can go
    const prev = p.a === 0 ? c.grid : c.cps[(p.a - 1) % c.cps.length];
    const vmax = c.foot ? 40 : 140;
    const need = (Math.max(0, dist2(cx, cz, prev[0], prev[1]) - r * 2) / vmax) * 1000;
    if (t - p.lastCp < need) return E.tell('slow', {}, p.id);
    p.a++;
    p.lastCp = t;
    E.dirty();
    if (p.a >= total) {
      p.b = Math.max(1, t - p.startAt);
      const finished = E.parts().filter((q) => q.b).length;
      p.score = [10, 6, 4, 3, 2, 1, 1, 1][finished - 1] ?? 1;
      E.tell('finish', { id: p.id, ms: p.b });
      if (!c.foot) {
        d.results.push(p.id);
        race.nextTurn(E);
      } else if (E.parts().every((q) => q.b || q.dnf)) E.finish('done');
    }
  },
  left(E, p) {
    const d = E.st.data;
    if (d.course && !d.course.foot && d.order?.[d.turn] === p.id) {
      // a driver who leaves forfeits the turn (the engine drops them after)
      d.turnEnd = 0;
    }
    if (d.order) d.order = d.order.filter((id) => id !== p.id), d.turn = Math.min(d.turn, d.order.length);
  },
  check(E) {
    if (E.st.data.course?.foot && E.parts().every((q) => q.b || q.dnf)) E.finish('done');
  },
  result(E) {
    const parts = E.parts();
    const done = parts.filter((p) => p.b).sort((x, y) => x.b - y.b);
    if (!done.length) return { win: [], team: '', note: 'nobody' };
    return { win: [done[0].id], team: '' };
  },
};

/* ------------------------------------------------------ build contest */

const THEMES = 10; // the words are the client's; the server sends an index

const build = {
  id: 'build',
  levels: ['cubeland'],
  minPlayers: 2,
  maxPlayers: 8,
  duration: (BUILD_MS + GALLERY_MS * 8) / 1000,
  pvp: false,
  respawnMs: null,
  prepare(E) {
    const n = E.parts().length;
    const field = PLOT_FIELDS.find((f) => f.plots >= n) ?? PLOT_FIELDS[PLOT_FIELDS.length - 1];
    E.st.data.field = field;
    E.st.obj = { theme: Math.floor(E.rand() * THEMES), stage: 'wait', plots: [] };
    return null;
  },
  /** chunk column origin of the i-th plot (2x2 chunks each, row by row) */
  plotOrigin(field, i) {
    return { cx: field.cx + (i % field.cols) * 2, cz: field.cz + Math.floor(i / field.cols) * 2 };
  },
  /** world coordinates of a block position */
  wx: (bx) => bx * CUBE_B + CUBE_ORIGIN.x + CUBE_B / 2,
  wz: (bz) => bz * CUBE_B + CUBE_ORIGIN.z + CUBE_B / 2,
  start(E) {
    const d = E.st.data;
    const parts = E.parts();
    d.plots = new Map();
    d.votes = new Map(); // plot owner -> Map(voter -> 1..5)
    parts.forEach((p, i) => {
      const o = build.plotOrigin(d.field, i);
      d.plots.set(p.id, o);
      d.votes.set(p.id, new Map());
      const ws = E.byId(p.id);
      if (ws && E.claims) {
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) E.claims.assign(E.st.level, o.cx + dx, o.cz + dz, ws);
      }
      // a plot's middle
      E.tp(p.id, build.wx(o.cx * CHUNK + CHUNK), build.wz(o.cz * CHUNK + CHUNK), 0);
    });
    d.buildEnd = E.st.t0 + E.time(BUILD_MS);
    d.galleryAt = d.buildEnd;
    d.gi = -1;
    d.galMs = E.time(GALLERY_MS);
    E.st.end = d.buildEnd + parts.length * d.galMs;
    E.st.obj.stage = 'build';
    E.st.obj.buildEndAt = d.buildEnd;
    E.st.obj.plots = parts.map((p) => [p.id, d.plots.get(p.id).cx, d.plots.get(p.id).cz]);
  },
  tick(E) {
    const d = E.st.data;
    const t = E.now();
    if (t < d.buildEnd) return;
    const ids = [...d.plots.keys()];
    const gi = Math.min(ids.length - 1, Math.floor((t - d.buildEnd) / d.galMs));
    if (gi === d.gi) return;
    d.gi = gi;
    const id = ids[gi];
    const o = d.plots.get(id);
    E.st.obj.stage = 'gallery';
    E.st.obj.gal = { plot: id, i: gi, n: ids.length, endAt: d.buildEnd + (gi + 1) * d.galMs };
    // everyone to the front of that plot, looking in (owners too: it is
    // their moment as much as anybody's)
    for (const p of E.parts()) E.tp(p.id, build.wx(o.cx * CHUNK + CHUNK), build.wz(o.cz * CHUNK - 8), Math.PI);
    E.tell('gallery', { plot: id });
    E.dirty();
  },
  mayShoot: () => false,
  guard: () => false,
  cmd(E, p, m) {
    if (m.cmd !== 'vote') return;
    const d = E.st.data;
    const gal = E.st.obj.gal;
    if (E.st.obj.stage !== 'gallery' || !gal || !Number.isInteger(m.n) || m.n < 1 || m.n > 5) return;
    if (gal.plot === p.id) return; // no voting for yourself
    d.votes.get(gal.plot)?.set(p.id, m.n);
    E.tell('voted', { n: m.n }, p.id);
  },
  left(E, p) {
    const d = E.st.data;
    if (d.plots && E.claims) {
      const o = d.plots.get(p.id);
      if (o) for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) E.claims.free(E.st.level, o.cx + dx, o.cz + dz);
    }
  },
  result(E) {
    const d = E.st.data;
    let top = 0;
    for (const p of E.parts()) {
      const votes = [...(d.votes.get(p.id)?.values() ?? [])];
      p.score = votes.reduce((s, n) => s + n, 0);
      p.a = votes.length;
      top = Math.max(top, p.score);
    }
    const win = E.parts().filter((p) => p.score === top && top > 0).map((p) => p.id);
    return { win, team: '', ...(win.length > 1 ? { note: 'tie' } : {}) };
  },
  cleanup(E) {
    const d = E.st.data;
    if (!d.plots || !E.claims) return;
    for (const o of d.plots.values()) {
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) E.claims.free(E.st.level, o.cx + dx, o.cz + dz);
    }
  },
};

export const MODES = { deathmatch, prophunt, hide, race, build };

/** the table for tests and the readme: what each mode needs to start */
export const modeList = () =>
  Object.values(MODES).map((m) => ({ id: m.id, levels: m.levels, minPlayers: m.minPlayers, maxPlayers: m.maxPlayers ?? 16 }));
