// Labyrinth bot. Only looks at its own cards plus the public board, like a real player.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game.js'));
  else root.LabBot = factory(root.Lab);
})(this, function (G) {
  // Best reachable square for the player after the board is in its current shape.
  function bestMove(state, p) {
    const R = G.reach(state, p.pos), t = G.targetOf(p);
    const goal = t.home || G.locate(state, t.tr);
    let best = null;
    for (let k = 0; k < 49; k++) {
      if (R.dist[k] < 0) continue;
      const r = (k / 7) | 0, c = k % 7;
      let score;
      if (goal && goal[0] === r && goal[1] === c) score = 1000 - R.dist[k];
      else if (!goal) score = -R.dist[k] * 0.01;
      else score = -(Math.abs(goal[0] - r) + Math.abs(goal[1] - c)) - R.dist[k] * 0.01;
      score += Math.random() * 0.2; // break ties without looking mechanical
      if (!best || score > best.score) best = { score, to: [r, c] };
    }
    return best;
  }

  function plan(state, pid) {
    if (state.winner !== null || state.turn !== pid) return null;
    const p = state.players[pid];
    if (state.phase === 'move') return { type: 'move', to: bestMove(state, p).to };
    let best = null;
    for (const slot of G.SLOTS) {
      if (state.last && slot === G.oppositeSlot(state.last)) continue;
      for (let rot = 0; rot < 4; rot++) {
        const s = G.sim(state);
        s.spare.r = rot;
        G.push(s, slot);
        const m = bestMove(s, s.players[pid]);
        if (!best || m.score > best.score) best = { score: m.score, a: { type: 'insert', slot, rot } };
      }
    }
    return best.a;
  }

  return { plan };
});
