/*
 * The two mode tables must agree: the server's rules (src/roundModes.js) and
 * the client's presentation (src/game/modes/defs.ts) name the same modes with
 * the same minimums, maximums, maps and options, both languages are filled in
 * everywhere, and the wire's list of ids (roundProtocol.ts) is the same list.
 * defs.ts has only type-level TypeScript, so Node reads it directly.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODES } from '../src/roundModes.js';

export async function defsAgree() {
  const defs = await import('../../src/game/modes/defs.ts');
  const proto = readFileSync(new URL('../../src/game/net/roundProtocol.ts', import.meta.url), 'utf8');
  const wire = /ROUND_MODES = \[([^\]]+)\]/.exec(proto)[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual([...wire].sort(), Object.keys(MODES).sort(), 'the wire names every mode the server has');
  assert.deepEqual(Object.keys(defs.MODE_DEFS).sort(), Object.keys(MODES).sort(), 'and the client presents every one');
  for (const [id, server] of Object.entries(MODES)) {
    const d = defs.MODE_DEFS[id];
    assert.equal(d.id, id);
    assert.equal(d.min, server.minPlayers, `${id}: minimum players`);
    assert.equal(d.max, server.maxPlayers ?? 16, `${id}: maximum players`);
    assert.deepEqual(d.levels, server.levels, `${id}: maps`);
    assert.deepEqual(d.options.map((o) => o.key).sort(), Object.keys(server.options ?? {}).sort(), `${id}: options`);
    for (const key of ['name', 'blurb', 'rules']) {
      assert.ok(d[key].en && d[key].es && d[key].en !== d[key].es, `${id}: ${key} in both languages`);
    }
    for (const level of d.levels) assert.ok(defs.LEVEL_NAMES[level], `${id}: ${level} has a name`);
    for (const r of d.roles) assert.ok(r.name.en && r.name.es && r.brief.en && r.brief.es);
    for (const o of d.options) {
      assert.ok(o.label.en && o.label.es);
      for (const c of o.choices ?? []) assert.ok(c.label.en && c.label.es);
    }
  }
  assert.equal(defs.THEMES.length, 10, 'the server draws a theme from ten');
  assert.ok(defs.THEMES.every((t) => t.en && t.es));
}
