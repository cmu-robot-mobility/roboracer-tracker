// Pure race logic: no DOM, no Firebase. Every function takes the season state `S`.
// Rules source: CMU 16-665 F1TENTH Race Rules (October 2026).

export const EXTRA_CREDIT = [50, 30, 20, 10];

export function emptySeason(name = '', season = '') {
  return { v: 1, event: { name, season, heat: 300 }, teams: [], quali: {}, bracket: null, log: [], updated: null };
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
export const team = (S, id) => S.teams.find(t => t.id === id);
export const tname = (S, id) => id ? (team(S, id)?.name || 'Unknown') : null;
export function Q(S, id) { return (S.quali[id] ||= { obstacle: 'pending', laps: [], dist: 0, scrapes: 0, crashes: 0 }); }
export function best(S, id) { const l = Q(S, id).laps; return l.length ? Math.min(...l) : null; }
export function fastestLap(S) { const v = S.teams.map(t => best(S, t.id)).filter(x => x != null); return v.length ? Math.min(...v) : null; }
// Grade: baseline = consecutive crash-free distance / 2 laps; −5% per scrape beyond two; −10% per crash.
export function grade(S, id) { const q = Q(S, id); return Math.max(0, Math.min(q.dist, 2) / 2 * 100 - 5 * Math.max(0, q.scrapes - 2) - 10 * q.crashes); }
// Advances: obstacle avoidance passed, not failed on hardware, and has a timed lap for seeding.
export function advances(S, id) { const t = team(S, id); return !!t && t.hw !== false && Q(S, id).obstacle === 'pass' && best(S, id) != null; }
/** Status for display: 'advances' | 'hw-fail' | 'obstacle-fail' | 'pending' */
export function qualiStatus(S, id) { const t = team(S, id), q = Q(S, id); return advances(S, id) ? 'advances' : t?.hw === false ? 'hw-fail' : q.obstacle === 'fail' ? 'obstacle-fail' : 'pending'; }
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
function newMatch(id, round, label, src) { return { id, round, label, src, laps: [0, 0], frac: [0, 0], dq: [false, false], status: 'pending', timer: { acc: 0, start: null }, winner: null, note: '' }; }
/**
 * Seeds 1..x where x = largest power of two ≤ n. The slowest 2(n−x) teams race play-ins
 * for the bottom bracket spots (rulebook: 5 teams → seeds 4 v 5 play in for seed 4).
 * Main bracket pairs 1 v x, 2 v x−1, … A 3rd place match decides extra credit for 3rd/4th.
 */
export function buildBracket(seeds) {
  const n = seeds.length; if (n < 2) return null;
  let x = 1; while (x * 2 <= n) x *= 2;
  const p = n - x, matches = [], slotSrc = {};
  for (let s = 1; s <= x - p; s++) slotSrc[s] = { seed: s };
  for (let i = 0; i < p; i++) {
    const a = x - p + 1 + i, b = n - i, id = 'P' + (i + 1);
    matches.push(newMatch(id, 'Play-in', `Play-in for seed ${a}`, [{ seed: a }, { seed: b }])); slotSrc[a] = { w: id };
  }
  let prev = stdOrder(x).map(s => slotSrc[s]), size = x, r = 1;
  while (size >= 2) {
    const next = [], rn = roundName(size);
    for (let i = 0; i < prev.length; i += 2) { const id = `R${r}M${i / 2 + 1}`; matches.push(newMatch(id, rn, size === 2 ? 'Final' : `${rn} ${i / 2 + 1}`, [prev[i], prev[i + 1]])); next.push({ w: id }); }
    if (size === 4) { const semis = matches.filter(m => m.round === 'Semifinal'); matches.push(newMatch('THIRD', '3rd place', '3rd place match', [{ l: semis[0].id }, { l: semis[1].id }])); }
    prev = next; size /= 2; r++;
  }
  return { seeds: seeds.slice(), x, matches, liveId: null, createdAt: Date.now() };
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
export const liveMatch = S => S.bracket?.liveId ? match(S, S.bracket.liveId) : null;
export const nextMatch = S => S.bracket?.matches.find(m => m.status === 'pending' && m.id !== S.bracket.liveId && entrants(S, m).every(Boolean)) || null;

/* ---------- heat clock ----------
 * All clock math uses nowMs(): the device clock corrected by the offset store.js measures
 * against the web server's clock, so every phone and the projector agree on the countdown. */
let skewMs = 0;
export const setClockSkew = ms => { skewMs = ms; };
export const nowMs = () => Date.now() + skewMs;
/** Seconds of racing elapsed; pass `now` (ms) already corrected for clock skew. */
export function elapsed(m, now = nowMs()) { return m.timer.acc + (m.timer.start ? (now - m.timer.start) / 1000 : 0); }
export const remaining = (S, m, now) => Math.max(0, heatLength(S) - elapsed(m, now));
export const distance = (m, i) => m.laps[i] + m.frac[i];
// Winner: DQ, then most laps, then fractional distance, then better qualifying time (higher seed).
export function autoWinner(S, m) {
  const [a, b] = entrants(S, m); if (!a || !b) return null;
  if (m.dq[0] !== m.dq[1]) return m.dq[0] ? 1 : 0;
  const da = distance(m, 0), db = distance(m, 1);
  if (da !== db) return da > db ? 0 : 1;
  return seedOf(S, a) <= seedOf(S, b) ? 0 : 1;
}
/** Most recently finished heat as a sentence, or null. */
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
  if (th?.winner != null) { const e = entrants(S, th); out.push(e[th.winner], e[1 - th.winner]); }
  else if (!th && fin?.winner != null) ms.filter(m => m.round === 'Play-in' && m.winner != null).forEach(m => out.push(entrants(S, m)[1 - m.winner]));
  return out.filter(Boolean);
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
  setDistance: (S, id, d) => { Q(S, id).dist = Math.min(2, Math.max(0, +d || 0)); return null; },
  bump: (S, id, field, delta) => { const q = Q(S, id); q[field] = Math.max(0, q[field] + delta); return delta > 0 ? `${tname(S, id)}: ${field === 'scrapes' ? 'scrape' : 'crash'} in qualifying` : null; },
  addLap: (S, id, secs) => {
    const prev = best(S, id), field = fastestLap(S); Q(S, id).laps.push(secs);
    return `${tname(S, id)} laps ${fmtTime(secs)}${field == null || secs < field ? ' — fastest of the session' : prev == null || secs < prev ? ' — personal best' : ''}`;
  },
  deleteLap: (S, id, i) => { Q(S, id).laps.splice(i, 1); return null; },
  buildBracket: S => { S.bracket = buildBracket(seedOrder(S)); return S.bracket ? `Bracket set: ${S.bracket.seeds.length} teams seeded from qualifying` : null; },
  clearBracket: S => { S.bracket = null; return 'Bracket cleared'; },
  putOnTrack: (S, mid) => {
    const m = match(S, mid), cur = liveMatch(S);
    if (cur && cur.id !== mid && cur.timer.start) throw new Error('Pause or finish the heat on track first.');
    if (cur && cur.id !== mid && cur.status === 'live' && elapsed(cur) === 0) cur.status = 'pending';
    S.bracket.liveId = mid; if (m.status === 'pending') m.status = 'live';
    const e = entrants(S, m); return `${m.label}: ${tname(S, e[0]) || 'TBD'} vs ${tname(S, e[1]) || 'TBD'} on track`;
  },
  toggleClock: (S, mid, now = nowMs()) => {
    const m = match(S, mid);
    if (m.timer.start) { m.timer.acc = elapsed(m, now); m.timer.start = null; return `${m.label}: clock paused at ${fmtClock(heatLength(S) - m.timer.acc)}`; }
    m.timer.start = now; m.status = 'live'; S.bracket.liveId = mid; return m.timer.acc ? `${m.label}: clock resumed` : `${m.label}: green flag`;
  },
  lap: (S, mid, i, delta) => { const m = match(S, mid); m.laps[i] = Math.max(0, m.laps[i] + delta); return delta > 0 ? `${tname(S, entrants(S, m)[i])} completes lap ${m.laps[i]}` : null; },
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
  resetHeat: (S, mid) => { const m = match(S, mid); Object.assign(m, { laps: [0, 0], frac: [0, 0], dq: [false, false], status: 'pending', timer: { acc: 0, start: null }, winner: null, doneAt: null }); return `${m.label} reset`; },
  setEvent: (S, patch) => { Object.assign(S.event, patch); return null; },
  post: (S, msg) => msg, // free-text announcement to the feed
};
