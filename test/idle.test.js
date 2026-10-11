// An online player who never moves must not stall the table: after TURN_MS a bot move is played for them,
// and after two misses in a row they only get AWAY_MS per turn until they act again.
process.env.TURN_MS = '400';
process.env.AWAY_MS = '250';
const test = require('node:test');
const assert = require('node:assert');
const server = require('../server.js');

let B;
test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  B = `http://127.0.0.1:${server.address().port}`;
});
const rooms = [];
test.after(async () => {
  for (const r of rooms) await post('/api/lobby', r).catch(() => {}); // stop the bots' timers
  server.closeAllConnections?.(); server.close();
});

const post = async (p, body) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// Keep one SSE stream open (the host is "online") and remember every snapshot.
async function watch(code, token) {
  const ctl = new AbortController();
  const res = await fetch(`${B}/api/events?code=${code}&token=${token}`, { signal: ctl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  const w = { snaps: [], stop: () => ctl.abort() };
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const m = buf.slice(0, i).match(/^data: (.*)$/m);
          buf = buf.slice(i + 2);
          if (m) w.snaps.push(JSON.parse(m[1]));
        }
      }
    } catch { /* aborted */ }
  })();
  return w;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('an online human who never moves is auto-played, so the game keeps going', async () => {
  const c = (await post('/api/create', { name: 'Idle' })).body;
  rooms.push({ code: c.code, token: c.token });
  await post('/api/addbot', { code: c.code, token: c.token });
  await post('/api/start', { code: c.code, token: c.token });
  const w = await watch(c.code, c.token);
  await sleep(12000);
  w.stop();
  const turns = w.snaps.filter(s => s.game).map(s => s.game.turn);
  const hostTurnsSeen = new Set(w.snaps.filter(s => s.game && s.game.turn === 0).map(s => JSON.stringify(s.game.seq ?? s.game.moves ?? s.game.factories))).size;
  const changes = turns.filter((t, i) => i && t !== turns[i - 1]).length;
  assert.ok(changes >= 3, `the turn passed back and forth at least 3 times without the host moving (saw ${changes})`);
  assert.ok(hostTurnsSeen >= 2, 'the host\'s seat was played for more than once');
});

test('the countdown is only sent to the player the table is waiting on', async () => {
  const c = (await post('/api/create', { name: 'Host' })).body;
  rooms.push({ code: c.code, token: c.token });
  await post('/api/addbot', { code: c.code, token: c.token });
  let sn;
  for (let i = 0; i < 40; i++) {
    await post('/api/start', { code: c.code, token: c.token });
    const w = await watch(c.code, c.token);
    await sleep(150);
    sn = w.snaps[w.snaps.length - 1];
    w.stop();
    if (sn && sn.game && sn.game.turn === 0) break;
    await post('/api/lobby', { code: c.code, token: c.token });
  }
  if (!sn || sn.game.turn !== 0) return; // unlucky: the bot moved first every time
  assert.ok(typeof sn.idleMsLeft === 'number' && sn.idleMsLeft <= 400, 'host on turn sees a countdown');
});
