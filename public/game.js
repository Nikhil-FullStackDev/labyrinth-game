// Labyrinth rules engine. Pure functions on plain JSON state, shared by server, bots and browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lab = factory();
})(this, function () {
  const DR = [-1, 0, 1, 0], DC = [0, 1, 0, -1]; // N E S W
  const BASE = { I: [0, 2], L: [0, 1], T: [0, 1, 2] }; // openings at rotation 0
  const MASK = {};
  for (const t in BASE) MASK[t] = [0, 1, 2, 3].map(r => BASE[t].reduce((m, d) => m | (1 << ((d + r) % 4)), 0));
  const SLOTS = ['N1', 'N3', 'N5', 'E1', 'E3', 'E5', 'S1', 'S3', 'S5', 'W1', 'W3', 'W5'];
  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const COLORS = ['#e5484d', '#3e8bff', '#2fb36d', '#f5b800'];
  const TREASURES = ['book', 'candlestick', 'crown', 'dragon', 'ghost', 'key', 'magic-lamp', 'mirror', 'mouse', 'ring', 'treasure-chest', 'witch-hat'];
  const TREASURE_LABELS = ['Book', 'Candlestick', 'Crown', 'Dragon', 'Ghost', 'Key', 'Magic lamp', 'Mirror', 'Mouse', 'Ring', 'Treasure chest', 'Witch hat'];
  const CORNERS = [[0, 0], [6, 6], [0, 6], [6, 0]]; // 2 players sit opposite each other
  const MIN_PLAYERS = 2, MAX_PLAYERS = 4;

  const mask = t => MASK[t.t][t.r];
  const inb = (r, c) => r >= 0 && r < 7 && c >= 0 && c < 7;
  const oppositeSlot = s => OPPOSITE[s[0]] + s[1];

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // Fixed tiles: [row, col, type, rotation, hasTreasure]
  const FIXED = [
    [0, 0, 'L', 1], [0, 6, 'L', 2], [6, 6, 'L', 3], [6, 0, 'L', 0],
    [0, 2, 'T', 1, 1], [0, 4, 'T', 1], [2, 6, 'T', 2], [4, 6, 'T', 2],
    [6, 4, 'T', 3, 1], [6, 2, 'T', 3], [2, 0, 'T', 0], [4, 0, 'T', 0],
    [2, 2, 'T', 1, 1], [2, 4, 'T', 2, 1], [4, 4, 'T', 3, 1], [4, 2, 'T', 0, 1],
  ];

  function create(players, seed) {
    const n = players.length;
    if (n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error('2-4 players');
    const rnd = mulberry(seed == null ? (Math.random() * 2 ** 32) >>> 0 : seed);
    const ids = shuffle(TREASURES.map((_, i) => i), rnd);
    let k = 0, tid = 0;
    const board = Array.from({ length: 7 }, () => Array(7).fill(null));
    for (const [r, c, t, rot, tr] of FIXED) board[r][c] = { i: tid++, t, r: rot, x: tr ? ids[k++] : -1 };
    const mov = [];
    const add = (t, count, withTreasure) => {
      for (let i = 0; i < count; i++) mov.push({ i: 0, t, r: Math.floor(rnd() * 4), x: i < withTreasure ? ids[k++] : -1 });
    };
    add('T', 6, 3); add('L', 15, 3); add('I', 13, 0);
    shuffle(mov, rnd);
    for (const m of mov) m.i = tid++;
    // The starting spare never carries a treasure, so nobody is confused about it.
    const free = mov.findIndex(m => m.x < 0);
    [mov[free], mov[mov.length - 1]] = [mov[mov.length - 1], mov[free]];
    const spare = mov.pop();
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) if (!board[r][c]) board[r][c] = mov.pop();

    const deck = shuffle(TREASURES.map((_, i) => i), rnd);
    const per = TREASURES.length / n;
    const ps = players.map((p, i) => ({
      id: i, name: p.name, bot: !!p.bot, color: COLORS[i],
      pos: CORNERS[i].slice(), home: CORNERS[i].slice(),
      cards: deck.slice(i * per, (i + 1) * per), got: 0,
    }));
    return { board, spare, players: ps, turn: 0, phase: 'insert', last: null, winner: null, found: [], seq: 0, ev: null, moves: 0 };
  }

  // Insert the spare at a slot; returns nothing, mutates state.
  function push(state, slot) {
    const side = slot[0], i = +slot[1], b = state.board, sp = state.spare;
    let out;
    if (side === 'N') {
      out = b[6][i]; for (let r = 6; r > 0; r--) b[r][i] = b[r - 1][i]; b[0][i] = sp;
      for (const p of state.players) if (p.pos[1] === i) p.pos = [p.pos[0] === 6 ? 0 : p.pos[0] + 1, i];
    } else if (side === 'S') {
      out = b[0][i]; for (let r = 0; r < 6; r++) b[r][i] = b[r + 1][i]; b[6][i] = sp;
      for (const p of state.players) if (p.pos[1] === i) p.pos = [p.pos[0] === 0 ? 6 : p.pos[0] - 1, i];
    } else if (side === 'W') {
      out = b[i][6]; for (let c = 6; c > 0; c--) b[i][c] = b[i][c - 1]; b[i][0] = sp;
      for (const p of state.players) if (p.pos[0] === i) p.pos = [i, p.pos[1] === 6 ? 0 : p.pos[1] + 1];
    } else {
      out = b[i][0]; for (let c = 0; c < 6; c++) b[i][c] = b[i][c + 1]; b[i][6] = sp;
      for (const p of state.players) if (p.pos[0] === i) p.pos = [i, p.pos[1] === 0 ? 6 : p.pos[1] - 1];
    }
    state.spare = out;
  }

  // BFS over connected corridors. dist[r*7+c] = steps or -1; prev for path rebuild.
  function reach(state, from) {
    const dist = new Int8Array(49).fill(-1), prev = new Int8Array(49).fill(-1), q = [from[0] * 7 + from[1]];
    dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const cur = q[h], r = (cur / 7) | 0, c = cur % 7, m = mask(state.board[r][c]);
      for (let d = 0; d < 4; d++) {
        if (!(m & (1 << d))) continue;
        const nr = r + DR[d], nc = c + DC[d];
        if (!inb(nr, nc)) continue;
        const k = nr * 7 + nc;
        if (dist[k] >= 0 || !(mask(state.board[nr][nc]) & (1 << ((d + 2) % 4)))) continue;
        dist[k] = dist[cur] + 1; prev[k] = cur; q.push(k);
      }
    }
    return { dist, prev };
  }
  function pathTo(R, to) {
    const out = [];
    for (let k = to[0] * 7 + to[1]; k >= 0; k = R.prev[k]) out.push([(k / 7) | 0, k % 7]);
    return out.reverse();
  }

  const targetOf = p => (p.got < p.cards.length ? { tr: p.cards[p.got] } : { home: p.home });
  function locate(state, tr) {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) if (state.board[r][c].x === tr) return [r, c];
    return null; // on the spare tile
  }

  // action: {type:'insert', slot, rot} | {type:'move', to:[r,c]}. Returns {ok:true} or {error}.
  function act(state, pid, a) {
    if (state.winner !== null) return { error: 'Game over' };
    if (state.turn !== pid) return { error: 'Not your turn' };
    const p = state.players[pid];
    if (a.type === 'insert') {
      if (state.phase !== 'insert') return { error: 'Move your pawn first' };
      if (!SLOTS.includes(a.slot)) return { error: 'Bad slot' };
      if (state.last && a.slot === oppositeSlot(state.last)) return { error: "Can't undo the last push" };
      if (!Number.isInteger(a.rot) || a.rot < 0 || a.rot > 3) return { error: 'Bad rotation' };
      state.spare.r = a.rot;
      push(state, a.slot);
      state.last = a.slot; state.phase = 'move'; state.seq++;
      state.ev = { k: 'push', slot: a.slot, by: pid };
      // Boxed in after the push: nothing to choose, so the move is taken (staying put) automatically.
      const R = reach(state, p.pos);
      if (R.dist.reduce((n, d) => n + (d >= 0 ? 1 : 0), 0) === 1) {
        act(state, pid, { type: 'move', to: p.pos });
        if (state.ev) state.ev.auto = true;
      }
      return { ok: true };
    }
    if (a.type === 'move') {
      if (state.phase !== 'move') return { error: 'Insert the tile first' };
      const to = a.to;
      if (!Array.isArray(to) || !inb(to[0], to[1]) || !Number.isInteger(to[0]) || !Number.isInteger(to[1])) return { error: 'Bad target' };
      const R = reach(state, p.pos);
      if (R.dist[to[0] * 7 + to[1]] < 0) return { error: 'Unreachable' };
      const path = pathTo(R, to);
      p.pos = [to[0], to[1]];
      let got = false;
      const tile = state.board[to[0]][to[1]];
      if (p.got < p.cards.length && tile.x === p.cards[p.got]) { p.got++; state.found.push(tile.x); got = true; }
      state.seq++; state.moves++;
      state.ev = { k: 'move', by: pid, path, got: got ? tile.x : -1 };
      if (p.got === p.cards.length && to[0] === p.home[0] && to[1] === p.home[1]) {
        state.winner = pid;
        state.ev.win = true;
      } else {
        state.turn = (pid + 1) % state.players.length; state.phase = 'insert';
      }
      return { ok: true };
    }
    return { error: 'Unknown action' };
  }

  // What a given seat may see: everything public + own cards (others' cards stay hidden).
  function view(state, idx) {
    return {
      board: state.board, spare: state.spare, turn: state.turn, phase: state.phase, last: state.last,
      winner: state.winner, found: state.found, seq: state.seq, ev: state.ev, moves: state.moves, you: idx,
      players: state.players.map(p => ({
        id: p.id, name: p.name, bot: p.bot, color: p.color, pos: p.pos, home: p.home,
        total: p.cards.length, got: p.got,
        ...(p.id === idx || state.winner !== null ? { cards: p.cards } : {}),
      })),
    };
  }

  // Cheap copy for bot look-ahead: tiles are shared, only the spare gets re-rotated.
  function sim(state) {
    return {
      board: state.board.map(r => r.slice()), spare: { ...state.spare }, last: state.last,
      players: state.players.map(p => ({ ...p, pos: p.pos.slice() })),
    };
  }

  return {
    SLOTS, COLORS, TREASURES, TREASURE_LABELS, MIN_PLAYERS, MAX_PLAYERS,
    mask, oppositeSlot, create, push, reach, pathTo, targetOf, locate, act, view, sim,
  };
});
