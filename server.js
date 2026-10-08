// Zero-dependency server: static files + online rooms (REST + Server-Sent Events).
// Tuned for Render's free tier: no build step, static files held in memory pre-gzipped
// with ETags, long-cached images, idle rooms reaped.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const G = require('./public/game.js');
const { plan } = require('./public/bot.js');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '::');
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const MAX_ROOMS = 200, MAX_STREAMS_PER_SEAT = 3, MAX_CREATE_PER_HOUR = 30, TAKEOVER_MS = 25e3;
const NAMES = ['Ada', 'Bram', 'Cleo', 'Dax'];

// ---------- static files (loaded once) ----------
const files = new Map();
(function load(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) { load(full); continue; }
    const ext = path.extname(f.name), type = MIME[ext];
    if (!type) continue;
    const body = fs.readFileSync(full);
    const binary = ext === '.webp' || ext === '.png';
    files.set('/' + path.relative(PUBLIC, full).split(path.sep).join('/'), {
      type, body, gz: binary ? null : zlib.gzipSync(body, { level: 9 }),
      etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"',
      cache: binary ? 'public, max-age=2592000, immutable' : 'no-cache',
    });
  }
})(PUBLIC);

function serveStatic(req, res, pathname) {
  const f = files.get(pathname === '/' ? '/index.html' : pathname);
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  const headers = { 'Content-Type': f.type, 'Cache-Control': f.cache, ETag: f.etag, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
  if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
    return res.end(f.gz);
  }
  res.writeHead(200, headers);
  res.end(f.body);
}

// ---------- rooms ----------
const rooms = new Map();
const creates = new Map(); // ip -> {n, reset}

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = n => String(n || '').replace(/[^\w \-']/g, '').trim().slice(0, 14) || 'Player';
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

function newRoom(hostName) {
  const room = { code: makeCode(), players: [], state: null, streams: new Map(), gone: new Map(), touched: Date.now(), botTimer: null };
  addPlayer(room, hostName, false);
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name, bot) {
  const p = { name, bot, token: bot ? null : crypto.randomBytes(8).toString('hex') };
  room.players.push(p);
  return p;
}

function snapshot(room, idx) {
  return {
    code: room.code, you: idx, host: idx === 0,
    lobby: room.players.map((p, i) => ({ name: p.name, bot: p.bot, connected: p.bot || room.streams.has(i), color: G.COLORS[i] })),
    game: room.state ? G.view(room.state, idx) : null,
  };
}
function broadcast(room) {
  room.touched = Date.now();
  room.streams.forEach((set, idx) => {
    const data = `data: ${JSON.stringify(snapshot(room, idx))}\n\n`;
    set.forEach(res => res.write(data));
  });
  scheduleBots(room);
}

// A bot plays for bot seats, and for a human who has been offline for a while (so a dropped phone never stalls the table).
function botShouldPlay(room) {
  const s = room.state;
  if (!s || s.winner !== null) return false;
  const p = room.players[s.turn];
  if (p.bot) return true;
  const t = room.gone.get(s.turn);
  return !room.streams.has(s.turn) && t && Date.now() - t > TAKEOVER_MS;
}
function scheduleBots(room) {
  clearTimeout(room.botTimer);
  room.botTimer = null;
  const s = room.state;
  if (!botShouldPlay(room)) return;
  const [lo, hi] = s.phase === 'insert' ? [900, 1500] : [700, 1200];
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.state !== s || !botShouldPlay(room)) return;
    const id = s.turn;
    let a = plan(s, id), r = a && G.act(s, id, a);
    if (!r || r.error) r = G.act(s, id, fallback(s, id));
    broadcast(room);
  }, lo + Math.random() * (hi - lo));
}
// Never let a bot stall the table.
function fallback(s, id) {
  if (s.phase === 'move') return { type: 'move', to: s.players[id].pos };
  return { type: 'insert', slot: G.SLOTS.find(x => !s.last || x !== G.oppositeSlot(s.last)), rot: 0 };
}
// Picks up humans who just crossed the offline threshold.
setInterval(() => rooms.forEach(room => { if (!room.botTimer && botShouldPlay(room)) scheduleBots(room); }), 2000).unref();

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const auth = (room, token) => room ? room.players.findIndex(p => p.token && p.token === token) : -1;

async function api(req, res, url) {
  if (url.pathname === '/api/events') {
    const room = rooms.get(String(url.searchParams.get('code')).toUpperCase());
    const idx = auth(room, url.searchParams.get('token'));
    if (idx < 0) return json(res, 404, { error: 'Room not found' });
    if (!room.streams.has(idx)) room.streams.set(idx, new Set());
    const set = room.streams.get(idx);
    if (set.size >= MAX_STREAMS_PER_SEAT) [...set][0].end(); // stale tabs
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    set.add(res);
    room.gone.delete(idx);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      const cur = room.streams.get(idx);
      if (cur) { cur.delete(res); if (!cur.size) { room.streams.delete(idx); room.gone.set(idx, Date.now()); } }
      broadcast(room);
    });
    broadcast(room);
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const b = await readBody(req);

  if (url.pathname === '/api/create') {
    const ip = clientIp(req), now = Date.now();
    let c = creates.get(ip);
    if (!c || now > c.reset) c = { n: 0, reset: now + 3600e3 };
    creates.set(ip, c);
    if (++c.n > MAX_CREATE_PER_HOUR) return json(res, 429, { error: 'Too many rooms, try later' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Server busy, try again later' });
    const room = newRoom(cleanName(b.name));
    return json(res, 200, { code: room.code, token: room.players[0].token });
  }
  const room = rooms.get(String(b.code || '').toUpperCase());
  if (!room) return json(res, 404, { error: 'Room not found' });

  if (url.pathname === '/api/join') {
    if (room.state) return json(res, 400, { error: 'Game already started' });
    if (room.players.length >= G.MAX_PLAYERS) return json(res, 400, { error: 'Room full' });
    const p = addPlayer(room, cleanName(b.name), false);
    broadcast(room);
    return json(res, 200, { code: room.code, token: p.token });
  }
  const me = auth(room, b.token);
  if (me < 0) return json(res, 403, { error: 'Bad token' });

  if (url.pathname === '/api/ping') return json(res, 200, { ok: true });
  if (url.pathname === '/api/act') {
    if (!room.state) return json(res, 400, { error: 'Not started' });
    const r = G.act(room.state, me, b.a || {});
    if (r.error) return json(res, 400, r);
    broadcast(room);
    return json(res, 200, r);
  }
  if (url.pathname === '/api/leave') { // polite exit: a bot takes the seat mid-game, or the seat is freed in the lobby
    if (me === 0) return json(res, 400, { error: 'Host cannot leave' });
    if (room.state) { const p = room.players[me]; p.bot = true; p.token = null; p.name += ' (bot)'; room.state.players[me].bot = true; room.state.players[me].name = p.name; }
    else room.players.splice(me, 1);
    room.streams.forEach(set => set.forEach(r => r.end()));
    room.streams.clear(); room.gone.clear();
    broadcast(room);
    return json(res, 200, { ok: true });
  }
  // host-only below
  if (me !== 0) return json(res, 403, { error: 'Host only' });
  if (url.pathname === '/api/addbot') {
    if (room.state || room.players.length >= G.MAX_PLAYERS) return json(res, 400, { error: 'Cannot add' });
    addPlayer(room, NAMES.find(n => !room.players.some(p => p.name === n + ' (bot)')) + ' (bot)', true);
  } else if (url.pathname === '/api/kick') {
    const i = Number(b.index);
    if (room.state || !(i > 0 && i < room.players.length)) return json(res, 400, { error: 'Cannot remove' });
    room.streams.forEach(set => set.forEach(r => r.end())); // clients reconnect with their new index
    room.players.splice(i, 1);
    room.streams.clear(); room.gone.clear();
  } else if (url.pathname === '/api/start') {
    if (room.players.length < G.MIN_PLAYERS) return json(res, 400, { error: `Need ${G.MIN_PLAYERS}+ players` });
    clearTimeout(room.botTimer);
    room.state = G.create(room.players);
  } else if (url.pathname === '/api/replace') { // hand a disconnected player over to a bot
    const i = Number(b.index), p = room.players[i];
    if (!p || p.bot || i === 0) return json(res, 400, { error: 'Cannot replace' });
    p.bot = true; p.token = null; p.name += ' (bot)';
    if (room.state) { room.state.players[i].bot = true; room.state.players[i].name = p.name; }
    room.streams.get(i)?.forEach(r => r.end());
  } else if (url.pathname === '/api/lobby') { // back to lobby after a game
    clearTimeout(room.botTimer);
    room.state = null;
  } else return json(res, 404, { error: 'Unknown' });
  broadcast(room);
  json(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(() => json(res, 500, { error: 'Server error' }));
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url.pathname);
});
server.keepAliveTimeout = 65000; // outlive Render's proxy keep-alive

// Reap idle rooms so memory stays flat.
setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, c) => { if (!r.streams.size && now - r.touched > 2 * 3600e3) { clearTimeout(r.botTimer); rooms.delete(c); } });
  creates.forEach((v, k) => { if (now > v.reset) creates.delete(k); });
}, 600e3).unref();

if (require.main === module) server.listen(PORT, HOST, () => console.log(`Labyrinth on http://localhost:${PORT}`));
module.exports = server;
