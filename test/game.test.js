const test = require('node:test');
const assert = require('node:assert');
const G = require('../public/game.js');
const { plan } = require('../public/bot.js');

const mk = (n, seed = 7) => G.create(Array.from({ length: n }, (_, i) => ({ name: 'P' + i })), seed);
const tiles = s => [...s.board.flat(), s.spare];

test('tile set matches the real game: 13 I, 15 L, 6 T movable + 16 fixed', () => {
  const s = mk(2), all = tiles(s);
  assert.strictEqual(all.length, 50);
  const count = t => all.filter(x => x.t === t).length;
  assert.deepStrictEqual([count('I'), count('L'), count('T')], [13, 19, 18]);
  assert.strictEqual(new Set(all.map(t => t.i)).size, 50);
  assert.strictEqual(all.filter(t => t.x >= 0).length, 12);
  assert.strictEqual(new Set(all.map(t => t.x).filter(x => x >= 0)).size, 12);
});

test('fixed tiles sit on even squares; corners are L tiles that open inward', () => {
  const s = mk(4);
  for (const [r, c] of [[0, 0], [0, 6], [6, 0], [6, 6]]) {
    const t = s.board[r][c];
    assert.strictEqual(t.t, 'L');
    const m = G.mask(t), dr = r === 0 ? 2 : 0, dc = c === 0 ? 1 : 3;
    assert.ok(m & (1 << dr) && m & (1 << dc), `corner ${r},${c} must open inward`);
  }
  for (let r = 0; r < 7; r += 2) for (let c = 0; c < 7; c += 2) assert.ok(s.board[r][c].i < 16);
});

test('cards split evenly and are hidden from other seats', () => {
  for (const n of [2, 3, 4]) {
    const s = mk(n);
    assert.ok(s.players.every(p => p.cards.length === 12 / n));
    assert.strictEqual(new Set(s.players.flatMap(p => p.cards)).size, 12);
  }
  const v = G.view(mk(3), 1);
  assert.ok(v.players[1].cards && !v.players[0].cards && !v.players[2].cards);
  assert.ok(!JSON.stringify(v).includes('"deck"'));
});

test('push shifts the line, ejects the far tile, wraps pawns', () => {
  const s = mk(2);
  const spare = s.spare, col = [0, 1, 2, 3, 4, 5, 6].map(r => s.board[r][1]);
  s.players[0].pos = [6, 1]; s.players[1].pos = [3, 1];
  G.push(s, 'N1');
  assert.strictEqual(s.board[0][1], spare);
  for (let r = 1; r < 7; r++) assert.strictEqual(s.board[r][1], col[r - 1]);
  assert.strictEqual(s.spare, col[6]);
  assert.deepStrictEqual(s.players[0].pos, [0, 1]); // rode the ejected tile round
  assert.deepStrictEqual(s.players[1].pos, [4, 1]);
  G.push(s, 'E3'); // row 3 pushed leftwards
  assert.strictEqual(s.board[3][6].i, col[6].i);
});

test('every slot push is its own inverse via the opposite slot', () => {
  for (const slot of G.SLOTS) {
    const s = mk(2), before = JSON.stringify([s.board, s.spare]);
    G.push(s, slot); G.push(s, G.oppositeSlot(slot));
    assert.strictEqual(JSON.stringify([s.board, s.spare]), before, slot);
  }
});

test('turn order, undo ban, and move validation', () => {
  const s = mk(2);
  assert.ok(G.act(s, 1, { type: 'insert', slot: 'N1', rot: 0 }).error); // wrong player
  assert.ok(G.act(s, 0, { type: 'move', to: [0, 0] }).error);           // must insert first
  assert.ok(G.act(s, 0, { type: 'insert', slot: 'Z9', rot: 0 }).error);
  assert.ok(G.act(s, 0, { type: 'insert', slot: 'N1', rot: 7 }).error);
  assert.ok(!G.act(s, 0, { type: 'insert', slot: 'N1', rot: 2 }).error);
  assert.ok(G.act(s, 0, { type: 'insert', slot: 'N3', rot: 0 }).error); // already inserted
  assert.ok(G.act(s, 0, { type: 'move', to: [9, 9] }).error);
  assert.ok(G.act(s, 0, { type: 'move', to: [1.5, 2] }).error);
  assert.ok(!G.act(s, 0, { type: 'move', to: s.players[0].pos.slice() }).error); // staying put is legal
  assert.strictEqual(s.turn, 1);
  assert.ok(G.act(s, 1, { type: 'insert', slot: 'S1', rot: 0 }).error);          // would undo N1
  assert.ok(!G.act(s, 1, { type: 'insert', slot: 'S3', rot: 0 }).error);
});

test('reach respects walls and the reported path is contiguous and open', () => {
  const s = mk(2), R = G.reach(s, s.players[0].pos);
  for (let k = 0; k < 49; k++) {
    if (R.dist[k] < 0) continue;
    const path = G.pathTo(R, [(k / 7) | 0, k % 7]);
    assert.strictEqual(path.length, R.dist[k] + 1);
    for (let i = 1; i < path.length; i++) {
      const [a, b] = [path[i - 1], path[i]], dr = b[0] - a[0], dc = b[1] - a[1];
      assert.strictEqual(Math.abs(dr) + Math.abs(dc), 1);
      const d = dr === -1 ? 0 : dc === 1 ? 1 : dr === 1 ? 2 : 3;
      assert.ok(G.mask(s.board[a[0]][a[1]]) & (1 << d));
      assert.ok(G.mask(s.board[b[0]][b[1]]) & (1 << ((d + 2) % 4)));
    }
  }
});

test('collecting treasures in order, then winning at home', () => {
  const s = mk(2);
  const p = s.players[0];
  p.cards = [s.board[2][2].x]; p.got = 0;           // one treasure left to find
  assert.ok(p.cards[0] >= 0);
  p.pos = [2, 2]; s.phase = 'move'; s.turn = 0;
  G.act(s, 0, { type: 'move', to: [2, 2] });
  assert.strictEqual(p.got, 1);
  assert.deepStrictEqual(s.found, [p.cards[0]]);
  assert.strictEqual(s.winner, null);
  s.turn = 0; s.phase = 'move'; p.pos = p.home.slice();
  G.act(s, 0, { type: 'move', to: p.home });
  assert.strictEqual(s.winner, 0);
  assert.ok(G.act(s, 1, { type: 'insert', slot: 'N1', rot: 0 }).error);
});

test('treasures out of order do not count', () => {
  const s = mk(2), p = s.players[0];
  const other = p.cards[1];
  const at = G.locate(s, other);
  if (!at) return; // on the spare, nothing to check for this seed
  p.pos = at; s.phase = 'move'; s.turn = 0;
  G.act(s, 0, { type: 'move', to: at });
  assert.strictEqual(p.got, 0);
});

test('bots finish whole games for 2, 3 and 4 players', () => {
  for (const n of [2, 3, 4]) {
    for (let seed = 1; seed <= 3; seed++) {
      const s = mk(n, seed * 101);
      let turns = 0;
      while (s.winner === null && turns++ < 3000) {
        const a = plan(s, s.turn);
        const r = G.act(s, s.turn, a);
        assert.ok(!r.error, `${n}p seed ${seed}: ${JSON.stringify(a)} -> ${r.error}`);
      }
      assert.notStrictEqual(s.winner, null, `${n}p seed ${seed} did not finish`);
      assert.strictEqual(s.players[s.winner].got, s.players[s.winner].cards.length);
    }
  }
});

test('the starting spare tile never has a treasure', () => {
  for (let seed = 1; seed <= 300; seed++) assert.strictEqual(mk(2 + (seed % 3), seed).spare.x, -1, `seed ${seed}`);
});
