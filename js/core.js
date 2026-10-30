// Pure race logic: no DOM, no Firebase. Every function takes the season state `S`.
// Rules source: CMU 16-665 RoboRacer Race Rules (October 2026).

export const EXTRA_CREDIT = [50, 30, 20, 10];

export function emptySeason(name = '', season = '') {
  return { v: 1, event: { name, season, heat: 300, target: 10 }, teams: [], quali: {}, bracket: null, log: [], updated: null };
}

/* ---------- formatting ---------- */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => Math.random().toString(36).slice(2, 8);
export function fmtTime(s) { if (s == null || !isFinite(s)) return '—'; const m = Math.floor(s / 60), r = s - m * 60; return m ? `${m}:${r.toFixed(3).padStart(6, '0')}` : r.toFixed(3); }
export function parseTime(str) { str = String(str).trim(); if (!str) return null; const p = str.split(':'); let v; if (p.length === 2) v = (+p[0]) * 60 + (+p[1]); else if (p.length === 1) v = +p[0]; else return null; return isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null; }
export function fmtClock(sec) { sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }
export const clockTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ---------- teams + qualifying ---------- */
export const heatLength = S => S.event?.heat || 300;
/** Laps to win a race; 0 = no target (most laps when time runs out). Seasons made before this setting default to 10. */
export const targetLaps = S => S.event?.target ?? 10;
export const team = (S, id) => S.teams.find(t => t.id === id);
export const tname = (S, id) => id ? (team(S, id)?.name || 'Unknown') : null;
/*
 * Qualifying record per team. Obstacle avoidance is per team; timed laps are grouped into
 * evaluations (attempts). Each evaluation has its own laps, crash-free distance, scrapes and
 * crashes. The team chooses one evaluation (a TA records the choice as `pick`) and only that one
 * counts for best lap, grade and seeding. The first evaluation counts until another is chosen.
 */
export function Q(S, id) {
  const q = (S.quali[id] ||= { obstacle: 'pending', evals: [], pick: null, nextEval: 1 });
  if (!q.evals) { // older single-run records → one evaluation
    const had = (q.laps?.length || q.dist || q.scrapes || q.crashes);
    q.evals = had ? [{ id: 'e1', n: 1, laps: q.laps || [], dist: q.dist || 0, scrapes: q.scrapes || 0, crashes: q.crashes || 0 }] : [];
    q.pick = had ? 'e1' : null; q.nextEval = had ? 2 : 1;
    delete q.laps; delete q.dist; delete q.scrapes; delete q.crashes;
  }
  return q;
}
export const evals = (S, id) => Q(S, id).evals;
export const evalById = (S, id, eid) => evals(S, id).find(e => e.id === eid) || null;
/** The evaluation that counts for this team, or null if it has none. */
export function chosenEval(S, id) { const q = Q(S, id); return evalById(S, id, q.pick) || q.evals[0] || null; }
export const latestEval = (S, id) => evals(S, id).at(-1) || null;
export const evalBest = e => e && e.laps.length ? Math.min(...e.laps) : null;
export function evalGrade(e) { if (!e) return 0; return Math.max(0, Math.min(e.dist, 2) / 2 * 100 - 5 * Math.max(0, e.scrapes - 2) - 10 * e.crashes); }
export function best(S, id) { return evalBest(chosenEval(S, id)); }
export function fastestLap(S) { const v = S.teams.map(t => best(S, t.id)).filter(x => x != null); return v.length ? Math.min(...v) : null; }
// Grade: baseline = consecutive crash-free distance / 2 laps; −5% per scrape beyond two; −10% per crash.
export function grade(S, id) { return evalGrade(chosenEval(S, id)); }
/** The chosen evaluation has two crash-free laps in a row and no crashes. */
export function cleanRun(S, id) { const e = chosenEval(S, id); return !!e && e.dist >= 2 && e.crashes === 0; }
// Advances: obstacle avoidance passed, hardware not failed, and the chosen evaluation is a clean
// two-lap run (no crashes) with a timed lap for seeding.
export function advances(S, id) { const t = team(S, id); return !!t && t.hw !== false && Q(S, id).obstacle === 'pass' && cleanRun(S, id) && best(S, id) != null; }
/** Status for display: 'advances' | 'hw-fail' | 'obstacle-fail' | 'crash' | 'incomplete' | 'pending' */
export function qualiStatus(S, id) {
  const t = team(S, id), q = Q(S, id), e = chosenEval(S, id);
  if (advances(S, id)) return 'advances';
  if (t?.hw === false) return 'hw-fail';
  if (q.obstacle === 'fail') return 'obstacle-fail';
  if (e?.crashes > 0) return 'crash';
  if (e && (e.dist < 2 || best(S, id) == null) && (e.laps.length || e.dist || e.scrapes)) return 'incomplete';
  return 'pending';
}
/** All team ids, fastest best lap first; teams with no time at the end, alphabetical. */
export function qualiOrder(S) {
  return S.teams.map(t => t.id).sort((a, b) => {
    const ba = best(S, a), bb = best(S, b);
    if (ba == null && bb == null) return tname(S, a).localeCompare(tname(S, b));
    if (ba == null) return 1; if (bb == null) return -1; return ba - bb;
  });
}
export const seedOrder = S => qualiOrder(S).filter(id => advances(S, id));

/* ---------- bracket ---------- */
function stdOrder(x) { let o = [1]; while (o.length < x) { const k = o.length * 2; o = o.flatMap(s => [s, k + 1 - s]); } return o; }
function roundName(n) { return n === 2 ? 'Final' : n === 4 ? 'Semifinal' : n === 8 ? 'Quarterfinal' : `Round of ${n}`; }
function newMatch(id, round, label, src) { return { id, round, label, src, laps: [0, 0], frac: [0, 0], dq: [false, false], at: [null, null], lapAt: { 0: [], 1: [] }, status: 'pending', timer: { acc: 0, start: null }, winner: null, note: '' }; }
/**
 * Seeds 1..x where x = largest power of two ≤ n. Seeds 1..x−1 go straight into the main
 * bracket; seed x's spot goes to the winner of a play-in ladder among seeds x..n, starting
 * from the bottom: (n−1 v n), winner v n−2, … winner v x (10 teams → 9 v 10, winner v 8).
 * Rulebook: 5 teams → seeds 4 v 5 play in for seed 4.
 * Main bracket pairs 1 v x, 2 v x−1, … A 3rd place match decides extra credit for 3rd/4th.
 */
export function buildBracket(seeds) {
  const n = seeds.length; if (n < 2) return null;
  let x = 1; while (x * 2 <= n) x *= 2;
  const p = n - x, matches = [], slotSrc = {};
  for (let s = 1; s <= x; s++) slotSrc[s] = { seed: s };
  let up = { seed: n };
  for (let i = 1; i <= p; i++) {
    const id = 'P' + i, last = i === p;
    matches.push(newMatch(id, 'Play-in', last ? `Play-in for seed ${x}` : `Play-in ${i}`, [{ seed: n - i }, up])); up = { w: id };
  }
  slotSrc[x] = up;
  let prev = stdOrder(x).map(s => slotSrc[s]), size = x, r = 1;
  while (size >= 2) {
    const next = [], rn = roundName(size);
    for (let i = 0; i < prev.length; i += 2) { const id = `R${r}M${i / 2 + 1}`; matches.push(newMatch(id, rn, size === 2 ? 'Final' : `${rn} ${i / 2 + 1}`, [prev[i], prev[i + 1]])); next.push({ w: id }); }
    if (size === 4) { const semis = matches.filter(m => m.round === 'Semifinal'); matches.push(newMatch('THIRD', '3rd place', '3rd place match', [{ l: semis[0].id }, { l: semis[1].id }])); }
    prev = next; size /= 2; r++;
  }
  return { format: 'single', seeds: seeds.slice(), x, matches, liveId: null, createdAt: Date.now() };
}
export const isDouble = S => S.bracket?.format === 'double';
/** A double elimination version can be made from an 8-team single bracket with play-ins. */
export const canDouble = b => !!b && b.x === 8 && b.seeds.length > 8;
/**
 * Double elimination built on the single bracket `b`: the play-ins, quarterfinals and semifinals
 * are the same races (same ids and entrants, so results carry over when switching).
 * Losers bracket: play-in losers race a ladder (L(P1) v L(P2), winner v L(P3), …); that winner races
 * the loser of quarterfinal 3 (2 v 7) for the 4th spot beside the other three quarterfinal losers.
 * Then two rounds against the semifinal losers (crossed over), a round for 4th place, and the
 * losers final against the winners-final loser for 3rd. The grand final is one race, no reset.
 */
export function buildDouble(b) {
  if (!canDouble(b)) return null;
  const keep = b.matches.filter(m => m.round === 'Play-in' || m.round === 'Quarterfinal' || m.round === 'Semifinal').map(m => JSON.parse(JSON.stringify(m)));
  const matches = [...keep], add = (id, round, label, src) => matches.push(newMatch(id, round, label, src));
  add('WF', 'Winners final', 'Winners final', [{ w: 'R2M1' }, { w: 'R2M2' }]);
  const plays = keep.filter(m => m.round === 'Play-in');
  let up = { l: plays[0].id };
  for (let i = 1; i < plays.length; i++) { add('LQ' + i, 'Losers qualifier', `Losers qualifier ${i}`, [up, { l: plays[i].id }]); up = { w: 'LQ' + i }; }
  add('LQF', 'Losers qualifier', 'Losers qualifier final', [{ l: 'R1M3' }, up]);
  add('L1M1', 'Losers round 1', 'Losers round 1 · 1', [{ l: 'R1M2' }, { w: 'LQF' }]);
  add('L1M2', 'Losers round 1', 'Losers round 1 · 2', [{ l: 'R1M4' }, { l: 'R1M1' }]);
  add('L2M1', 'Losers round 2', 'Losers round 2 · 1', [{ l: 'R2M2' }, { w: 'L1M1' }]);
  add('L2M2', 'Losers round 2', 'Losers round 2 · 2', [{ l: 'R2M1' }, { w: 'L1M2' }]);
  add('L3', 'Losers round 3', 'Losers round 3', [{ w: 'L2M1' }, { w: 'L2M2' }]);
  add('LF', 'Losers final', 'Losers final', [{ l: 'WF' }, { w: 'L3' }]);
  add('GF', 'Final', 'Grand final', [{ w: 'WF' }, { w: 'LF' }]);
  // Running order: losers-bracket races go first whenever they're ready; winners-bracket races
  // run only when the losers bracket is waiting on them.
  const lq = matches.filter(m => /^LQ\d/.test(m.id)).map(m => m.id);
  const order = [...keep.map(m => m.id).filter(id => !id.startsWith('R2')), ...lq, 'LQF', 'L1M1', 'L1M2', 'R2M1', 'R2M2', 'L2M1', 'L2M2', 'L3', 'WF', 'LF', 'GF'];
  return { format: 'double', seeds: b.seeds.slice(), x: b.x, matches, order, liveId: keep.some(m => m.id === b.liveId) ? b.liveId : null, createdAt: Date.now() };
}
/** Copy results of races both brackets share (same id and entrants) from `from` into `to`. */
function syncShared(from, to) {
  for (let i = 0; i < to.matches.length; i++) {
    const f = from.matches.find(m => m.id === to.matches[i].id);
    if (f && JSON.stringify(f.src) === JSON.stringify(to.matches[i].src)) to.matches[i] = JSON.parse(JSON.stringify(f));
  }
  to.liveId = to.matches.some(m => m.id === from.liveId) ? from.liveId : null;
}
export const match = (S, id) => S.bracket?.matches.find(m => m.id === id) || null;
export function resolve(S, src) {
  if (!src) return null;
  if (src.seed) return S.bracket.seeds[src.seed - 1] || null;
  const m = match(S, src.w || src.l); if (!m || m.winner == null) return null;
  const pair = entrants(S, m); return src.w ? pair[m.winner] : pair[1 - m.winner];
}
/** [teamIdA|null, teamIdB|null] */
export const entrants = (S, m) => m.src.map(s => resolve(S, s));
export function seedOf(S, id) { const i = S.bracket?.seeds.indexOf(id) ?? -1; return i >= 0 ? i + 1 : null; }
/** Human label for an unresolved slot, e.g. "Winner Play-in for seed 4". */
export function srcLabel(S, s) { if (s.seed) return 'Seed ' + s.seed; const m = match(S, s.w || s.l); return (s.w ? 'Winner ' : 'Loser ') + (m ? m.label : ''); }
/** Bracket columns for drawing: [{name, matches}] in play order, 3rd place match last. */
export function rounds(S) {
  if (!S.bracket) return [];
  const out = [];
  for (const m of S.bracket.matches) { if (m.round === '3rd place') continue; let r = out.find(x => x.name === m.round); if (!r) out.push(r = { name: m.round, matches: [] }); r.matches.push(m); }
  const th = match(S, 'THIRD'); if (th) out.push({ name: '3rd place', matches: [th] });
  return out;
}
export const isLosersRound = name => name.startsWith('Losers');
export const liveMatch = S => S.bracket?.liveId ? match(S, S.bracket.liveId) : null;
/** Races in the order they should be run (the bracket's suggested order if it has one). */
export function playOrder(S) {
  const ms = S.bracket?.matches || [], o = S.bracket?.order; if (!o) return ms;
  return ms.slice().sort((a, b) => (o.indexOf(a.id) + 1 || 1e3) - (o.indexOf(b.id) + 1 || 1e3));
}
export const nextMatch = S => playOrder(S).find(m => m.status === 'pending' && m.id !== S.bracket.liveId && entrants(S, m).every(Boolean)) || null;

/* ---------- race clock ----------
 * All clock math uses nowMs(): the device clock corrected by the offset store.js measures
 * against the web server's clock, so every phone and the projector agree on the countdown. */
let skewMs = 0;
export const setClockSkew = ms => { skewMs = ms; };
export const nowMs = () => Date.now() + skewMs;
/** Seconds of racing elapsed; pass `now` (ms) already corrected for clock skew. */
export function elapsed(m, now = nowMs()) { return m.timer.acc + (m.timer.start ? (now - m.timer.start) / 1000 : 0); }
export const remaining = (S, m, now) => Math.max(0, heatLength(S) - elapsed(m, now));
export const distance = (m, i) => m.laps[i] + m.frac[i];
/**
 * Race clock time (s) of each counted lap for team i, e.g. [24.1, 47.9, …]. Stored as a map
 * {0: [...], 1: [...]} because Firestore can't hold arrays inside arrays. Laps counted
 * before lap times were recorded have no entry, so this can be shorter than m.laps[i].
 */
export const lapClock = (m, i) => m.lapAt?.[i] || [];
/** Individual lap durations (s) for team i: [{n, t}] with n = lap number. */
export function lapTimes(m, i) {
  const c = lapClock(m, i), off = m.laps[i] - c.length;
  return c.map((x, k) => ({ n: off + k + 1, t: k || !off ? Math.round((x - (k ? c[k - 1] : 0)) * 1000) / 1000 : null })).filter(l => l.t != null);
}
/** Race time (s) at which team i completed the target laps, or null. */
export const finishedAt = (m, i) => m.at?.[i] ?? null;
// Winner: DQ, then first to finish the target laps, then (time limit reached) most laps,
// then fractional distance, then better qualifying time (higher seed).
export function autoWinner(S, m) {
  const [a, b] = entrants(S, m); if (!a || !b) return null;
  if (m.dq[0] !== m.dq[1]) return m.dq[0] ? 1 : 0;
  const fa = finishedAt(m, 0), fb = finishedAt(m, 1);
  if (fa != null || fb != null) { if (fa == null) return 1; if (fb == null) return 0; if (fa !== fb) return fa < fb ? 0 : 1; }
  const da = distance(m, 0), db = distance(m, 1);
  if (da !== db) return da > db ? 0 : 1;
  return seedOf(S, a) <= seedOf(S, b) ? 0 : 1;
}
/** Most recently finished race as a sentence, or null. */
export function lastResult(S) {
  const m = (S.bracket?.matches || []).filter(x => x.status === 'done' && x.winner != null).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
  if (!m) return null; const e = entrants(S, m), w = m.winner;
  return `${m.label}: ${tname(S, e[w])} beat ${tname(S, e[1 - w])}, ${distance(m, w).toFixed(2)} to ${distance(m, 1 - w).toFixed(2)} laps`;
}
/** Team ids in finishing order, as far as decided (final → 1st/2nd, 3rd place match → 3rd/4th). */
export function standings(S) {
  if (!S.bracket) return [];
  const ms = S.bracket.matches, fin = ms.find(m => m.round === 'Final'), th = match(S, 'THIRD'), out = [];
  if (fin?.winner != null) { const e = entrants(S, fin); out.push(e[fin.winner], e[1 - fin.winner]); }
  if (isDouble(S)) { // by place, null = not decided yet: 3rd = losers final loser, 4th = losers round 3 loser
    if (fin?.winner == null) out.push(null, null);
    for (const id of ['LF', 'L3']) { const m = match(S, id); out.push(m?.winner != null ? entrants(S, m)[1 - m.winner] : null); }
    while (out.length && !out.at(-1)) out.pop();
    return out;
  }
  if (th?.winner != null) { const e = entrants(S, th); out.push(e[th.winner], e[1 - th.winner]); }
  else if (!th && fin?.winner != null) ms.filter(m => m.round === 'Play-in' && m.winner != null).forEach(m => out.push(entrants(S, m)[1 - m.winner]));
  return out.filter(Boolean);
}

function evalFor(S, id, eid) {
  if (eid) { const e = evalById(S, id, eid); if (!e) throw new Error('That evaluation was removed on another device.'); return e; }
  if (!latestEval(S, id)) A.addEval(S, id);
  return latestEval(S, id);
}

/* ---------- mutations (TA actions) ----------
 * Each takes the state, changes it in place, and returns a feed message (or null).
 * The store runs them inside a transaction, so call them via store.mutate(fn).
 */
export const A = {
  addTeam: (S, name) => { const id = uid(); S.teams.push({ id, name, hw: null }); Q(S, id); return `${name} registered`; },
  renameTeam: (S, id, name) => { team(S, id).name = name; return null; },
  removeTeam: (S, id) => { const n = tname(S, id); S.teams = S.teams.filter(t => t.id !== id); delete S.quali[id]; return `${n} removed`; },
  setHardware: (S, id, hw) => { team(S, id).hw = hw; return `${tname(S, id)}: hardware ${hw ? 'compliant' : hw === false ? 'not compliant' : 'unchecked'}`; },
  setObstacle: (S, id, v) => { Q(S, id).obstacle = v; return v === 'pass' ? `${tname(S, id)} passes obstacle avoidance` : v === 'fail' ? `${tname(S, id)} fails obstacle avoidance` : null; },
  addEval: (S, id) => {
    const q = Q(S, id), n = q.nextEval++, e = { id: 'e' + n, n, laps: [], dist: 0, scrapes: 0, crashes: 0 };
    q.evals.push(e); if (!q.pick) q.pick = e.id;
    return `${tname(S, id)}: evaluation ${n} started`;
  },
  removeEval: (S, id, eid) => {
    const q = Q(S, id), e = evalById(S, id, eid); if (!e) throw new Error('That evaluation was already removed.');
    q.evals = q.evals.filter(x => x.id !== eid); if (q.pick === eid) q.pick = q.evals[0]?.id || null;
    return `${tname(S, id)}: evaluation ${e.n} removed`;
  },
  pickEval: (S, id, eid) => {
    const e = evalById(S, id, eid); if (!e) throw new Error('That evaluation was removed.');
    Q(S, id).pick = eid; const b = evalBest(e);
    return `${tname(S, id)} is using evaluation ${e.n}${b != null ? ` (best lap ${fmtTime(b)} s)` : ''}`;
  },
  /** Laps, distance, scrapes and crashes go to evaluation `eid` (default: the latest, created if none). */
  setDistance: (S, id, d, eid) => { evalFor(S, id, eid).dist = Math.min(2, Math.max(0, +d || 0)); return null; },
  bump: (S, id, field, delta, eid) => {
    const e = evalFor(S, id, eid); e[field] = Math.max(0, e[field] + delta);
    return delta > 0 ? `${tname(S, id)}: ${field === 'scrapes' ? 'scrape' : 'crash'} in evaluation ${e.n}` : null;
  },
  addLap: (S, id, secs, eid) => {
    const e = evalFor(S, id, eid), counts = chosenEval(S, id) === e, prev = evalBest(e), field = fastestLap(S); e.laps.push(secs);
    const note = !counts ? '' : field == null || secs < field ? ', fastest so far' : prev == null || secs < prev ? ', team best' : '';
    return `${tname(S, id)}: ${fmtTime(secs)} s in evaluation ${e.n}${note}`;
  },
  deleteLap: (S, id, i, eid) => { evalFor(S, id, eid).laps.splice(i, 1); return null; },
  /* Qualifying stopwatch. `now` is the moment the TA tapped (ms, skew-corrected), so the time
   * recorded doesn't depend on how long the save takes. timer.last = last line crossing. */
  startLapTimer: (S, id, eid, now = nowMs()) => {
    const e = evalFor(S, id, eid); if (e.timer) throw new Error('The timer is already running on another device.');
    e.timer = { start: now, last: now }; return `${tname(S, id)} is on track (evaluation ${e.n})`;
  },
  timerLap: (S, id, eid, now = nowMs()) => {
    const e = evalFor(S, id, eid); if (!e.timer) throw new Error('The timer was stopped on another device.');
    const secs = Math.round(now - e.timer.last) / 1000; if (secs <= 0) throw new Error('That lap was already recorded.');
    const msg = A.addLap(S, id, secs, e.id); e.timer.last = now; return msg;
  },
  restartLap: (S, id, eid, now = nowMs()) => { const e = evalFor(S, id, eid); if (e.timer) e.timer.last = now; return null; },
  stopLapTimer: (S, id, eid) => { const e = evalFor(S, id, eid); e.timer = null; return null; },
  buildBracket: S => { S.bracket = buildBracket(seedOrder(S)); delete S.altBracket; return S.bracket ? `Bracket set: ${S.bracket.seeds.length} teams seeded from qualifying` : null; },
  clearBracket: S => { S.bracket = null; delete S.altBracket; return 'Bracket cleared'; },
  /** Switch between single and double elimination. The other format is kept in S.altBracket. */
  setFormat: (S, f) => {
    const cur = S.bracket; if (!cur || (cur.format || 'single') === f) return null;
    if (liveMatch(S)?.timer.start) throw new Error('Pause or finish the race on track first.');
    let next = S.altBracket?.format === f ? S.altBracket : null;
    if (!next && f === 'double') { next = buildDouble(cur); if (!next) throw new Error('Double elimination needs an 8-team bracket with play-ins.'); }
    if (!next) throw new Error('There is no single elimination bracket to switch back to.');
    cur.format ||= 'single'; syncShared(cur, next); S.altBracket = cur; S.bracket = next;
    return f === 'double' ? 'Switched to double elimination: every team gets a second chance in the losers bracket' : 'Switched to single elimination';
  },
  putOnTrack: (S, mid) => {
    const m = match(S, mid), cur = liveMatch(S);
    if (cur && cur.id !== mid && cur.timer.start) throw new Error('Pause or finish the race on track first.');
    if (cur && cur.id !== mid && cur.status === 'live' && elapsed(cur) === 0) cur.status = 'pending';
    S.bracket.liveId = mid; if (m.status === 'pending') m.status = 'live';
    const e = entrants(S, m); return `${m.label}: ${tname(S, e[0]) || 'TBD'} vs ${tname(S, e[1]) || 'TBD'} on track`;
  },
  toggleClock: (S, mid, now = nowMs()) => {
    const m = match(S, mid);
    if (m.timer.start) { m.timer.acc = elapsed(m, now); m.timer.start = null; return `${m.label}: clock paused at ${fmtClock(heatLength(S) - m.timer.acc)}`; }
    m.timer.start = now; m.status = 'live'; S.bracket.liveId = mid; return m.timer.acc ? `${m.label}: clock resumed` : `${m.label}: green flag`;
  },
  /** Count a lap. `now` is the tap time. Reaching the target laps finishes the race. */
  lap: (S, mid, i, delta, now = nowMs()) => {
    const m = match(S, mid), T = targetLaps(S), who = tname(S, entrants(S, m)[i]);
    const before = m.laps[i]; m.laps[i] = Math.max(0, m.laps[i] + delta); m.at ||= [null, null];
    m.lapAt ||= { 0: [], 1: [] }; m.lapAt[i] ||= [];
    if (m.laps[i] > before) m.lapAt[i].push(Math.round(elapsed(m, now) * 1000) / 1000);
    else if (m.laps[i] < before) m.lapAt[i] = m.lapAt[i].slice(0, Math.max(0, m.lapAt[i].length - (before - m.laps[i])));
    if (T && m.laps[i] < T) m.at[i] = null;
    if (delta > 0 && T && m.laps[i] >= T && m.at[i] == null && !m.dq[i] && m.status !== 'done') {
      m.at[i] = m.lapAt[i][m.lapAt[i].length - 1];
      return `${who} completes lap ${m.laps[i]} in ${fmtTime(m.at[i])}. ` + A.finish(S, mid, now);
    }
    const lt = lapTimes(m, i).at(-1);
    return delta > 0 ? `${who} completes lap ${m.laps[i]}${lt && lt.n === m.laps[i] ? ` (${fmtTime(lt.t)} s)` : ''}` : null;
  },
  setFrac: (S, mid, i, v) => { match(S, mid).frac[i] = Math.min(0.99, Math.max(0, +v || 0)); return null; },
  setDq: (S, mid, i, on) => { const m = match(S, mid); m.dq[i] = on; return on ? `${tname(S, entrants(S, m)[i])} disqualified in ${m.label}` : null; },
  setNote: (S, mid, note) => { match(S, mid).note = note; return null; },
  finish: (S, mid, now = nowMs()) => {
    const m = match(S, mid); if (m.timer.start) { m.timer.acc = elapsed(m, now); m.timer.start = null; }
    m.winner = autoWinner(S, m); m.status = 'done'; m.doneAt = now; const e = entrants(S, m), w = m.winner;
    return `${m.label}: ${tname(S, e[w])} beats ${tname(S, e[1 - w])}, ${distance(m, w).toFixed(2)} to ${distance(m, 1 - w).toFixed(2)} laps`;
  },
  reopen: (S, mid) => { const m = match(S, mid); m.status = 'live'; m.winner = null; m.doneAt = null; S.bracket.liveId = mid; return `${m.label} reopened`; },
  setWinner: (S, mid, i) => { const m = match(S, mid); m.winner = i; m.status = 'done'; m.doneAt ||= nowMs(); return `${m.label}: result set to ${tname(S, entrants(S, m)[i])}`; },
  resetHeat: (S, mid) => { const m = match(S, mid); Object.assign(m, { laps: [0, 0], frac: [0, 0], dq: [false, false], at: [null, null], lapAt: { 0: [], 1: [] }, status: 'pending', timer: { acc: 0, start: null }, winner: null, doneAt: null }); return `${m.label} reset`; },
  setEvent: (S, patch) => { Object.assign(S.event, patch); return null; },
  post: (S, msg) => msg, // free-text announcement to the feed
};
