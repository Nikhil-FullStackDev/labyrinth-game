const test = require('node:test');
const assert = require('node:assert');
const server = require('../server.js');

let B;
test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  B = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections?.(); server.close(); });

const post = async (p, body) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
async function firstSnap(code, token) {
  const ctl = new AbortController();
  const res = await fetch(`${B}/api/events?code=${code}&token=${token}`, { signal: ctl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value } = await reader.read();
    buf += dec.decode(value);
    const m = buf.match(/data: (.*)\n\n/);
    if (m) { ctl.abort(); return JSON.parse(m[1]); }
  }
}

test('health and static files', async () => {
  assert.strictEqual((await fetch(B + '/healthz')).status, 200);
  const html = await fetch(B + '/');
  assert.strictEqual(html.status, 200);
  assert.match(await html.text(), /Labyrinth/);
  const img = await fetch(B + '/img/tile-T.webp');
  assert.strictEqual(img.headers.get('content-type'), 'image/webp');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.strictEqual((await fetch(B + '/server.js')).status, 404);
  assert.strictEqual((await fetch(B + '/%2e%2e/server.js')).status, 404);
});

test('lobby: create, join, bots, host-only controls, capacity', async () => {
  const a = (await post('/api/create', { name: 'Host' })).body;
  assert.match(a.code, /^[A-Z]{4}$/);
  assert.strictEqual((await post('/api/start', { code: a.code, token: a.token })).status, 400); // 1 player
  const b = (await post('/api/join', { code: a.code, name: 'Guest' })).body;
  assert.strictEqual((await post('/api/addbot', { code: a.code, token: b.token })).status, 403);
  assert.strictEqual((await post('/api/addbot', { code: a.code, token: a.token })).status, 200);
  assert.strictEqual((await post('/api/addbot', { code: a.code, token: a.token })).status, 200);
  assert.strictEqual((await post('/api/addbot', { code: a.code, token: a.token })).status, 400); // full at 4
  assert.strictEqual((await post('/api/join', { code: a.code, name: 'Late' })).status, 400);
  const snap = await firstSnap(a.code, a.token);
  assert.deepStrictEqual(snap.lobby.map(p => p.name), ['Host', 'Guest', 'Ada (bot)', 'Bram (bot)']);
  assert.strictEqual(snap.game, null);
  assert.strictEqual((await post('/api/join', { code: 'ZZZZ', name: 'x' })).status, 404);
});

test('game: only own cards are sent, turn order enforced, lobby return', async () => {
  const a = (await post('/api/create', { name: 'Host' })).body;
  const b = (await post('/api/join', { code: a.code, name: 'Guest' })).body;
  assert.strictEqual((await post('/api/start', { code: a.code, token: a.token })).status, 200);
  const sa = await firstSnap(a.code, a.token), sb = await firstSnap(a.code, b.token);
  assert.ok(sa.game.players[0].cards && !sa.game.players[1].cards);
  assert.ok(sb.game.players[1].cards && !sb.game.players[0].cards);
  const bad = await post('/api/act', { code: a.code, token: b.token, a: { type: 'insert', slot: 'N1', rot: 0 } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await post('/api/act', { code: a.code, token: 'nope', a: {} })).status, 403);
  const ok = await post('/api/act', { code: a.code, token: a.token, a: { type: 'insert', slot: 'N1', rot: 0 } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await firstSnap(a.code, a.token)).game.phase, 'move');
  assert.strictEqual((await post('/api/lobby', { code: a.code, token: a.token })).status, 200);
  assert.strictEqual((await firstSnap(a.code, a.token)).game, null);
});

test('a bot seat plays by itself', async () => {
  const a = (await post('/api/create', { name: 'Host' })).body;
  await post('/api/addbot', { code: a.code, token: a.token });
  await post('/api/start', { code: a.code, token: a.token });
  await post('/api/act', { code: a.code, token: a.token, a: { type: 'insert', slot: 'N3', rot: 1 } });
  await post('/api/act', { code: a.code, token: a.token, a: { type: 'move', to: [0, 0] } });
  await new Promise(r => setTimeout(r, 3500)); // bot: insert (~1.5s) + move (~1.2s)
  const s = await firstSnap(a.code, a.token);
  assert.strictEqual(s.game.seq, 4);
  assert.strictEqual(s.game.turn, 0);
});
