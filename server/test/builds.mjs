/*
 * The published-builds gallery, against the real server: browse as a guest,
 * publish as an account, the refusals (guest, bad code, unknown kind, oversize
 * name/thumbnail, the 20-build cap, the rate limit), pulls that count once,
 * sort by most spawned, and deletion by author and by admin. Plus the code
 * checker on its own.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import Database from 'better-sqlite3';
import { checkCode, checkThumb, cleanName, createBuildGallery, PAGE_SIZE } from '../src/builds.js';

const row = (kind = 'crate', extra = {}) => [kind, 1, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, -1, 0, ...Object.values(extra)];
const codeOf = (json) => 'BP1.' + zlib.deflateSync(Buffer.from(JSON.stringify(json))).toString('base64url');
const good = (n = 2, name = 'x') => codeOf({
  v: 1, n: name,
  p: Array.from({ length: n }, (_, i) => { const r = row('crate'); r[4] = i * 3; return r; }),
  j: n > 1 ? [[0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0]] : [],
});
// a 1x1 png
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function units() {
  assert.equal(checkCode(good(3)), 3);
  assert.equal(checkCode('nope'), null);
  assert.equal(checkCode('BP1.'), null);
  assert.equal(checkCode('BP1.!!!'), null);
  assert.equal(checkCode(codeOf({ v: 1, p: [row('nuke')], j: [] })), null, 'unknown kind');
  assert.equal(checkCode(codeOf({ v: 2, p: [row()], j: [] })), null, 'version');
  assert.equal(checkCode(codeOf({ v: 1, p: [], j: [] })), null, 'no props');
  assert.equal(checkCode(codeOf({ v: 1, p: Array.from({ length: 301 }, () => row()), j: [] })), null, '301 props');
  assert.equal(checkCode(codeOf({ v: 1, p: [row('crate', {})].map((r) => { r[4] = 'x'; return r; }), j: [] })), null, 'nan pos');
  assert.equal(checkCode(codeOf({ v: 1, p: [row()].map((r) => { r[7] = r[8] = r[9] = r[10] = 0; return r; }), j: [] })), null, 'zero quat');
  assert.equal(checkCode(codeOf({ v: 1, p: [row(), row()], j: [[0, 1, 1, ...Array(17).fill(0)]] })), null, 'joint to itself');
  assert.equal(checkCode(codeOf({ v: 1, p: [row()], j: [[0, 0, 5, ...Array(17).fill(0)]] })), null, 'joint out of range');
  assert.equal(checkCode(zlib.deflateSync(Buffer.alloc(3 * 1024 * 1024, 32)).toString('base64url')), null);
  const bomb = 'BP1.' + zlib.deflateSync(Buffer.alloc(3 * 1024 * 1024, 32)).toString('base64url');
  assert.equal(checkCode(bomb), null, 'a decompression bomb is refused, not inflated');
  assert.equal(checkCode('BP1.' + 'A'.repeat(70 * 1024)), null, 'over 64 KB');
  assert.equal(checkThumb(PNG), PNG);
  assert.equal(checkThumb(''), '');
  assert.equal(checkThumb('data:image/png;base64,' + 'A'.repeat(30 * 1024)), null, 'thumb too big');
  assert.equal(checkThumb('data:image/jpeg;base64,AAAA'), null);
  assert.equal(checkThumb('data:image/png;base64,AAAAAAAAAAAAAAAAAAAA'), null, 'not really a png');
  assert.equal(checkThumb('javascript:alert(1)'), null);
  assert.equal(cleanName('  a\u0007\n b  '), 'a b');
  assert.equal(cleanName('x'.repeat(90)).length, 40);
  assert.equal(cleanName(5), '');
}

export async function buildsSmoke({ base, origin, user, admin, other }) {
  units();
  const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});
  const call = (method, path, { token, body, headers } = {}) =>
    fetch(base + path, {
      method,
      headers: { origin, 'content-type': 'application/json', ...auth(token), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const list = async (q = '') => (await call('GET', '/builds' + q)).json();

  // browse: empty, as a guest with no token at all
  let page = await list();
  assert.deepEqual(page.builds, []);
  assert.equal(page.total, 0);

  // publishing needs an account
  let r = await call('POST', '/builds', { body: { name: 'Guest car', code: good() } });
  assert.equal(r.status, 401, 'a guest cannot publish');
  r = await call('POST', '/builds', { token: 'bogus', body: { name: 'Guest car', code: good() } });
  assert.equal(r.status, 401);

  // refusals for an account
  r = await call('POST', '/builds', { token: user.token, body: { name: '   ', code: good() } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'name');
  r = await call('POST', '/builds', { token: user.token, body: { name: 'bad', code: 'BP1.AAAA' } });
  assert.equal((await r.json()).error, 'code');
  r = await call('POST', '/builds', { token: user.token, body: { name: 'bad', code: codeOf({ v: 1, p: [row('nuke')], j: [] }) } });
  assert.equal(r.status, 400, 'unknown kind refused');
  r = await call('POST', '/builds', { token: user.token, body: { name: 'bad', code: good(), thumb: 'data:image/png;base64,' + 'A'.repeat(30000) } });
  assert.equal((await r.json()).error, 'thumb');
  r = await call('POST', '/builds', { token: user.token, body: { name: 'bad', code: 'BP1.' + 'A'.repeat(120 * 1024) } });
  assert.equal(r.status, 413, 'a huge body is cut off');
  r = await call('POST', '/builds', { headers: { origin: 'https://evil.example' }, token: user.token, body: { name: 'x', code: good() } });
  assert.equal(r.status, 403, 'wrong origin');
  assert.equal((await list()).total, 0, 'nothing got in');

  // publish
  r = await call('POST', '/builds', { token: user.token, body: { name: '  Rocket\u0007 sled ', code: good(3), thumb: PNG } });
  assert.equal(r.status, 201);
  const first = (await r.json()).id;
  page = await list();
  assert.equal(page.total, 1);
  const b = page.builds[0];
  assert.equal(b.name, 'Rocket sled');
  assert.equal(b.author, user.name, 'the author is the account name, not what the client said');
  assert.equal(b.props, 3);
  assert.equal(b.thumb, PNG);
  assert.equal(b.code, undefined, 'the list carries no codes');

  // republishing a name replaces it and costs no slot
  r = await call('POST', '/builds', { token: user.token, body: { name: 'Rocket sled', code: good(4) } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).replaced, true);
  page = await list();
  assert.equal(page.total, 1);
  assert.equal(page.builds[0].props, 4);

  // pulls: the code comes back and counts once per person per ten minutes
  const one = await (await call('GET', `/builds/${first}`)).json();
  assert.ok(one.code.startsWith('BP1.'));
  assert.equal(checkCode(one.code), 4);
  assert.equal(one.spawns, 1);
  const again = await (await call('GET', `/builds/${first}`)).json();
  assert.equal(again.spawns, 1, 'a reload is not a second spawn');
  assert.equal((await call('GET', '/builds/99999')).status, 404);

  // the per-account cap: twenty builds, the twenty-first is refused
  for (let i = 2; i <= 20; i++) {
    r = await call('POST', '/builds', { token: user.token, body: { name: `Build ${i}`, code: good(1) } });
    assert.equal(r.status, 201, `build ${i}`);
  }
  assert.equal((await list()).total, 20);
  r = await call('POST', '/builds', { token: user.token, body: { name: 'One too many', code: good(1) } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).limit, 20);
  // a replacement still works at the cap
  r = await call('POST', '/builds', { token: user.token, body: { name: 'Build 7', code: good(2) } });
  assert.equal(r.status, 200);

  // paging and sort: newest first, ten a page; most spawned first
  page = await list();
  assert.equal(page.size, PAGE_SIZE);
  assert.ok(page.builds.length <= PAGE_SIZE);
  assert.ok(page.builds[0].at >= page.builds[page.builds.length - 1].at);
  const top = await list('?sort=top');
  assert.equal(top.builds[0].id, first, 'the pulled build leads the most-spawned list');

  // deleting: a stranger cannot, the author can, an admin can delete anyone's
  r = await call('DELETE', `/builds/${first}`, { token: other.token });
  assert.equal(r.status, 403, 'not your build');
  r = await call('DELETE', `/builds/${first}`);
  assert.equal(r.status, 401);
  r = await call('DELETE', `/builds/${first}`, { token: user.token });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `/builds/${first}`)).status, 404);
  const rest = await list();
  assert.equal(rest.total, 19);
  r = await call('DELETE', `/builds/${rest.builds[0].id}`, { token: admin.token });
  assert.equal(r.status, 200, 'an admin deletes any');
  assert.equal((await list()).total, 18);
  // the freed slot can be used again
  r = await call('POST', '/builds', { token: user.token, body: { name: 'Fresh', code: good(1) } });
  assert.equal(r.status, 201);
  const pre = await call('OPTIONS', '/builds', { headers: { 'access-control-request-method': 'DELETE' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /DELETE/);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);
}

/** the publish allowance on its own: a tiny one, an in-memory database */
export async function buildsRateSmoke() {
  const db = new Database(':memory:');
  let t = 1_000_000;
  const gallery = createBuildGallery({
    db, publishMax: 3, now: () => t,
    authenticate: (tok) => (tok === 'a' ? { username: 'ann', admin: false } : null),
  });
  const server = http.createServer((req, res) => { gallery.handleHttp(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (name) => fetch(base + '/builds', {
    method: 'POST', headers: { authorization: 'Bearer a', 'content-type': 'application/json' },
    body: JSON.stringify({ name, code: good(1) }),
  });
  for (let i = 0; i < 3; i++) assert.equal((await post(`n${i}`)).status, 201);
  assert.equal((await post('n3')).status, 429, 'the fourth publish in ten minutes is refused');
  t += 11 * 60_000;
  assert.equal((await post('n3')).status, 201, 'and allowed again later');
  gallery.stop();
  await new Promise((r) => server.close(r));
  db.close();
}
