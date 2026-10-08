(() => {
  'use strict';
  const RING = 0.65; // must match --ring in style.css
  const ARROW_ROT = { N: 0, E: 90, S: 180, W: 270 }; // triangle points toward the board
  const STEP_MS = 130;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const buzz = p => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* unsupported */ } };

  const app = $('#app');
  let toastT;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------- session state ----------
  let name = store.get('lab-name') || '';
  let local = null;          // {S, bots, timer} when playing offline against bots
  let net = null;            // {code, token, es, snap} when online
  let ui = null;             // built game UI (null when not in a game)
  let view = null, you = 0, snap = null;
  let selSlot = null, selTo = null, spareRot = 0, lastSpareId = -1;
  let lastSeq = -1, lockUntil = 0, busy = false, wasMyTurn = false, overShown = false;
  const override = new Set();

  // ---------- home ----------
  function home(msg) {
    destroyGame();
    const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
    let bots = +store.get('lab-bots') || 2;
    app.innerHTML = `<div class="page">
      <div class="logo"><img src="img/tr-dragon.webp" alt=""><h1>Labyrinth</h1><p>Slide the maze. Find your treasures. Race home.</p></div>
      <div class="card"><h2>Your name</h2><input id="nm" class="field" maxlength="14" placeholder="Adventurer" value="${esc(name)}" autocomplete="nickname"></div>
      <div class="card"><h2>Play vs bots</h2>
        <div class="seg" id="seg">${[1, 2, 3].map(n => `<button data-n="${n}" class="${n === bots ? 'on' : ''}">${n} bot${n > 1 ? 's' : ''}</button>`).join('')}</div>
        <button class="btn pri" id="solo">Start game</button></div>
      <div class="card"><h2>Play with friends</h2>
        <button class="btn pri" id="create">Create room</button>
        <div class="row"><input id="code" class="field" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off" value="${esc(room)}" style="text-transform:uppercase;letter-spacing:.2em;text-align:center">
        <button class="btn" id="join">Join</button></div></div>
      <div class="err" id="err">${esc(msg || '')}</div>
      <button class="btn sm" id="how">How to play</button>
    </div>`;
    const err = m => { $('#err').textContent = m; };
    const nm = () => { name = $('#nm').value.trim().slice(0, 14) || 'You'; store.set('lab-name', name); return name; };
    $('#seg').onclick = e => { const b = e.target.closest('button'); if (!b) return; bots = +b.dataset.n; store.set('lab-bots', bots); [...$('#seg').children].forEach(x => x.classList.toggle('on', x === b)); };
    $('#solo').onclick = () => startLocal(nm(), bots);
    $('#create').onclick = async () => {
      const r = await call('/api/create', { name: nm() });
      if (r.error) return err(r.error);
      goOnline(r.code, r.token);
    };
    $('#join').onclick = async () => {
      const code = $('#code').value.trim().toUpperCase();
      if (code.length !== 4) return err('Enter the 4-letter room code');
      const r = await call('/api/join', { code, name: nm() });
      if (r.error) return err(r.error);
      goOnline(r.code, r.token);
    };
    $('#how').onclick = howTo;
  }

  async function call(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch { return { error: 'No connection. Check your network and try again.' }; }
  }

  function howTo() {
    sheet(`<h2>How to play</h2><ul>
      <li><b>Each turn:</b> rotate the spare tile, push it in from one of the 12 arrows, then move your pawn along any open path.</li>
      <li>The pushed-out tile becomes the new spare. Pawns on it ride around to the opposite end.</li>
      <li>You can't push the tile straight back where the last player pushed it from.</li>
      <li>Collect your treasures in order (your current target glows gold). Others can't see your list.</li>
      <li>After your last treasure, run back to your corner. First home wins.</li>
      <li><b>Tap to confirm:</b> pick an arrow, tap it again (or press the button) to push. Tap a green square, tap again to move.</li></ul>
      <button class="btn pri" data-close>Got it</button>`);
  }
  function sheet(html, mid, onClose) {
    const el = document.createElement('div');
    el.className = 'sheet' + (mid ? ' mid' : '');
    el.innerHTML = `<div class="in">${html}</div>`;
    const close = () => { el.remove(); onClose && onClose(); };
    el.onclick = e => { if (e.target === el || e.target.closest('[data-close]')) close(); };
    document.body.appendChild(el);
    return { el, close };
  }

  // ---------- local (vs bots) ----------
  const BOT_NAMES = ['Ada', 'Bram', 'Cleo'];
  function startLocal(me, nBots) {
    leaveNet();
    const players = [{ name: me }, ...BOT_NAMES.slice(0, nBots).map(n => ({ name: n + ' (bot)', bot: true }))];
    local = { S: Lab.create(players), bots: nBots, timer: null, me };
    you = 0; enterGame(); setView(Lab.view(local.S, 0));
    scheduleLocalBot();
  }
  function scheduleLocalBot() {
    clearTimeout(local.timer);
    const S = local.S;
    if (S.winner !== null || !S.players[S.turn].bot) return;
    const delay = Math.max(0, lockUntil - Date.now()) + (S.phase === 'insert' ? 650 : 450) + Math.random() * 350;
    local.timer = setTimeout(() => {
      if (!local || local.S !== S) return;
      let a = LabBot.plan(S, S.turn);
      const id = S.turn, r = a && Lab.act(S, id, a);
      if (!r || r.error) Lab.act(S, id, S.phase === 'move' ? { type: 'move', to: S.players[id].pos } : { type: 'insert', slot: Lab.SLOTS.find(x => !S.last || x !== Lab.oppositeSlot(S.last)), rot: 0 });
      setView(Lab.view(S, 0)); scheduleLocalBot();
    }, delay);
  }

  // ---------- online ----------
  function goOnline(code, token) {
    leaveNet(); local = null;
    net = { code, token, es: null, snap: null };
    store.set('lab-sess', JSON.stringify({ code, token }));
    history.replaceState(null, '', location.pathname);
    connect();
  }
  function connect() {
    if (!net) return;
    if (net.es) net.es.close();
    const es = new EventSource(`/api/events?code=${net.code}&token=${net.token}`);
    net.es = es;
    es.onmessage = e => { if (net && net.es === es) onSnap(JSON.parse(e.data)); };
    es.onerror = async () => {
      if (es.readyState !== 2 || !net || net.es !== es) return;
      // Closed for good: either the room is gone, or the host is just waking up / offline. Ask before giving up.
      const r = await call('/api/ping', { code: net.code, token: net.token });
      if (!net || net.es !== es) return;
      if (r.error === 'Room not found' || r.error === 'Bad token') { leaveNet(); home('That room is gone.'); }
      else setTimeout(() => net && net.es === es && connect(), 2000);
    };
  }
  function leaveNet() {
    if (net && net.es) net.es.close();
    net = null; store.set('lab-sess', null);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && net && net.es && net.es.readyState !== 1) connect();
    if (!document.hidden) requestWake();
  });

  function onSnap(s) {
    snap = s; net.snap = s; you = s.you;
    if (s.game) {
      if (!ui) enterGame();
      setView(s.game);
    } else {
      if (ui) destroyGame();
      document.querySelectorAll('.sheet').forEach(e => e.remove());
      lobby(s);
    }
  }

  function lobby(s) {
    const n = s.lobby.length;
    app.innerHTML = `<div class="page">
      <div class="logo"><h1>Room</h1><p>Share this code or link with friends</p></div>
      <div class="card"><div class="code">${s.code}</div>
        <div class="row"><button class="btn" id="share">Invite friends</button><button class="btn" id="copy">Copy code</button></div></div>
      <div class="card"><h2>Players (${n}/4)</h2><div class="plist">${s.lobby.map((p, i) =>
        `<div class="pl" style="--c:${p.color}"><i></i><b>${esc(p.name)}${i === s.you ? ' (you)' : ''}</b><small>${i === 0 ? 'host' : p.bot ? 'bot' : p.connected ? '' : 'offline'}</small>${s.host && i > 0 ? `<button class="x" data-kick="${i}" aria-label="Remove">✕</button>` : ''}</div>`).join('')}</div>
        ${s.host ? `<button class="btn" id="bot" ${n >= 4 ? 'disabled' : ''}>+ Add bot</button>` : ''}</div>
      ${s.host ? `<button class="btn pri" id="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'Need 2+ players' : 'Start game'}</button>` : '<div class="tiny">Waiting for the host to start…</div>'}
      <button class="btn sm bad" id="leave">Leave room</button>
      <div class="err" id="err"></div></div>`;
    const url = `${location.origin}/?room=${s.code}`;
    $('#share').onclick = async () => {
      try { if (navigator.share) return await navigator.share({ title: 'Labyrinth', text: `Join my Labyrinth game! Code ${s.code}`, url }); } catch { return; }
      copy(url);
    };
    $('#copy').onclick = () => copy(s.code);
    $('#leave').onclick = async () => { await call('/api/leave', { code: net.code, token: net.token }); leaveNet(); home(); };
    if (s.host) {
      $('#bot').onclick = () => hostCall('/api/addbot');
      $('#start').onclick = () => hostCall('/api/start');
      app.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => hostCall('/api/kick', { index: +b.dataset.kick }));
    }
  }
  async function hostCall(path, extra) {
    const r = await call(path, { code: net.code, token: net.token, ...extra });
    if (r.error) toast(r.error);
  }
  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => toast(text));
  }

  // ---------- game UI ----------
  function enterGame() {
    destroyGame();
    document.querySelectorAll('.sheet').forEach(e => e.remove());
    selSlot = selTo = null; lastSeq = -1; lastSpareId = -1; wasMyTurn = false; overShown = false; lockUntil = 0; busy = false; override.clear();
    app.innerHTML = `<div id="game">
      <div class="top"><div class="chips" id="chips"></div><button class="menu" id="menu" aria-label="Menu">☰</button></div>
      <div id="stage"><div id="board"><div id="layer"></div></div>
        <div class="tray"><div id="spareSlot"></div><button id="rot" aria-label="Rotate tile">⟳</button><div class="tg" id="tg"></div>
        <button class="btn pri" id="go"></button><div id="status"></div></div></div></div>`;
    const board = $('#board'), layer = $('#layer');
    ui = { board, layer, tiles: new Map(), pawns: [], cells: [], arrows: {}, homes: [], sx: 0, sy: 0, u: 44, reachSeq: -1, reach: null };
    for (let k = 0; k < 49; k++) {
      const c = document.createElement('div'); c.className = 'cell'; c.dataset.k = k;
      c.style.setProperty('--x', RING + (k % 7)); c.style.setProperty('--y', RING + ((k / 7) | 0));
      layer.appendChild(c); ui.cells.push(c);
    }
    for (const slot of Lab.SLOTS) {
      const side = slot[0], i = +slot[1], a = document.createElement('button');
      a.className = 'arrow'; a.dataset.slot = slot; a.setAttribute('aria-label', 'Push tile in from ' + slot);
      a.style.setProperty('--a', ARROW_ROT[side] + 'deg');
      const vert = side === 'N' || side === 'S';
      a.style.width = `calc(var(--u) * ${vert ? 1 : RING})`; a.style.height = `calc(var(--u) * ${vert ? RING : 1})`;
      a.style.transform = `translate(calc(var(--u) * ${side === 'E' ? RING + 7 : vert ? RING + i : 0}), calc(var(--u) * ${side === 'S' ? RING + 7 : vert ? 0 : RING + i}))`;
      board.appendChild(a); ui.arrows[slot] = a;
    }
    board.onclick = onBoardTap;
    $('#rot').onclick = rotateSpare;
    $('#go').onclick = commit;
    $('#menu').onclick = menu;
    ui.onResize = () => { layout(); paint(); };
    addEventListener('resize', ui.onResize); addEventListener('orientationchange', ui.onResize);
    requestWake();
  }
  function destroyGame() {
    if (ui) { removeEventListener('resize', ui.onResize); removeEventListener('orientationchange', ui.onResize); }
    ui = null; view = null; override.clear();
    clearTimeout(local && local.timer);
  }
  let wake = null;
  async function requestWake() {
    try { if (ui && 'wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; }; } } catch { /* denied */ }
  }

  function layout() {
    const vw = innerWidth, vh = innerHeight, side = 7 + 2 * RING;
    const landscape = vw > vh * 1.15;
    let u;
    if (landscape) u = Math.min((vh - 64) / side, (vw - 190) / side);
    else u = Math.min((vw - 8) / side, (vh - 52 - 168) / side);
    u = Math.max(24, Math.floor(u * 2) / 2);
    const stage = $('#stage');
    stage.style.setProperty('--u', u + 'px');
    ui.u = u;
    const b = ui.board.getBoundingClientRect(), s = $('#spareSlot').getBoundingClientRect();
    ui.sx = (s.left - b.left) / u; ui.sy = (s.top - b.top) / u;
  }

  function setView(v) {
    if (ui && lastSeq >= 0 && v.seq < lastSeq) enterGame(); // a new game reuses tile ids, so rebuild
    view = v;
    if (!ui) return;
    if (!ui.laidOut) { layout(); ui.laidOut = true; }
    const fresh = lastSeq < 0 || v.seq > lastSeq + 2 || v.seq < lastSeq;
    const ev = v.ev;
    if (v.seq !== lastSeq) { selSlot = selTo = null; }
    if (!fresh && ev && v.seq > lastSeq && v.seq <= lastSeq + 2) {
      if (ev.k === 'move' && v.seq === lastSeq + 1) animateMove(ev);
      else if (ev.k === 'push' || ev.auto) lockUntil = Date.now() + 420;
      if (ev.auto) toast(ev.by === you ? 'No way out: you stay put' : `${v.players[ev.by].name} is boxed in and stays put`);
      if (ev.k === 'move' && ev.got >= 0) {
        toast(ev.by === you ? `You found the ${Lab.TREASURE_LABELS[ev.got]}!` : `${v.players[ev.by].name} found the ${Lab.TREASURE_LABELS[ev.got]}`);
        if (ev.by === you) buzz([30, 40, 30]);
      }
    }
    lastSeq = v.seq;
    if (v.spare.i !== lastSpareId) { lastSpareId = v.spare.i; spareRot = v.spare.r; }
    const mine = v.winner === null && v.turn === you;
    if (mine && !wasMyTurn && !fresh) buzz(40);
    wasMyTurn = mine;
    paint();
    const wait = lockUntil - Date.now();
    if (wait > 0) setTimeout(() => ui && view === v && paint(), wait + 30);
    if (v.winner !== null) setTimeout(() => ui && view === v && showWin(), Math.max(wait, 0) + 700);
  }

  function animateMove(ev) {
    const path = ev.path, p = ui.pawns[ev.by];
    if (!p || path.length < 2) return;
    override.add(ev.by);
    p.classList.add('step');
    path.slice(1).forEach(([r, c], i) => setTimeout(() => { if (ui) placePawn(ev.by, [r, c], true); }, (i + 1) * STEP_MS));
    const total = (path.length - 1) * STEP_MS + 60;
    lockUntil = Date.now() + total;
    setTimeout(() => { override.delete(ev.by); if (ui) { p.classList.remove('step'); paint(); } }, total);
  }

  // ---------- painting ----------
  function tileEl(t) {
    let el = ui.tiles.get(t.i);
    if (!el) {
      el = document.createElement('div'); el.className = 'tile' + (t.i < 16 ? ' fixed' : '');
      el.innerHTML = `<img class="b" src="img/tile-${t.t}.webp" alt="" draggable="false">${t.x >= 0 ? `<img class="t" src="img/tr-${Lab.TREASURES[t.x]}.webp" alt="" draggable="false">` : ''}`;
      el.classList.add('snap'); el._new = true;
      el._b = el.firstChild; el._d = null;
      ui.layer.appendChild(el); ui.tiles.set(t.i, el);
    }
    return el;
  }
  function setPos(el, x, y) {
    if (el._px !== x || el._py !== y) { el._px = x; el._py = y; el.style.setProperty('--x', x); el.style.setProperty('--y', y); }
  }
  function settle(el) { if (el._new) { void el.offsetWidth; el.classList.remove('snap'); el._new = false; } }
  function setRot(el, r) {
    const t = r * 90;
    if (el._d === null) el._d = t;
    else { const diff = (((t - el._d) % 360) + 540) % 360 - 180; if (!diff) return; el._d += diff; }
    el._b.style.transform = `rotate(${el._d}deg)`;
  }
  function pawnOffset(v, id) {
    const p = v.players[id];
    if (!v.players.some(q => q.id !== id && q.pos[0] === p.pos[0] && q.pos[1] === p.pos[1])) return [0, 0];
    return [[-.17, -.17], [.17, .17], [.17, -.17], [-.17, .17]][id];
  }
  function placePawn(id, pos, step) {
    const el = ui.pawns[id], off = pawnOffset(view, id);
    const x = RING + pos[1] + .5 + off[0], y = RING + pos[0] + .5 + off[1];
    const jump = el._px !== undefined && (Math.abs(el._px - x) > 1.6 || Math.abs(el._py - y) > 1.6) && !step;
    if (jump) { el.classList.add('snap'); }
    setPos(el, x, y);
    if (jump) { void el.offsetWidth; el.classList.remove('snap'); }
  }

  function paint() {
    if (!ui || !view) return;
    const v = view, me = v.players[you], over = v.winner !== null;
    const myTurn = !over && v.turn === you, locked = Date.now() < lockUntil;
    const canInsert = myTurn && v.phase === 'insert' && !locked && !busy;
    const canMove = myTurn && v.phase === 'move' && !locked && !busy;

    // tiles
    const myTarget = me && me.cards && me.got < me.total ? me.cards[me.got] : -2;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const t = v.board[r][c], el = tileEl(t);
      setPos(el, RING + c, RING + r); setRot(el, t.r); settle(el);
      el.classList.toggle('done', t.x >= 0 && v.found.includes(t.x));
      el.classList.toggle('tgt', t.x >= 0 && t.x === myTarget);
      el.classList.remove('spare', 'mine');
    }
    const sp = tileEl(v.spare);
    setPos(sp, ui.sx, ui.sy); setRot(sp, spareRot); settle(sp);
    sp.classList.add('spare'); sp.classList.toggle('mine', canInsert);
    sp.classList.toggle('tgt', v.spare.x >= 0 && v.spare.x === myTarget);
    sp.classList.toggle('done', v.spare.x >= 0 && v.found.includes(v.spare.x));

    // home corners + pawns
    v.players.forEach(p => {
      if (!ui.homes[p.id]) {
        const h = document.createElement('div'); h.className = 'home'; h.style.setProperty('--c', p.color);
        h.style.setProperty('--x', RING + p.home[1]); h.style.setProperty('--y', RING + p.home[0]);
        ui.layer.insertBefore(h, ui.layer.firstChild.nextSibling); ui.homes[p.id] = h;
        const el = document.createElement('div'); el.className = 'pawn'; el.style.setProperty('--c', p.color); el.textContent = p.name[0].toUpperCase();
        el.classList.add('snap', 'new'); ui.layer.appendChild(el); ui.pawns[p.id] = el;
      }
      const el = ui.pawns[p.id];
      if (!override.has(p.id)) placePawn(p.id, p.pos);
      if (el.classList.contains('new')) { void el.offsetWidth; el.classList.remove('snap', 'new'); }
      el.classList.toggle('turn', !over && v.turn === p.id);
    });

    // arrows
    for (const slot of Lab.SLOTS) {
      const a = ui.arrows[slot], banned = !!v.last && slot === Lab.oppositeSlot(v.last);
      a.classList.toggle('on', canInsert); a.classList.toggle('no', banned);
      a.classList.toggle('sel', canInsert && selSlot === slot);
    }

    // reachable squares
    let R = null;
    if (canMove) {
      if (ui.reachSeq !== v.seq) { ui.reach = Lab.reach(v, me.pos); ui.reachSeq = v.seq; }
      R = ui.reach;
    }
    const path = R && selTo ? Lab.pathTo(R, selTo) : [];
    ui.cells.forEach((c, k) => {
      const on = !!R && R.dist[k] >= 0;
      c.classList.toggle('on', on);
      c.classList.toggle('path', on && path.some(q => q[0] * 7 + q[1] === k));
      c.classList.toggle('sel', !!selTo && selTo[0] * 7 + selTo[1] === k);
    });

    // header chips
    const lob = snap && snap.lobby;
    $('#chips').innerHTML = v.players.map(p => {
      const off = lob && lob[p.id] && !lob[p.id].connected;
      return `<div class="chip${!over && v.turn === p.id ? ' turn' : ''}${off ? ' off' : ''}" style="--c:${p.color}"><i></i><div><b>${esc(p.name.replace(' (bot)', ''))}${p.bot ? ' 🤖' : ''}</b><small>${p.got}/${p.total} ◆${off ? ' · offline' : ''}</small></div></div>`;
    }).join('');

    // target card
    const tg = $('#tg');
    if (me && me.cards && !over) {
      tg.innerHTML = me.got < me.total
        ? `<img src="img/tr-${Lab.TREASURES[me.cards[me.got]]}.webp" alt=""><div><small>Find (${me.got + 1}/${me.total})</small><b>${Lab.TREASURE_LABELS[me.cards[me.got]]}</b></div>`
        : `<span class="home-ic" style="--c:${me.color}"></span><div><small>All found!</small><b>Run to your corner</b></div>`;
    } else tg.innerHTML = '';

    // controls
    const go = $('#go'), st = $('#status'), rot = $('#rot');
    rot.disabled = !canInsert;
    go.classList.toggle('hidden', over);
    if (v.phase === 'insert') {
      go.disabled = !(canInsert && selSlot);
      go.textContent = myTurn ? (selSlot ? 'Push tile in' : 'Pick an arrow') : 'Waiting…';
      st.textContent = myTurn ? 'Your turn: rotate the spare, then pick an arrow' : `${v.players[v.turn].name} is thinking…`;
    } else {
      go.disabled = !(canMove && selTo);
      go.textContent = myTurn ? (selTo ? (selTo[0] === me.pos[0] && selTo[1] === me.pos[1] ? 'Stay here' : 'Move here') : 'Tap a green square') : 'Waiting…';
      st.textContent = myTurn ? 'Now move your pawn' : `${v.players[v.turn].name} is moving…`;
    }
    st.className = myTurn ? 'me' : '';
    if (over) st.textContent = '';
  }

  // ---------- input ----------
  function rotateSpare() {
    if (!view || view.turn !== you || view.phase !== 'insert') return;
    spareRot = (spareRot + 1) % 4; buzz(8);
    paint();
  }
  function onBoardTap(e) {
    if (!view || view.winner !== null || view.turn !== you || busy || Date.now() < lockUntil) return;
    const a = e.target.closest('[data-slot]'), c = e.target.closest('.cell.on');
    if (a && view.phase === 'insert') {
      if (selSlot === a.dataset.slot) return commit();
      selSlot = a.dataset.slot; buzz(8); paint();
    } else if (c && view.phase === 'move') {
      const k = +c.dataset.k, to = [(k / 7) | 0, k % 7];
      if (selTo && selTo[0] === to[0] && selTo[1] === to[1]) return commit();
      selTo = to; buzz(8); paint();
    }
  }
  function commit() {
    if (!view || view.turn !== you || busy) return;
    let a;
    if (view.phase === 'insert') { if (!selSlot) return; a = { type: 'insert', slot: selSlot, rot: spareRot }; }
    else { if (!selTo) return; a = { type: 'move', to: selTo }; }
    buzz(15);
    if (local) {
      const r = Lab.act(local.S, you, a);
      if (r.error) return toast(r.error);
      setView(Lab.view(local.S, 0)); scheduleLocalBot();
    } else if (net) {
      busy = true; paint();
      call('/api/act', { code: net.code, token: net.token, a }).then(r => {
        busy = false;
        if (r.error) toast(r.error);
        if (ui) paint();
      });
    }
  }

  function menu() {
    const s = sheet(`<h2>Menu</h2>
      <button class="btn" id="m-how">How to play</button>
      <button class="btn bad" id="m-quit">${local ? 'Quit to menu' : 'Leave game'}</button>
      <button class="btn pri" data-close>Back to game</button>`);
    $('#m-how', s.el).onclick = () => { s.close(); howTo(); };
    $('#m-quit', s.el).onclick = async () => {
      s.close();
      if (net) { await call('/api/leave', { code: net.code, token: net.token }); leaveNet(); }
      if (local) { clearTimeout(local.timer); local = null; }
      home();
    };
  }

  function showWin() {
    if (overShown || !view || view.winner === null) return;
    overShown = true;
    const w = view.players[view.winner], iWon = view.winner === you;
    buzz(iWon ? [60, 50, 60, 50, 120] : 30);
    const online = !!net, host = snap && snap.host;
    const s = sheet(`<div class="win"><img src="img/tr-${iWon ? 'crown' : 'treasure-chest'}.webp" alt="">
      <div class="big" style="color:${w.color}">${iWon ? 'You win!' : esc(w.name) + ' wins!'}</div>
      <p>${view.moves} moves played</p></div>
      ${online ? (host ? '<button class="btn pri" id="again">Play again</button><button class="btn" id="lob">Back to lobby</button>' : '<p class="tiny">Waiting for the host to start another game…</p>')
        : '<button class="btn pri" id="again">Play again</button>'}
      <button class="btn bad" id="quit">${online ? 'Leave room' : 'Main menu'}</button>`, true);
    const again = $('#again', s.el);
    if (again) again.onclick = async () => {
      s.close();
      if (local) startLocal(local.me, local.bots); else hostCall('/api/start');
    };
    const lob = $('#lob', s.el);
    if (lob) lob.onclick = () => { s.close(); hostCall('/api/lobby'); };
    $('#quit', s.el).onclick = async () => {
      s.close();
      if (net) { await call('/api/leave', { code: net.code, token: net.token }); leaveNet(); }
      if (local) { clearTimeout(local.timer); local = null; }
      home();
    };
  }

  // ---------- boot ----------
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const saved = (() => { try { return JSON.parse(store.get('lab-sess')); } catch { return null; } })();
  if (saved && saved.code && saved.token) { net = { code: saved.code, token: saved.token, es: null, snap: null }; connect(); }
  else home();
})();
