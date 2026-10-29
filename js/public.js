// Public spectator board. Read-only: watches the store and renders four views
// (Live, Qualifying, Bracket, Results). All race logic comes from core.js.
import { store } from './store.js';
import * as C from './core.js';

const { esc, fmtTime, fmtClock, clockTime } = C;
const VIEWS = ['live', 'quali', 'bracket', 'results'];
const $ = id => document.getElementById(id);

const st = {
  cfg: null, sid: null, S: undefined, // undefined = loading, null = missing
  view: 'live', errs: new Set(), stalled: false,
  seen: new Map(),       // `${matchId}:${lane}` → distance last rendered (for the lap flash)
  lastLog: undefined,    // newest feed timestamp already announced
  unSeason: null,
};

let revealed = false; // opened straight on #bracket: scroll to the live race once data arrives

/* ---------- small helpers ---------- */
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const fmtDist = d => Number.isInteger(d) ? String(d) : d.toFixed(2);
const nameHTML = (S, id, fallback) => id ? `<span class="team-n">${esc(C.tname(S, id))}</span>` : `<span class="tbd">${esc(fallback || 'TBD')}</span>`;
const empty = (title, body) => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
const loading = () => `<div class="loading" aria-busy="true"><span class="loading-bar" aria-hidden="true"></span>Loading results…</div>`;
function heatState(m) {
  if (m.status === 'done') return 'final';
  if (m.timer.start) return 'running';
  if (C.elapsed(m) > 0) return 'paused';
  return 'staged';
}
const readyMatches = S => S.bracket ? S.bracket.matches.filter(m => m.status === 'pending' && m.id !== S.bracket.liveId && C.entrants(S, m).every(Boolean)) : [];
const STATUS = {
  advances: ['ok', 'Advances'], 'hw-fail': ['no', 'Fails hardware'],
  'obstacle-fail': ['no', 'Obstacle fail'], crash: ['no', 'Crashed'], incomplete: ['wait', 'Needs 2 clean laps'], pending: ['wait', 'Pending'],
};
function clockText(rem, running) {
  // Count down like a race clock: whole seconds rounded up, tenths in the last 10 s.
  if (running && rem > 0 && rem < 10) return rem.toFixed(1);
  return fmtClock(Math.ceil(rem - 1e-6));
}

/** Replace a region's markup only when it changed, keeping scroll positions and focus. */
const lastHTML = new WeakMap();
function setHTML(el, html) {
  if (lastHTML.get(el) === html) return false;
  const scrollers = [...el.querySelectorAll('.bracket-scroll,.tbl,.feed')].map(x => [x.scrollLeft, x.scrollTop]);
  const focusIdx = el.contains(document.activeElement) ? [...el.querySelectorAll('[tabindex],a,button')].indexOf(document.activeElement) : -1;
  el.innerHTML = html; lastHTML.set(el, html);
  el.querySelectorAll('.bracket-scroll,.tbl,.feed').forEach((x, i) => { if (scrollers[i]) [x.scrollLeft, x.scrollTop] = scrollers[i]; });
  if (focusIdx >= 0) el.querySelectorAll('[tabindex],a,button')[focusIdx]?.focus({ preventScroll: true });
  return true;
}

/* ---------- LIVE ---------- */
const rule = S => C.targetLaps(S) ? `first to ${C.targetLaps(S)} laps` : 'most laps wins';
function lapLine(m, i) {
  const L = C.lapTimes(m, i); if (!L.length) return '';
  return `<span class="laps-u lap-line">Last ${fmtTime(L.at(-1).t)} · Best ${fmtTime(Math.min(...L.map(l => l.t)))}</span>`;
}
function laneHTML(S, m, i, e, opts) {
  const id = e[i], d = C.distance(m, i), seed = id ? C.seedOf(S, id) : null;
  const cls = ['lane'], tags = [];
  if (!id) cls.push('tbd');
  if (m.dq[i]) { cls.push('dq'); tags.push('<span class="tag dq">DQ</span>'); }
  if (opts.state === 'final' && m.winner != null) {
    if (m.winner === i) { cls.push('win'); tags.push('<span class="tag win">Winner</span>'); } else cls.push('lose');
  } else if (opts.lead === i) {
    cls.push('lead'); tags.push(`<span class="tag lead">Leads${opts.gap ? ' +' + fmtDist(opts.gap) : ''}</span>`);
  }
  const whole = m.laps[i], frac = Math.round(m.frac[i] * 100);
  const label = id ? C.tname(S, id) : C.srcLabel(S, m.src[i]);
  return `<div class="${cls.join(' ')}" data-lane="${i}">
    ${seed ? `<span class="seed" title="Seed ${seed}"><span class="sr-only">Seed </span>${seed}</span>` : '<span class="seed" aria-hidden="true">–</span>'}
    <div class="lane-name">${esc(label)}</div>
    <div class="lane-tags">${tags.join('')}</div>
    <div class="lane-laps" data-key="${esc(m.id)}:${i}" data-d="${d}" aria-label="${esc(fmtDist(d))} laps">
      <span class="laps-n" aria-hidden="true">${whole}${frac ? `<small>.${String(frac).padStart(2, '0')}</small>` : ''}</span>
      <span class="laps-u" aria-hidden="true">${C.targetLaps(S) ? `of ${C.targetLaps(S)}` : whole === 1 && !frac ? 'lap' : 'laps'}</span>
      ${C.finishedAt(m, i) != null ? `<span class="laps-u">Finished ${fmtClock(C.finishedAt(m, i))}</span>` : ''}
      ${lapLine(m, i)}
    </div>
  </div>`;
}

function heroMatch(S, m) {
  const e = C.entrants(S, m), state = heatState(m), ds = [0, 1].map(i => C.distance(m, i));
  let lead = null, gap = 0;
  if (state !== 'final' && e[0] && e[1]) {
    if (m.dq[0] !== m.dq[1]) lead = m.dq[0] ? 1 : 0;
    else if (ds[0] !== ds[1]) { lead = ds[0] > ds[1] ? 0 : 1; gap = Math.abs(ds[0] - ds[1]); }
  }
  const flag = { running: ['live', 'Live'], paused: ['paused', 'Paused'], staged: ['paused', 'On track'], final: ['final', 'Final'] }[state];
  const rem = C.remaining(S, m), total = C.heatLength(S);
  let center;
  if (state === 'final') {
    const w = m.winner != null ? e[m.winner] : null;
    center = `<div class="clock final">Final</div>
      <div class="clock-sub">${w ? `<b>${esc(C.tname(S, w))}</b> wins` : 'Result pending'}</div>
      <div class="clock-sub mono">${fmtDist(ds[0])} – ${fmtDist(ds[1])}</div>`;
  } else {
    const sub = state === 'running' ? 'Remaining' : state === 'paused' ? 'Clock paused' : 'Not started';
    center = `<div class="clock ${state === 'running' ? '' : 'paused'}" data-clock role="timer" aria-label="Time remaining">${clockText(rem, state === 'running')}</div>
      <div class="clock-sub" data-clocksub>${sub}</div>
      <div class="progress" aria-hidden="true"><i data-progress style="width:${(100 * (1 - rem / total)).toFixed(2)}%"></i></div>`;
  }
  return `<article class="board ${state === 'running' ? 'is-running' : ''}" aria-label="Race on track: ${esc(m.label)}">
    <div class="board-top">
      <div class="board-title"><span class="board-kicker">${state === 'final' ? 'Last race' : 'On track'}</span><span class="board-label">${esc(m.label)}</span></div>
      <span class="flag ${flag[0]}">${flag[1]}</span>
    </div>
    <div class="heat">
      ${laneHTML(S, m, 0, e, { state, lead, gap })}
      <div class="clockbox">${center}</div>
      ${laneHTML(S, m, 1, e, { state, lead, gap })}
    </div>
    ${m.note ? `<p class="board-note"><b>Note:</b> ${esc(m.note)}</p>` : ''}
    ${state === 'final' ? upNextList(S) : ''}
  </article>`;
}

function upNextList(S, skip) {
  const list = readyMatches(S).filter(m => m !== skip).slice(0, 3);
  if (!list.length) return '';
  return `<ul class="ondeck">${list.map((m, i) => {
    const e = C.entrants(S, m);
    return `<li><span class="k">${i === 0 && !skip ? 'Next up' : 'On deck'} · ${esc(m.label)}</span><span class="v">${esc(C.tname(S, e[0]))}<em>vs</em>${esc(C.tname(S, e[1]))}</span></li>`;
  }).join('')}</ul>`;
}

function heroNext(S, m) {
  const e = C.entrants(S, m), last = C.lastResult(S);
  return `<article class="board next" aria-label="Next heat: ${esc(m.label)}">
    <div class="board-top">
      <div class="board-title"><span class="board-kicker">Next up</span><span class="board-label">${esc(m.label)}</span></div>
      <span class="flag">Up next</span>
    </div>
    <div class="heat">
      ${laneHTML(S, m, 0, e, {})}
      <div class="clockbox"><div class="clock vs">VS</div><div class="clock-sub">${fmtClock(C.heatLength(S))} race · ${rule(S)}</div></div>
      ${laneHTML(S, m, 1, e, {})}
    </div>
    ${upNextList(S, m)}
    ${last ? `<p class="board-note"><b>Last result:</b> ${esc(last)}</p>` : ''}
  </article>`;
}

function heroQuali(S) {
  const ids = S.teams.map(t => t.id), timed = ids.filter(id => C.best(S, id) != null);
  const adv = ids.filter(id => C.advances(S, id)), fl = C.fastestLap(S);
  const flId = fl != null ? C.qualiOrder(S)[0] : null;
  const main = !ids.length
    ? `<div class="big">No teams yet</div><p>Teams will show up here once they're added.</p>`
    : fl != null
      ? `<span class="board-kicker">Fastest lap so far</span><div class="fl">${fmtTime(fl)}<small> s</small></div><div class="big">${esc(C.tname(S, flId))}</div>`
      : `<div class="big">Qualifying</div><p>No lap times yet.</p>`;
  return `<article class="board" aria-label="Qualifying session">
    <div class="board-top">
      <div class="board-title"><span class="board-kicker">Session</span><span class="board-label">Qualifying</span></div>
      <span class="flag">${ids.length ? 'In progress' : 'Not started'}</span>
    </div>
    <div class="idle-grid">
      <div class="idle-main">${main}</div>
      <div class="stat-row">
        <div class="stat"><b>${ids.length}</b><span>Teams</span></div>
        <div class="stat"><b>${timed.length}</b><span>Timed</span></div>
        <div class="stat"><b>${adv.length}</b><span>Advancing</span></div>
      </div>
    </div>
    <p class="board-note">After qualifying, teams that advance are seeded into the bracket by best lap.</p>
  </article>`;
}

function heroChampion(S, order) {
  return `<article class="board" aria-label="Race complete">
    <div class="board-top">
      <div class="board-title"><span class="board-kicker">Race complete</span><span class="board-label">Champion</span></div>
      <span class="flag final">Finished</span>
    </div>
    <div class="idle-main"><div class="big trophy-name">${esc(C.tname(S, order[0]))}</div>
      <p>${order[1] ? `Runner-up ${esc(C.tname(S, order[1]))}` : ''}${order[2] ? ` · 3rd ${esc(C.tname(S, order[2]))}` : ''}. <a href="#results">Full results</a></p></div>
  </article>`;
}

function heroWaiting() {
  return `<article class="board"><div class="board-top"><div class="board-title"><span class="board-kicker">Head-to-head</span><span class="board-label">Between races</span></div><span class="flag">Waiting</span></div>
    <div class="idle-main"><p>The next race will show here when it starts.</p></div></article>`;
}

function renderLive(S) {
  const hero = $('liveHero');
  let html;
  if (!S.bracket) html = heroQuali(S);
  else {
    const lm = C.liveMatch(S), nm = C.nextMatch(S), fin = S.bracket.matches.find(m => m.round === 'Final');
    if (lm && !(lm.status === 'done' && nm == null && fin?.winner != null)) html = heroMatch(S, lm);
    else if (fin?.winner != null && !nm) html = heroChampion(S, C.standings(S));
    else if (nm) html = heroNext(S, nm);
    else html = heroWaiting();
  }
  setHTML(hero, html);
  // Flash lap counters whose distance changed since the last render.
  hero.querySelectorAll('[data-key]').forEach(el => {
    const k = el.dataset.key, d = +el.dataset.d, prev = st.seen.get(k);
    if (prev != null && prev !== d) el.querySelector('.laps-n')?.classList.add('flash');
    st.seen.set(k, d);
  });

  // Compact qualifying tower
  const order = C.qualiOrder(S).filter(id => C.best(S, id) != null), fl = C.fastestLap(S);
  setHTML($('liveQuali'), order.length
    ? `<ol class="tower">${order.slice(0, 6).map((id, i) => {
        const b = C.best(S, id), out = C.qualiStatus(S, id) !== 'advances' && C.qualiStatus(S, id) !== 'pending';
        return `<li class="${out ? 'x' : ''}"><span class="p">${i + 1}</span>${nameHTML(S, id)}<span class="t ${b === fl ? 'purple' : ''}">${fmtTime(b)}</span><span class="g">${i ? '+' + (b - fl).toFixed(3) : 'Fastest'}</span></li>`;
      }).join('')}</ol>`
    : empty('No lap times yet', 'Qualifying times will show here.'));

  const log = S.log || [];
  setHTML($('liveFeed'), log.length
    ? `<ol class="feed">${log.slice(0, 40).map(l => {
        const c = /fastest of the session/.test(l.m) ? 'f-fast' : / beats |result set/.test(l.m) ? 'f-result' : /green flag|on track|resumed/.test(l.m) ? 'f-flag' : /disqualified|crash|fails/.test(l.m) ? 'f-bad' : '';
        return `<li class="${c}"><time class="mono" datetime="${new Date(l.t).toISOString()}">${esc(clockTime(l.t))}</time><span>${esc(l.m)}</span></li>`;
      }).join('')}</ol>`
    : empty('No updates yet', 'Race updates will show here.'));
}

/* ---------- QUALIFYING ---------- */
function renderQuali(S) {
  // Rows in registration order (newest last); Pos is still the rank by best lap.
  const ids = S.teams.map(t => t.id), fl = C.fastestLap(S);
  const rank = new Map(C.qualiOrder(S).filter(id => C.best(S, id) != null).map((id, i) => [id, i + 1]));
  const nAdv = ids.filter(id => C.advances(S, id)).length;
  $('qualiSummary').textContent = ids.length ? `${ids.length} team${ids.length === 1 ? '' : 's'} · ${nAdv} advancing${fl != null ? ' · fastest ' + fmtTime(fl) + ' s' : ''}` : '';
  if (!ids.length) { setHTML($('qualiTable'), empty('No teams yet', 'Teams will be listed here once they\'re added.')); return; }
  const rows = ids.map(id => {
    const t = C.team(S, id), q = C.Q(S, id), ev = C.chosenEval(S, id), b = C.best(S, id), s = C.qualiStatus(S, id), g = C.grade(S, id);
    const p = rank.get(id) ?? null, [pc, pl] = STATUS[s];
    const ob = q.obstacle === 'pass' ? '<span class="pill ok">Pass</span>' : q.obstacle === 'fail' ? '<span class="pill no">Fail</span>' : '<span class="pill">Pending</span>';
    const hw = t.hw === true ? '<span class="pill ok">Compliant</span>' : t.hw === false ? '<span class="pill no">Fails</span>' : '<span class="pill">Unchecked</span>';
    const dist = +(+(ev?.dist) || 0).toFixed(2), nEv = q.evals.length;
    return `<tr class="${s === 'advances' ? 'adv' : s === 'pending' ? '' : 'out'}">
      <td class="stick pos">${p ?? '—'}</td>
      <th scope="row" class="stick2">${nameHTML(S, id)}</th>
      <td class="best ${b != null && b === fl ? 'purple' : ''}">${fmtTime(b)}${b != null && b === fl ? '<span class="sr-only"> (session fastest)</span>' : ''}</td>
      <td class="st"><span class="pill ${pc}">${pl}</span></td>
      <td class="gap">${b == null ? '' : b === fl ? '' : '+' + (b - fl).toFixed(3)}</td>
      <td><span class="grade">${Math.round(g)}%<span class="meter ${g >= 100 ? 'full' : ''}" aria-hidden="true"><i style="width:${g}%"></i></span></span></td>
      <td>${ob}</td>
      <td class="num mono">${dist}/2</td>
      <td class="num mono">${ev?.scrapes ?? 0}</td>
      <td class="num mono">${ev?.crashes ?? 0}</td>
      <td>${hw}</td>
      <td class="num mono">${ev ? `${ev.n}${nEv > 1 ? `<span class="muted"> of ${nEv}</span>` : ''}` : '—'}</td>
      <td class="num mono">${ev?.laps.length ?? 0}</td>
    </tr>`;
  }).join('');
  setHTML($('qualiTable'), `
    <p class="legend"><span><i class="lp"></i>Fastest lap</span><span><i class="la"></i>Advances to the bracket</span></p>
    <div class="tbl"><table class="qt">
      <caption class="sr-only">Qualifying results in order of registration. Pos is the rank by best lap.</caption>
      <thead><tr>
        <th scope="col" class="stick pos" title="Position">Pos</th><th scope="col" class="stick2">Team</th>
        <th scope="col">Best lap (s)</th><th scope="col">Status</th><th scope="col">Gap (s)</th><th scope="col">Completion</th>
        <th scope="col">Obstacle</th><th scope="col" class="num" title="Crash-free laps in a row">Crash-free</th>
        <th scope="col" class="num">Scrapes</th><th scope="col" class="num">Crashes</th><th scope="col">Hardware</th><th scope="col" class="num" title="Evaluation the team chose">Eval</th><th scope="col" class="num" title="Timed laps in that evaluation">Laps</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`);
}

/* ---------- BRACKET ---------- */
function matchCard(S, m, nextId) {
  const e = C.entrants(S, m), live = S.bracket.liveId === m.id && m.status !== 'done';
  const state = m.status === 'done' ? 'Final' : live ? (m.timer.start ? 'Live' : 'On track') : m.id === nextId ? 'Next up' : '';
  const started = m.status !== 'pending' || C.elapsed(m) > 0;
  const ds = [0, 1].map(i => C.distance(m, i)), fmt = ds.every(Number.isInteger) ? String : d => d.toFixed(2);
  const row = i => {
    const id = e[i], seed = id ? C.seedOf(S, id) : null;
    const cls = m.status === 'done' && m.winner != null ? (m.winner === i ? 'win' : 'lose') : '';
    return `<div class="bm-r ${cls}">
      <span class="seed">${seed ? `<span class="sr-only">Seed </span>${seed}` : '–'}</span>
      <span class="nm ${id ? '' : 'tbd'}">${id ? esc(C.tname(S, id)) : esc(C.srcLabel(S, m.src[i]))}${m.dq[i] ? '<span class="dq">DQ</span>' : ''}</span>
      <span class="d">${started && id ? fmt(ds[i]) : ''}</span>
    </div>`;
  };
  return `<article class="bm ${live ? 'is-live' : ''} ${m.id === nextId && !live ? 'is-next' : ''}" aria-label="${esc(m.label)}${state ? ', ' + state : ''}">
    <div class="bm-h"><span>${esc(m.label)}</span><span class="bm-s">${state}</span></div>
    ${row(0)}${row(1)}
    ${m.note ? `<div class="bm-note">${esc(m.note)}</div>` : ''}
  </article>`;
}

function renderBracket(S) {
  const el = $('bracket'), sub = $('bracketSub');
  if (!S.bracket) {
    sub.textContent = '';
    setHTML(el, empty('No bracket yet', `The bracket is made after qualifying. Teams that advance are seeded by best lap, and each race lasts up to ${Math.round(C.heatLength(S) / 6) / 10} minutes${C.targetLaps(S) ? `. The first team to finish ${C.targetLaps(S)} laps wins` : ''}.`));
    return;
  }
  const rs = C.rounds(S), nm = C.nextMatch(S), nextId = nm?.id;
  sub.textContent = `${S.bracket.seeds.length} teams · ${fmtClock(C.heatLength(S))} races · ${rule(S)}`;
  const play = rs.find(r => r.name === 'Play-in'), third = rs.find(r => r.name === '3rd place');
  const main = rs.filter(r => r !== play && r !== third);
  const fin = S.bracket.matches.find(m => m.round === 'Final');
  const champId = fin?.winner != null ? C.entrants(S, fin)[fin.winner] : null;
  const rows = main[0]?.matches.length || 1, tuck = third && rows >= 4;
  const cols = [];
  if (play) cols.push(`<div class="bk-col side"><h3>Play-in</h3><div class="bk-body">${play.matches.map(m => matchCard(S, m, nextId)).join('')}</div></div>`);
  main.forEach((r, ci) => {
    const hasNext = ci < main.length - 1, hasPrev = ci > 0, last = !hasNext;
    let body = '';
    if (hasNext) for (let i = 0; i < r.matches.length; i += 2) body += `<div class="bk-pair">${r.matches.slice(i, i + 2).map(m => `<div class="bk-slot">${matchCard(S, m, nextId)}</div>`).join('')}</div>`;
    else body = r.matches.map(m => `<div class="bk-slot">${matchCard(S, m, nextId)}</div>`).join('');
    cols.push(`<div class="bk-col ${hasNext ? 'has-next' : ''} ${hasPrev ? 'has-prev' : ''} ${last ? 'to-champ' : ''}"><h3>${esc(r.name)}</h3><div class="bk-body">${body}</div></div>`);
  });
  cols.push(`<div class="bk-col has-prev champ-col"><h3>Champion</h3><div class="bk-body"><div class="bk-slot">
    <div class="champ ${champId ? '' : 'tbd'}"><span>${champId ? 'Champion' : 'Winner of the Final'}</span><b>${champId ? esc(C.tname(S, champId)) : 'TBD'}</b></div></div>
    ${tuck ? `<div class="third"><h3>3rd place</h3>${third.matches.map(m => matchCard(S, m, nextId)).join('')}</div>` : ''}</div></div>`);
  // Big brackets tuck the 3rd place match under the champion; small ones give it its own column.
  if (third && !tuck) cols.push(`<div class="bk-col after"><h3>3rd place</h3><div class="bk-body">${third.matches.map(m => matchCard(S, m, nextId)).join('')}</div></div>`);
  setHTML(el, `<p class="bracket-hint">Scroll sideways to see every round →</p>
    <div class="bracket-scroll" tabindex="0" role="region" aria-label="Bracket, scrolls horizontally">
      <div class="bk" style="--rows:${rows}">${cols.join('')}</div>
    </div>`);
}

/* ---------- RESULTS ---------- */
function fates(S) {
  // One row per team: finishing place if decided, otherwise how far they got.
  const st0 = C.standings(S), rs = C.rounds(S).map(r => r.name), out = [];
  const depth = name => name === 'Play-in' ? 0 : rs.indexOf(name) + 1;
  for (const t of S.teams) {
    const id = t.id, i = st0.indexOf(id), seed = C.seedOf(S, id);
    let rank, fate, ms = [];
    if (S.bracket) ms = S.bracket.matches.filter(m => m.status === 'done' && m.winner != null && C.entrants(S, m).includes(id));
    const w = ms.filter(m => C.entrants(S, m)[m.winner] === id).length, l = ms.length - w;
    if (i >= 0) { rank = i; fate = i === 0 ? 'Champion' : i < 4 ? ['Runner-up', '3rd place', '4th place'][i - 1] : ord(i + 1); }
    else if (!S.bracket || seed == null) {
      const s = C.qualiStatus(S, id);
      rank = 9000; fate = S.bracket ? (s === 'advances' ? 'Not seeded' : 'Did not qualify · ' + STATUS[s][1]) : STATUS[s][1];
    } else {
      const lost = ms.find(m => m.id !== 'THIRD' && C.entrants(S, m)[1 - m.winner] === id);
      if (lost && lost.round === 'Semifinal') { rank = 50; fate = 'Semifinalist · racing for 3rd'; }
      else if (lost) { rank = lost.round === 'Play-in' ? 1000 - Number(lost.id.slice(1)) : 1000 - depth(lost.round) * 10; fate = `Out in ${lost.round === 'Play-in' ? 'play-in' : lost.round.toLowerCase()}`; }
      else { rank = 10; fate = 'Still racing'; }
    }
    out.push({ id, rank, fate, seed, w, l, best: C.best(S, id), place: i >= 0 ? i + 1 : null });
  }
  return out.sort((a, b) => a.rank - b.rank || (a.seed ?? 999) - (b.seed ?? 999) || (a.best ?? 1e9) - (b.best ?? 1e9) || C.tname(S, a.id).localeCompare(C.tname(S, b.id)));
}

function renderResults(S) {
  const pod = $('podium'), tbl = $('resultsTable'), sub = $('resultsSub');
  if (!S.bracket) {
    sub.textContent = '';
    setHTML(pod, empty('No results yet', 'Places 1 to 4 get extra credit: 50, 30, 20 and 10 points.'));
  } else {
    const order = C.standings(S), n = Math.min(4, S.bracket.seeds.length), hasThird = !!C.match(S, 'THIRD');
    sub.textContent = order.length ? (order.length >= n ? 'Final results' : 'Racing still in progress') : '';
    const where = i => i < 2 ? 'Decided in the Final' : hasThird ? 'Decided in the 3rd place match' : 'Decided in the play-in';
    setHTML(pod, `<div class="podium">${Array.from({ length: n }, (_, i) => {
      const id = order[i];
      return `<div class="pod p${i + 1} ${id ? '' : 'undecided'}">
        <div class="place">${i + 1}<sup>${ord(i + 1).slice(-2)}</sup></div>
        <div class="who">${id ? `<b>${esc(C.tname(S, id))}</b><span>Seed ${C.seedOf(S, id) ?? '—'}${C.best(S, id) != null ? ' · best lap ' + fmtTime(C.best(S, id)) + ' s' : ''}</span>` : `<b>To be decided</b><span>${where(i)}</span>`}</div>
        <div class="ec"><b>+${C.EXTRA_CREDIT[i]}</b><span>Extra credit</span></div>
      </div>`;
    }).join('')}</div>`);
  }
  if (!S.teams.length) { setHTML(tbl, empty('No teams yet', 'Teams will be listed here once they\'re added.')); return; }
  const fl = C.fastestLap(S);
  setHTML(tbl, `<div class="tbl"><table class="rt">
    <caption class="sr-only">All teams, by finishing position</caption>
    <thead><tr><th scope="col" class="num">Pos</th><th scope="col">Team</th><th scope="col" class="num">Seed</th><th scope="col">Best lap (s)</th><th scope="col" class="num">Races W–L</th><th scope="col" class="num">Extra credit</th></tr></thead>
    <tbody>${fates(S).map(r => `<tr class="${r.place ? 'podrow' : ''}">
      <td class="num pl">${r.place ? ord(r.place) : '—'}</td>
      <th scope="row">${nameHTML(S, r.id)}<span class="fate">${esc(r.fate)}</span></th>
      <td class="num mono">${r.seed ?? '—'}</td>
      <td class="mono ${r.best != null && r.best === fl ? 'purple' : ''}">${fmtTime(r.best)}</td>
      <td class="num mono">${S.bracket && r.seed ? `${r.w}–${r.l}` : '—'}</td>
      <td class="num ec-c">${r.place && r.place <= 4 ? '+' + C.EXTRA_CREDIT[r.place - 1] : '—'}</td>
    </tr>`).join('')}</tbody></table></div>`);
}

/* ---------- header, status, banner ---------- */
function renderChrome() {
  const S = st.S, lm = S && C.liveMatch(S);
  const running = !!(lm && lm.timer.start && lm.status !== 'done');
  const onTrack = !!(lm && lm.status !== 'done');
  const offline = st.errs.size > 0 || st.stalled;
  const state = offline ? 'offline' : S === undefined ? 'connecting' : running ? 'live' : onTrack ? 'paused' : 'idle';
  $('status').dataset.state = state;
  $('statusText').textContent = { offline: 'Offline', connecting: 'Connecting', live: 'Live', paused: 'Race paused', idle: 'Idle' }[state];
  if (onTrack && !running) $('statusText').textContent = C.elapsed(lm) > 0 ? 'Race paused' : 'On track';
  document.querySelector('.tabs').toggleAttribute('data-live', running);
  $('updated').textContent = S?.updated ? `Updated ${clockTime(S.updated)}` : '';
  $('evName').textContent = S?.event?.name || 'RoboRacer Race';
  $('evSeason').textContent = S?.event?.season || '';
  $('footText').textContent = [S?.event?.name || 'RoboRacer Race', S?.event?.season].filter(Boolean).join(' · ');

  const b = $('banner');
  b.classList.toggle('on', offline);
  setHTML(b, offline ? `<div class="wrap banner-in">Connection lost. Trying to reconnect…${S ? ' Showing the last results received.' : ''}</div>` : '');

  const cfg = st.cfg, arch = $('archive');
  const label = id => cfg?.seasons?.find(s => s.id === id)?.label || id;
  if (cfg && st.sid && cfg.current && st.sid !== cfg.current) {
    arch.hidden = false;
    setHTML(arch, `<span>Viewing archived season <b>${esc(label(st.sid))}</b></span><button class="btn" type="button" data-season="${esc(cfg.current)}">Back to current season</button>`);
  } else arch.hidden = true;
}

function renderSeasonPicker() {
  const cfg = st.cfg, pick = $('seasonPick'), sel = $('seasonSel');
  const seasons = cfg?.seasons || [];
  pick.hidden = seasons.length < 2;
  if (seasons.length < 2) return;
  sel.innerHTML = seasons.slice().reverse().map(s => `<option value="${esc(s.id)}">${esc(s.label || s.id)}${s.id === cfg.current ? ' (current)' : ''}</option>`).join('');
  sel.value = st.sid || '';
}

function render() {
  renderChrome();
  const S = st.S, ids = ['liveQuali', 'liveFeed', 'qualiTable', 'bracket', 'podium', 'resultsTable'];
  if (S === undefined) {
    setHTML($('liveHero'), loading());
    ids.forEach(id => setHTML($(id), ''));
    return;
  }
  if (S === null) {
    const none = !st.sid;
    setHTML($('liveHero'), empty(none ? 'No race yet' : 'Season not found', none ? 'Nothing has been posted yet. Check back on race day.' : 'This season isn\'t available. Pick another season above.'));
    ids.forEach(id => setHTML($(id), ''));
    ['qualiSummary', 'bracketSub', 'resultsSub'].forEach(id => $(id).textContent = '');
    return;
  }
  renderLive(S); renderQuali(S); renderBracket(S); renderResults(S);
  announce(S);
  tick();
}

function announce(S) {
  const top = S.log?.[0];
  if (!top) { st.lastLog = 0; return; }
  if (st.lastLog !== undefined && top.t !== st.lastLog) $('announce').textContent = top.m;
  st.lastLog = top.t;
}

/* ---------- clock ---------- */
function tick() {
  const S = st.S, el = document.querySelector('[data-clock]');
  if (!S || !el) return;
  const m = C.liveMatch(S); if (!m) return;
  const running = !!m.timer.start, rem = C.remaining(S, m);
  el.textContent = clockText(rem, running);
  el.classList.toggle('low', running && rem <= 30);
  const sub = document.querySelector('[data-clocksub]');
  if (sub && running) sub.textContent = rem <= 0 ? 'Time\'s up' : 'Remaining';
  const bar = document.querySelector('[data-progress]');
  if (bar) bar.style.width = (100 * (1 - rem / C.heatLength(S))).toFixed(2) + '%';
}
setInterval(tick, 250);

/* ---------- routing ---------- */
function route() {
  const h = location.hash.slice(1);
  if (VIEWS.includes(h)) st.view = h; // ignore other hashes; keep the current view
  document.querySelectorAll('.view').forEach(s => s.hidden = s.dataset.view !== st.view);
  document.querySelectorAll('.tabs a').forEach(a => a.dataset.tab === st.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
}
// On narrow screens, bring the race on track into view when the bracket opens.
function revealLive() {
  const sc = document.querySelector('.bracket-scroll'), card = sc?.querySelector('.bm.is-live') || sc?.querySelector('.bm.is-next');
  if (!sc || !card || sc.scrollWidth <= sc.clientWidth) return;
  const col = card.closest('.bk-col');
  sc.scrollLeft = Math.max(0, col.offsetLeft - sc.offsetLeft - 8);
}
addEventListener('hashchange', () => { route(); window.scrollTo({ top: 0 }); if (st.view === 'bracket') revealLive(); });

/* ---------- data ---------- */
function setErr(key, on) { on ? st.errs.add(key) : st.errs.delete(key); renderChrome(); }

/** Subscribe with automatic retry: a listener that errors is torn down and re-opened with backoff. */
function watchRetry(key, open, onData) {
  let un = null, tries = 0, timer = null, dead = false;
  const go = () => {
    un = open((data, err) => {
      if (dead) return;
      if (err) {
        console.warn('[race board]', key, err);
        setErr(key, true); try { un?.(); } catch {}
        clearTimeout(timer); timer = setTimeout(go, Math.min(30000, 1500 * 2 ** tries++));
        return;
      }
      tries = 0; if (st.errs.has(key)) setErr(key, false);
      onData(data);
    });
  };
  go();
  return () => { dead = true; clearTimeout(timer); try { un?.(); } catch {} };
}

function chosenSeason(cfg) {
  const want = new URLSearchParams(location.search).get('season');
  const ids = (cfg?.seasons || []).map(s => s.id);
  return want && ids.includes(want) ? want : cfg?.current || null;
}

function openSeason(sid) {
  if (sid === st.sid && (st.unSeason || (!sid && st.S === null))) return;
  st.unSeason?.(); st.unSeason = null; st.errs.delete('season');
  st.sid = sid; st.S = sid ? undefined : null; st.seen.clear(); st.lastLog = undefined;
  render();
  if (sid) st.unSeason = watchRetry('season', cb => store.watchSeason(sid, cb), S => { st.S = S; st.stalled = false; render(); if (!revealed && S && st.view === 'bracket') { revealed = true; revealLive(); } });
}

function pickSeason(sid) {
  const u = new URL(location.href);
  if (sid && sid !== st.cfg?.current) u.searchParams.set('season', sid); else u.searchParams.delete('season');
  history.replaceState(null, '', u);
  openSeason(sid);
  renderSeasonPicker();
}

$('seasonSel').addEventListener('change', e => pickSeason(e.target.value));
$('archive').addEventListener('click', e => { const b = e.target.closest('[data-season]'); if (b) pickSeason(b.dataset.season); });

watchRetry('config', cb => store.watchConfig(cb), cfg => {
  st.cfg = cfg || { current: null, seasons: [] };
  openSeason(chosenSeason(st.cfg));
  renderSeasonPicker(); renderChrome();
});

// If nothing arrives (SDK blocked, offline at load), say so instead of spinning forever.
setTimeout(() => { if (st.S === undefined) { st.stalled = true; renderChrome(); } }, 12000);
store.ready?.catch?.(err => { console.warn('[race board] store failed to start', err); st.stalled = true; renderChrome(); setTimeout(() => location.reload(), 20000); });
addEventListener('offline', () => setErr('network', true));
addEventListener('online', () => setErr('network', false));
if (navigator.onLine === false) st.errs.add('network');

/* ---------- theme ---------- */
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('themeBtn').textContent = 'Theme: ' + t[0].toUpperCase() + t.slice(1);
}
let theme = 'auto'; try { theme = localStorage.getItem('rc-theme') || 'auto'; } catch {}
if (!THEMES.includes(theme)) theme = 'auto';
applyTheme(theme);
$('themeBtn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; applyTheme(theme);
  try { theme === 'auto' ? localStorage.removeItem('rc-theme') : localStorage.setItem('rc-theme', theme); } catch {}
});

route();
render();
