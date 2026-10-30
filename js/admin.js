// TA console. All race logic lives in core.js (A.* mutations); this file is UI only.
// Rendering: each view returns [key, html] regions; a region's DOM is only replaced when its
// HTML changes, focus/typing is preserved across re-renders, and re-renders are deferred while a
// finger is down so a live update from another phone can never swallow a tap.
import { store } from './store.js';
import * as C from './core.js';

const { A, esc } = C;
const $ = s => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const vib = p => { try { navigator.vibrate?.(p); } catch { /* unsupported */ } };
const TABS = [['heat', 'Race'], ['quali', 'Qualifying'], ['bracket', 'Bracket'], ['feed', 'Feed'], ['settings', 'Settings']];
const LAP_LOCK = 600, CLOCK_LOCK = 1000, ARM_MS = 4000;

const st = {
  auth: null, cfg: undefined, cfgErr: null, sid: null, S: undefined, unS: null,
  tab: TABS.some(t => t[0] === location.hash.slice(1)) ? location.hash.slice(1) : LS.get('rc-admin-tab', null),
  side: LS.get('rc-admin-side', 'both'), theme: LS.get('rc-admin-theme', 'system'),
  inflight: 0, online: navigator.onLine, confirm: {}, open: new Set(), drafts: {}, msgs: {}, lapWarn: null,
  lock: [0, 0], unlock: [0, 0], ltLock: {}, clockLock: 0, pend: [0, 0], hold: false, dirty: false, wl: null, wlBusy: false,
};

/* ---------------- small helpers ---------------- */
const I = {
  heat: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  quali: '<circle cx="12" cy="14" r="7"/><path d="M12 14v-4M10 3h4M12 3v4"/>',
  bracket: '<path d="M3 5h5v5H3M3 14h5v5H3M8 7.5h3v9H8M11 12h4M15 9h6v6h-6"/>',
  feed: '<path d="M4 10v4h3l7 4V6l-7 4H4zM18 9a4 4 0 0 1 0 6"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor"/>',
  pause: '<path d="M7 4h4v16H7zM14 4h4v16h-4z" fill="currentColor"/>',
  flag: '<path d="M5 21V4M5 4h14v9H5" /><path d="M5 4h3.5v3H5zM12 4h3.5v3H12zM8.5 7H12v3H8.5zM15.5 7H19v3h-3.5zM5 10h3.5v3H5zM12 10h3.5v3H12z" fill="currentColor" stroke="none"/>',
};
const svg = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${I[n]}</svg>`;
/** Value for an input: what the user is typing (draft) wins over the stored value. */
const dv = (k, v) => esc(k in st.drafts ? st.drafts[k] : (v ?? ''));
const armed = k => (st.confirm[k] || 0) > Date.now();
function announce(t) { const n = $('#sr-live'); n.textContent = ''; setTimeout(() => { n.textContent = t; }, 30); }
function msg(k) { const m = st.msgs[k]; return `<p class="fmsg ${m?.kind || ''}" id="msg-${esc(k)}" aria-live="polite">${m ? esc(m.text) : ''}</p>`; }
function setMsg(k, text, kind = '') { st.msgs[k] = { text, kind }; render(); announce(text); }
/** Two-step button: first tap arms it (changes label + style), second tap within 4 s acts. */
function cbtn({ key, label, confirm, act, cls = 'btn', attrs = '', disabled = false, type = 'button' }) {
  const on = armed(key);
  return `<button type="${type}" class="${cls}${on ? ' armed' : ''}" data-confirm="${esc(key)}" data-k="c:${esc(key)}"${act ? ` data-act="${act}"` : ''} ${attrs}${disabled ? ' disabled' : ''}>${on ? `<span aria-hidden="true">⚠</span> ${confirm}` : label}</button>`;
}
function seg(label, opts, cur, act, extra = '', kpre = act) {
  return `<div class="seg" role="group" aria-label="${esc(label)}">${opts.map(([v, l, ico, tone = '']) =>
    `<button type="button" class="seg-b ${tone}" aria-pressed="${v === cur}" data-act="${act}" data-v="${esc(v)}" ${extra} data-k="${esc(kpre + v)}"><span class="seg-ico" aria-hidden="true">${v === cur ? ico : ''}</span>${l}</button>`).join('')}</div>`;
}
const phase = m => m.status === 'done' ? 'done' : m.timer.start ? 'running' : C.elapsed(m) > 0 ? 'paused' : 'ready';
const dist = (m, i) => { const d = C.distance(m, i); return Number.isInteger(d) ? String(d) : d.toFixed(2); };
const normTime = s => String(s).trim().replace(',', '.').replace(/^(\d+)\.(\d{1,2})\.(\d+)$/, '$1:$2.$3');
const seasonLabel = () => st.S?.event ? [st.S.event.season, st.S.event.name].filter(Boolean).join(' · ') : (st.cfg?.seasons?.find(s => s.id === st.sid)?.label || '');
const tab = () => st.tab || (st.S && C.liveMatch(st.S) && phase(C.liveMatch(st.S)) !== 'done' ? 'heat' : 'quali');
function setTab(t) { st.tab = t; LS.set('rc-admin-tab', t); try { history.replaceState(null, '', '#' + t); } catch { /* file:// */ } render(); scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }

function errText(e) {
  const c = String(e?.code || ''), m = String(e?.message || e || '');
  if (/permission/i.test(c + m)) return "Not saved: you don't have permission to edit. Are you still on the TA list?";
  if (/unavailable|deadline|network|offline/i.test(c + m)) return 'Not saved: no connection. Check your signal and try again.';
  if (e instanceof TypeError) return 'Not saved: that item was changed on another device. Try again.';
  return 'Not saved: ' + m;
}
function toast(text, bad = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', bad ? 'alert' : 'status'); t.textContent = (bad ? '⚠ ' : '') + text;
  t.addEventListener('click', () => t.remove());
  $('#toasts').replaceChildren(t); clearTimeout(st.tt); st.tt = setTimeout(() => t.remove(), bad ? 6500 : 2600);
  if (bad) vib([60, 40, 60]);
}
/** Track any store promise for the save indicator; errors become toasts. Resolves true/false. */
async function job(p) {
  st.inflight++; render();
  try { await p; return true; } catch (e) { toast(errText(e), true); return false; } finally { st.inflight--; render(); }
}
const run = fn => st.sid ? job(store.mutate(st.sid, fn)) : Promise.resolve(false);
const mustMatch = (S, mid) => { const m = C.match(S, mid); if (!m) throw new Error('That race no longer exists (bracket was rebuilt).'); return m; };
const mustTeam = (S, id) => { if (!C.team(S, id)) throw new Error('That team was removed on another device.'); };
const guardTrack = (S, mid) => { const cur = C.liveMatch(S); if (cur && cur.id !== mid && cur.timer.start) throw new Error('Pause or finish the race on track first.'); };

/* ---------------- rendering core ---------------- */
function swap(el, html) {
  const a = document.activeElement, k = a && a !== document.body && el.contains(a) ? a.dataset.k : null;
  let sel = null;
  if (k && a.matches('input[type=text],input:not([type]),input[type=email],textarea')) { try { sel = [a.selectionStart, a.selectionEnd]; } catch { /* n/a */ } }
  el.innerHTML = html;
  if (k) {
    const n = el.querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (n && !n.disabled) { n.focus({ preventScroll: true }); if (sel) try { n.setSelectionRange(...sel); } catch { /* n/a */ } }
  }
}
function patch(el, html) { if (el._h !== html) { swap(el, html); el._h = html; } }
function regions(root, parts) {
  const keys = parts.map(p => p[0]);
  [...root.children].forEach(c => { if (!keys.includes(c.dataset.r)) c.remove(); });
  parts.forEach(([k, html], i) => {
    let el = [...root.children].find(c => c.dataset.r === k);
    if (!el) { el = document.createElement('div'); el.dataset.r = k; el.className = 'region'; }
    if (root.children[i] !== el) root.insertBefore(el, root.children[i] || null);
    patch(el, html);
  });
}
function render() {
  if (st.hold) { st.dirty = true; return; }
  st.dirty = false;
  patch($('#hdr'), header());
  patch($('#banner'), banner());
  const sync = $('#sync'), s = syncState();
  sync.className = 'sync ' + s[0]; sync.textContent = s[0] === 'ok' ? '' : s[1];
  const g = gate();
  if (g) { patch($('#nav'), ''); regions($('#main'), [['gate', g]]); return; }
  patch($('#nav'), nav());
  const t = tab();
  document.body.dataset.tab = t;
  regions($('#main'), ({ heat: vHeat, quali: vQuali, bracket: vBracket, feed: vFeed, settings: vSettings })[t]());
  tick();
  const lm = C.liveMatch(st.S);
  wake(t === 'heat' && !!lm && phase(lm) === 'running');
}
function tick() {
  const S = st.S;
  document.querySelectorAll('[data-lapclock]').forEach(el => { const t = (C.nowMs() - +el.dataset.lapclock) / 1000; el.textContent = Math.max(0, t).toFixed(1); });
  if (!S?.bracket) return;
  document.querySelectorAll('[data-clock]').forEach(el => {
    const m = C.match(S, el.dataset.clock); if (!m) return;
    const r = C.remaining(S, m), txt = C.fmtClock(r);
    if (el.textContent !== txt) el.textContent = txt;
    const w = el.closest('[data-clockwrap]'), up = r <= 0 && m.status !== 'done';
    if (w && w.classList.contains('timeup') !== up) {
      w.classList.toggle('timeup', up);
      const l = w.querySelector('[data-clocklbl]'); if (l) l.textContent = up ? 'Time’s up. Score the race below' : l.dataset.clocklbl;
      if (up && m.timer.start && st.vibedUp !== m.id) { st.vibedUp = m.id; vib([200, 100, 200]); }
    }
  });
}
async function wake(on) {
  if (st.wlBusy || !('wakeLock' in navigator)) return;
  try {
    st.wlBusy = true;
    if (on && !st.wl && document.visibilityState === 'visible') { st.wl = await navigator.wakeLock.request('screen'); st.wl.addEventListener('release', () => { st.wl = null; }); }
    else if (!on && st.wl) { await st.wl.release(); st.wl = null; }
  } catch { /* denied */ } finally { st.wlBusy = false; }
}

/* ---------------- chrome: header, banner, nav ---------------- */
function syncState() {
  if (!st.online) return ['bad', 'Offline: changes won’t save'];
  if (st.inflight) return ['busy', 'Saving…'];
  return ['ok', 'Saved'];
}
function header() {
  const u = st.auth?.user, season = seasonLabel(), [k, t] = syncState();
  return `
  <div class="hdr-bar wrap">
    <div class="brand"><span class="brand-k">RoboRacer · Race Tracker</span><h1>TA Console</h1>${season ? `<span class="hdr-season" title="${esc(season)}">${esc(season)}</span>` : ''}</div>
    <div class="hdr-tools">
      ${u && st.auth.isTA ? `<span class="save ${k}" role="status"><span class="save-ico" aria-hidden="true"></span>${esc(t)}</span>` : ''}
      <a class="btn ghost" href="index.html" target="_blank" rel="noopener"><span class="hide-sm">View </span>Public board <span aria-hidden="true">↗</span></a>
    </div>
    ${u ? `<div class="hdr-acct small"><span class="muted">Signed in as</span> <b class="email">${esc(u.email)}</b> <button type="button" class="btn sm" data-act="signout" data-k="signout">Sign out</button></div>` : ''}
  </div>`;
}
function banner() {
  if (store.mode !== 'demo') return '';
  const has = st.S?.teams?.length;
  return `<div class="wrap"><div class="demo" role="note"><p><b>Demo mode:</b> data is only saved in this browser.</p><div class="demo-b">
    ${has ? cbtn({ key: 'seed', label: 'Load sample data', confirm: 'Adds 6 more teams. Tap again', act: 'seed', cls: 'btn sm' }) : '<button type="button" class="btn sm" data-act="seed" data-k="seed">Load sample data</button>'}
    ${cbtn({ key: 'reset', label: 'Reset', confirm: 'Wipe all demo data?', act: 'reset', cls: 'btn sm danger' })}</div></div></div>`;
}
function nav() {
  const t = tab(), lm = st.S && C.liveMatch(st.S), run_ = lm && phase(lm) === 'running';
  return `<div class="nav-in wrap">${TABS.map(([k, l]) => `<button type="button" class="nav-b" data-act="tab" data-tab="${k}" data-k="nav-${k}" ${k === t ? 'aria-current="page"' : ''}>${svg(k)}<span>${l}</span>${k === 'heat' && run_ ? '<span class="dot live" aria-hidden="true"></span><span class="sr"> (race running)</span>' : ''}</button>`).join('')}</div>`;
}

/* ---------------- gate screens ---------------- */
function gate() {
  const a = st.auth, card = (h, b) => `<section class="gate panel">${h}${b}</section>`;
  const pub = '<p class="small"><a href="index.html">Open the public results page →</a></p>';
  if (!a) return card('<h2>Loading…</h2>', '');
  if (!a.user) return card('<p class="eyebrow">Race Tracker</p><h2>Sign in to enter results</h2>', `<p>This page is for course TAs. Sign in with Google. Only accounts on the TA list can make changes.</p><button type="button" class="btn pri xl" data-act="signin" data-k="signin">Sign in with Google</button>${pub}`);
  const out = `<button type="button" class="btn" data-act="signout" data-k="signout2">Sign out</button>`;
  if (!a.isTA && a.canClaim) return card('<p class="eyebrow">First-time setup</p><h2>Set up this race board</h2>', `<p>There are no TAs yet. You'll be added as the first TA using <b>${esc(a.user.email)}</b>. You can add the other TAs in Settings afterwards.</p><div class="row"><button type="button" class="btn pri xl" data-act="claim" data-k="claim">Become the first TA</button>${out}</div>`);
  if (!a.isTA) return card('<h2>Not on the TA list</h2>', `<p><b>${esc(a.user.email)}</b> isn’t on the TA list. Ask a TA to add you under <b>Settings → TA list</b>, then reload this page.</p><div class="row">${out}</div>${pub}`);
  if (st.cfg === undefined) return card('<h2>Loading…</h2>', '');
  if (st.cfg === null) return card('<h2>Can’t load the race board</h2>', `<p class="muted">${esc(errText(st.cfgErr))}</p>`);
  if (!st.cfg.current) return card('<p class="eyebrow">First-time setup</p><h2>Create the first season</h2>', `<p>Each year’s race is saved as its own season. Next year you can start a new one and this one will still be viewable.</p>${seasonForm('fs', '', 'Create season', false)}`);
  if (st.S === undefined) return card('<h2>Loading season…</h2>', '');
  if (st.S === null) return card('<h2>Season not found</h2>', '<p>The current season document is missing. Pick another season or create one in Settings.</p>');
  return null;
}
function seasonForm(p, name, submit, twoStep) {
  return `<form class="stack" data-form="season" data-p="${p}" autocomplete="off">
    <div class="field"><label for="${p}-name">Course name</label><input id="${p}-name" data-k="${p}-name" value="${dv(p + '-name', name)}" placeholder="CMU 16-665 Robot Mobility" required></div>
    <div class="field"><label for="${p}-label">Season label</label><input id="${p}-label" data-k="${p}-label" value="${dv(p + '-label', '')}" placeholder="Fall 2027" required></div>
    ${twoStep ? cbtn({ key: p + '-go', label: submit, confirm: 'Tap again: start it and make it current', cls: 'btn pri', type: 'submit' }) : `<button class="btn pri">${submit}</button>`}
    ${msg(p)}</form>`;
}

/* ---------------- HEAT ---------------- */
function vHeat() {
  const S = st.S;
  if (!S.bracket) return [['h0', `<div class="empty big-empty"><h2>No bracket yet</h2><p>Build the bracket once qualifying is done.</p><button type="button" class="btn pri" data-act="tab" data-tab="bracket" data-k="go-b">Go to Bracket</button></div>`]];
  const m = C.liveMatch(S);
  if (!m) return [['h0', noLive(S)]];
  const e = C.entrants(S, m);
  return [['h-top', heatTop(S, m)], ['h-clock', heatClock(S, m, e)], ['h-side', sidePick(S, m, e)], ['h-teams', heatTeams(S, m, e)], ['h-end', heatEnd(S, m, e)]];
}
const nm = (S, m, e, i) => e[i] ? C.tname(S, e[i]) : C.srcLabel(S, m.src[i]);
function phasePill(m) {
  return { ready: '<span class="pill">● On track · clock not started</span>', running: '<span class="pill live"><span class="dot live" aria-hidden="true"></span> Running</span>', paused: '<span class="pill wait">❚❚ Paused</span>', done: '<span class="pill ok">✓ Finished</span>' }[phase(m)];
}
function upNext(S, title) {
  const n = C.nextMatch(S); if (!n) return '';
  const e = C.entrants(S, n);
  return `<section class="panel upnext"><p class="eyebrow">${title}</p><h3 class="un-title">${esc(n.label)}</h3><p class="un-vs"><b>${esc(C.tname(S, e[0]))}</b> <span class="muted">vs</span> <b>${esc(C.tname(S, e[1]))}</b></p><button type="button" class="btn pri lg" data-act="track" data-mid="${n.id}" data-k="track-${n.id}">Put on track</button></section>`;
}
function noLive(S) {
  const champ = C.standings(S)[0];
  const ready = C.playOrder(S).filter(m => m.status === 'pending' && C.entrants(S, m).every(Boolean));
  return `<div class="empty big-empty"><h2>Nothing on track</h2><p>${champ ? `Bracket complete. Champion: <b>${esc(C.tname(S, champ))}</b>.` : 'Pick the next race to start.'}</p></div>
  ${upNext(S, 'Up next')}
  ${ready.length > 1 ? `<section class="panel"><h3>Other races ready</h3><div class="stack">${ready.slice(1).map(m => { const e = C.entrants(S, m); return `<button type="button" class="btn lg left" data-act="track" data-mid="${m.id}" data-k="track-${m.id}"><b>${esc(m.label)}</b>&nbsp;· ${esc(C.tname(S, e[0]))} vs ${esc(C.tname(S, e[1]))}</button>`; }).join('')}</div></section>` : ''}`;
}
function heatTop(S, m) {
  return `<div class="heat-top"><div class="ht-l"><p class="eyebrow">${esc(m.round)} · Race ${esc(m.id)}</p><h2>${esc(m.label)}</h2></div><div class="ht-r">${phasePill(m)}<button type="button" class="btn sm" data-act="tab" data-tab="bracket" data-k="switch">Switch race</button></div></div>`;
}
function heatClock(S, m, e) {
  const ph = phase(m);
  if (ph === 'done') return `<section class="clock panel ph-done" aria-label="Race clock"><div class="clock-read"><div class="clock-lbl">Finished · time raced</div><div class="clock-time mono">${C.fmtClock(C.elapsed(m))}</div></div></section>`;
  const lbl = { running: 'Remaining', paused: 'Paused · remaining', ready: `Race length ${C.fmtClock(C.heatLength(S))}` }[ph];
  const btn = ph === 'running' ? `${svg('pause')}<span>Pause clock</span>` : `${svg('play')}<span>${ph === 'paused' ? 'Resume clock' : 'Start race'}</span>`;
  return `<section class="clock panel ph-${ph}" data-clockwrap aria-label="Race clock">
    <div class="clock-read"><div class="clock-lbl" data-clocklbl="${esc(lbl)}">${esc(lbl)}</div><div class="clock-time mono" data-clock="${m.id}" role="timer" aria-atomic="true">${C.fmtClock(C.remaining(S, m))}</div></div>
    <button type="button" class="clockbtn cb-${ph}" data-act="clock" data-mid="${m.id}" data-running="${ph === 'running' ? 1 : 0}" data-k="clock" ${e[0] && e[1] ? '' : 'disabled'}>${btn}</button>
  </section>`;
}
function sidePick(S, m, e) {
  const o = [['A', esc(nm(S, m, e, 0))], ['both', 'Both'], ['B', esc(nm(S, m, e, 1))]];
  return `<div class="sidepick"><span class="sp-lbl" id="sp-lbl">This device counts</span>${seg('This device counts laps for', o.map(([v, l]) => [v, `<span class="sp-t">${l}</span>`, '✓']), st.side, 'side')}</div>`;
}
function heatTeams(S, m, e) {
  if (st.side === 'A' || st.side === 'B') { const i = st.side === 'A' ? 0 : 1; return `<div class="teams one">${teamPanel(S, m, e, i)}${teamMini(S, m, e, 1 - i)}</div>`; }
  return `<div class="teams two">${teamPanel(S, m, e, 0)}${teamPanel(S, m, e, 1)}</div>`;
}
function teamPanel(S, m, e, i) {
  const name = nm(S, m, e, i), ph = phase(m), done = ph === 'done', seed = C.seedOf(S, e[i]);
  const left = st.lock[i] - Date.now(), locked = left > 0, win = done && m.winner === i;
  const hint = st.pend[i] ? 'Sending…' : done ? 'Reopen the race to change laps' : ph === 'ready' ? 'Clock not started' : ph === 'paused' ? 'Clock paused' : '';
  const fk = `frac${m.id}${i}`;
  return `<section class="tp${m.dq[i] ? ' is-dq' : ''}${win ? ' is-win' : ''}${done && !win ? ' is-lose' : ''}" aria-labelledby="tpn${i}">
    <header class="tp-h"><span class="tp-slot" aria-hidden="true">${'AB'[i]}</span><div class="tp-id"><h3 id="tpn${i}" class="tp-name">${esc(name)}</h3><span class="small muted">${seed ? 'Seed ' + seed : ''}</span></div>${win ? '<span class="pill ok">✓ Winner</span>' : ''}</header>
    <div class="tp-count" aria-label="${m.laps[i]} laps${m.frac[i] ? ' plus ' + m.frac[i].toFixed(2) : ''}"><span class="tp-laps mono">${m.laps[i]}</span><span class="tp-unit">${C.targetLaps(S) ? `of ${C.targetLaps(S)} laps` : m.laps[i] === 1 ? 'lap' : 'laps'}${m.frac[i] ? `<span class="mono tp-frac">+${m.frac[i].toFixed(2)}</span>` : ''}</span></div>
    ${C.finishedAt(m, i) != null ? `<p class="small"><b>Finished in <span class="mono">${C.fmtTime(C.finishedAt(m, i))}</span></b></p>` : ''}
    ${m.dq[i] ? '<p class="dq-flag">✕ Disqualified</p>' : ''}
    <button type="button" class="lapbtn${locked ? ' locked' : ''}" style="--ld:${locked ? left - LAP_LOCK : 0}ms" data-act="lap" data-i="${i}" data-mid="${m.id}" data-k="lap${i}" ${done || !e[i] ? 'disabled' : ''} aria-label="Add one lap for ${esc(name)}"><span class="lb-plus">+1</span><span class="lb-word">LAP</span></button>
    <p class="tp-hint small">${hint}</p>
    ${raceLapList(m, i)}
    <div class="tp-tools">
      <button type="button" class="btn minus" data-act="unlap" data-i="${i}" data-mid="${m.id}" data-k="unlap${i}" ${done || !m.laps[i] ? 'disabled' : ''} aria-label="Remove one lap for ${esc(name)}">−1 lap</button>
      <label class="frac"><span>Partial lap</span><input type="number" inputmode="decimal" min="0" max="0.99" step="0.05" placeholder="0.00" value="${dv(fk, m.frac[i] || '')}" data-change="frac" data-mid="${m.id}" data-i="${i}" data-k="${fk}" ${done ? 'disabled' : ''} aria-label="Partial lap distance for ${esc(name)}, 0 to 0.99"></label>
      ${cbtn({ key: `dq${m.id}${i}`, label: m.dq[i] ? 'Lift DQ' : 'DQ', confirm: m.dq[i] ? 'Lift DQ?' : 'Confirm DQ', act: 'dq', cls: 'btn danger dqbtn', attrs: `data-mid="${m.id}" data-i="${i}" data-on="${m.dq[i] ? 0 : 1}" aria-label="${m.dq[i] ? 'Lift disqualification' : 'Disqualify'} ${esc(name)}"`, disabled: done || !e[i] })}
    </div>
  </section>`;
}
function raceLapList(m, i) {
  const L = C.lapTimes(m, i); if (!L.length) return '';
  const best = Math.min(...L.map(l => l.t));
  return `<details class="laplist"${L.length <= 12 ? ' open' : ''}><summary class="small">Lap times (s) · best <b class="mono">${C.fmtTime(best)}</b></summary><ol class="mono small">${L.map(l => `<li${l.t === best ? ' class="best"' : ''}><span class="muted">${l.n}</span> ${C.fmtTime(l.t)}</li>`).join('')}</ol></details>`;
}
function teamMini(S, m, e, i) {
  return `<section class="tp-mini" aria-label="${esc(nm(S, m, e, i))}, counted on another device"><span class="tp-slot" aria-hidden="true">${'AB'[i]}</span><span class="tp-name">${esc(nm(S, m, e, i))}${m.dq[i] ? ' <span class="pill no">DQ</span>' : ''}</span><span class="mono mini-laps">${dist(m, i)}</span><span class="small muted mini-note">laps · counted on another device</span></section>`;
}
function why(m) { return m.dq[0] !== m.dq[1] ? 'opponent DQ' : C.finishedAt(m, 0) != null || C.finishedAt(m, 1) != null ? 'finished first' : m.laps[0] !== m.laps[1] ? 'more laps' : m.frac[0] !== m.frac[1] ? 'partial-lap tiebreak' : 'tie, better seed'; }
function heatEnd(S, m, e) {
  const nk = 'note' + m.id;
  const note = `<div class="field"><label for="${nk}">Race note <span class="muted small">(shown publicly)</span></label><input id="${nk}" data-k="${nk}" value="${dv(nk, m.note)}" data-change="note" data-mid="${m.id}" maxlength="160" placeholder="e.g. restarted after a collision at 2:10" autocomplete="off"></div>`;
  const reset = cbtn({ key: 'rs' + m.id, label: 'Reset race', confirm: 'Tap again: wipe laps & clock', act: 'resetheat', cls: 'btn danger', attrs: `data-mid="${m.id}"` });
  const ready = e[0] && e[1];
  if (m.status !== 'done') {
    const w = ready ? C.autoWinner(S, m) : 0;
    const proj = ready ? `${C.tname(S, e[w])} wins ${dist(m, w)} – ${dist(m, 1 - w)} (${why(m)})` : '';
    return `<section class="panel end"><h3>Finish</h3>
      <p class="small">${C.targetLaps(S) ? `The first team to finish ${C.targetLaps(S)} laps wins, and the race ends by itself when they do. If time runs out first, the winner is decided by DQ, then most laps, then partial lap, then better qualifying seed.` : 'The winner is decided by DQ, then most laps, then partial lap, then better qualifying seed.'}${ready ? ` If you finish now: <b>${esc(proj)}</b>` : ''}</p>
      ${cbtn({ key: 'fin' + m.id, label: `${svg('flag')} Finish &amp; score`, confirm: `Confirm: ${esc(proj)}`, act: 'finish', cls: 'btn finbtn', attrs: `data-mid="${m.id}"`, disabled: !ready })}
      ${note}<div class="row end-tools">${reset}</div></section>`;
  }
  const w = m.winner, auto = C.autoWinner(S, m), o = 1 - w;
  return `<section class="panel end result"><p class="eyebrow">Result${w !== auto ? ' · set manually' : ''}</p>
    <h2 class="res-w">${svg('flag')} ${esc(C.tname(S, e[w]))} wins</h2>
    <p class="mono res-s">${dist(m, w)} – ${dist(m, o)} laps <span class="muted small">(${w !== auto ? 'TA override' : why(m)})</span></p>
    <div class="row">${cbtn({ key: 'sw' + m.id, label: `Make ${esc(C.tname(S, e[o]))} the winner`, confirm: `Tap again: ${esc(C.tname(S, e[o]))} wins`, act: 'setwinner', attrs: `data-mid="${m.id}" data-i="${o}"` })}
    ${cbtn({ key: 'ro' + m.id, label: 'Reopen race', confirm: 'Tap again to reopen', act: 'reopen', attrs: `data-mid="${m.id}"` })}</div>
    ${note}<div class="row end-tools">${reset}</div></section>${upNext(S, 'Next race')}`;
}

/* ---------------- QUALIFYING ---------------- */
const SP = { advances: ['ok', '✓ Advances'], 'hw-fail': ['no', '✕ Hardware'], 'obstacle-fail': ['no', '✕ Obstacle'], crash: ['no', '✕ Crashed'], incomplete: ['wait', '… Needs 2 clean laps'], pending: ['wait', '… Pending'] };
const statusPill = s => `<span class="pill ${SP[s][0]}">${SP[s][1]}</span>`;
function vQuali() {
  const S = st.S, fast = C.fastestLap(S);
  return [
    ['q-head', `<div class="viewhead"><h2>Qualifying</h2><p class="small muted">${S.teams.length} teams · ${C.seedOrder(S).length} advance · fastest lap <span class="mono purple">${C.fmtTime(fast)}</span></p></div>`],
    ['q-list', S.teams.length ? `<div class="tclist">${S.teams.map(t => teamCard(S, t, fast)).join('')}</div>` : '<div class="empty">No teams yet. Add the first team below.</div>'],
    ['q-add', `<section class="panel"><h3>Add team</h3><form class="row nowrap" data-form="addteam" autocomplete="off"><label for="newteam" class="sr">New team name</label><input id="newteam" data-k="newteam" value="${dv('newteam', '')}" placeholder="Team name" maxlength="40" enterkeyhint="done"><button class="btn pri">Add team</button></form>${msg('newteam')}</section>`],
  ];
}
function lapList(e, id, fast, counts, removable) {
  const b = C.evalBest(e);
  if (!e || !e.laps.length) return '<span class="muted small">No laps yet.</span>';
  return e.laps.map((v, j) => {
    const t = C.fmtTime(v), top = counts && v === b, tag = top ? `<small>${v === fast ? 'FASTEST' : 'BEST'}</small>` : '', cls = `lapchip${top ? ' best' : ''}${top && v === fast ? ' fast' : ''}`;
    return removable ? cbtn({ key: `dl${id}${e.id}${j}`, label: `<span class="mono">${t}</span>${tag}<span class="x" aria-hidden="true">×</span>`, confirm: `Delete ${t}?`, act: 'dellap', cls, attrs: `data-id="${id}" data-eid="${e.id}" data-v="${v}" aria-label="Lap ${t} seconds. Delete"` })
      : `<span class="${cls}"><span class="mono">${t}</span>${tag}</span>`;
  }).join('');
}
function stepper(label, val, act, attrs, canDown, canUp, k, sub = '') {
  return `<div class="stepper" role="group" aria-label="${esc(label)}"><span class="flbl">${label}${sub ? `<span class="muted small"> ${sub}</span>` : ''}</span><div class="st-row">
    <button type="button" class="btn st-b" data-act="${act}" data-d="-1" ${attrs} data-k="${k}-" ${canDown ? '' : 'disabled'} aria-label="Decrease ${esc(label)}">−</button>
    <output class="mono st-v">${val}</output>
    <button type="button" class="btn st-b" data-act="${act}" data-d="1" ${attrs} data-k="${k}+" ${canUp ? '' : 'disabled'} aria-label="Increase ${esc(label)}">+</button></div></div>`;
}
function lapTimer(e, a, k) {
  if (!e.timer) return `<div class="lt"><button type="button" class="btn pri lt-start" data-act="ltstart" ${a} data-k="lts${k}">⏱ Start lap timer</button><span class="small muted">Tap when the car crosses the start line.</span></div>`;
  const locked = (st.ltLock[k] || 0) > Date.now();
  return `<div class="lt running" aria-label="Lap timer running">
    <div class="lt-read"><span class="small muted">Current lap</span><span class="lt-time mono" data-lapclock="${e.timer.last}" role="timer">${((C.nowMs() - e.timer.last) / 1000).toFixed(1)}</span><span class="small muted">s</span></div>
    <button type="button" class="lapbtn lt-lap${locked ? ' locked' : ''}" data-act="ltlap" ${a} data-lk="${k}" data-k="ltl${k}" aria-label="Record lap"><span class="lb-plus">LAP</span><span class="lb-word">tap at the line</span></button>
    <div class="row">
      ${cbtn({ key: 'ltr' + k, label: 'Restart lap', confirm: 'Tap again: drop this lap', act: 'ltrestart', cls: 'btn sm', attrs: a })}
      ${cbtn({ key: 'ltx' + k, label: 'Stop timer', confirm: 'Tap again to stop', act: 'ltstop', cls: 'btn sm danger', attrs: a })}
    </div>
    <p class="small muted">Restart lap skips the current lap without recording it (for a crash).</p>
  </div>`;
}
function evalBlock(S, t, e, ch, fast) {
  const id = t.id, counts = e === ch, b = C.evalBest(e), g = C.evalGrade(e), scr = Math.max(0, e.scrapes - 2), k = id + e.id, a = `data-id="${id}" data-eid="${e.id}"`;
  const parts = [`${e.dist / 2 * 100} distance`];
  if (scr) parts.push(`− ${5 * scr} scrapes`); if (e.crashes) parts.push(`− ${10 * e.crashes} crashes`);
  return `<section class="ev${counts ? ' counts' : ''}" aria-label="Evaluation ${e.n}${counts ? ', counts' : ''}">
    <header class="ev-h"><h4>Evaluation ${e.n}</h4><span class="mono small ev-sum">${b != null ? C.fmtTime(b) + ' s' : 'no laps'} · ${Math.round(g)}%</span>
      ${counts ? '<span class="pill ok">✓ Counts</span>' : `<button type="button" class="btn sm" data-act="pickeval" ${a} data-k="pe${k}">Use this one</button>`}</header>
    <div class="lapchips">${lapList(e, id, fast, counts, true)}</div>
    ${lapTimer(e, a, k)}
    <form class="row nowrap" data-form="lap" ${a} autocomplete="off"><label class="sr" for="li${k}">Lap time in seconds, ${esc(t.name)}, evaluation ${e.n}</label><input id="li${k}" class="mono" data-k="li${k}" value="${dv('li' + k, '')}" inputmode="decimal" enterkeyhint="done" placeholder="seconds, e.g. 12.345" aria-describedby="msg-li${k}"><button class="btn">Add lap</button></form>${msg('li' + k)}
    <div class="grade-grid">
      <div class="stepper"><label class="flbl" for="ds${k}">Crash-free laps<span class="muted small"> in a row</span></label><div class="st-row">
        <select id="ds${k}" class="dist-sel mono" data-k="ds${k}" data-change="evdist" ${a}>${[0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(v => `<option value="${v}" ${v === e.dist ? 'selected' : ''}>${v} of 2${v === 2 ? ' (full)' : ''}</option>`).join('')}</select></div></div>
      ${stepper('Scrapes', e.scrapes, 'bump', `${a} data-f="scrapes"`, e.scrapes > 0, true, 'sc' + k, '2 free, then −5%')}
      ${stepper('Crashes', e.crashes, 'bump', `${a} data-f="crashes"`, e.crashes > 0, true, 'cr' + k, '−10% each')}
    </div>
    <p class="small grade-line">Completion <b class="mono">${Math.round(g)}%</b> <span class="muted">= ${parts.join(' ')}</span></p>
    <div class="ev-foot">${cbtn({ key: 're' + k, label: 'Delete evaluation', confirm: `Tap again: delete evaluation ${e.n}`, act: 'rmeval', cls: 'btn sm danger', attrs: a })}</div>
  </section>`;
}
function teamCard(S, t, fast) {
  const q = C.Q(S, t.id), b = C.best(S, t.id), g = C.grade(S, t.id), order = C.qualiOrder(S), id = t.id, ch = C.chosenEval(S, id);
  return `<details class="tc" data-team="${id}" ${st.open.has(id) ? 'open' : ''}>
    <summary data-k="sum${id}"><span class="tc-pos mono">${b != null ? 'P' + (order.indexOf(id) + 1) : '—'}</span><span class="tc-name">${esc(t.name)}${ch ? `<span class="tc-ev small muted"> · eval ${ch.n}</span>` : ''}${q.evals.some(e => e.timer) ? ' <span class="pill live">⏱ Timing</span>' : ''}</span>
      <span class="tc-best mono${b != null && b === fast ? ' purple' : ''}" title="Best lap (seconds)">${C.fmtTime(b)}</span><span class="tc-grade mono" title="Completion">${Math.round(g)}%</span>${statusPill(C.qualiStatus(S, id))}<span class="tc-chev" aria-hidden="true"></span></summary>
    <div class="tc-body">
      <div class="field"><label for="nm${id}">Team name</label><input id="nm${id}" data-k="nm${id}" value="${dv('nm' + id, t.name)}" data-change="rename" data-id="${id}" maxlength="40" autocomplete="off"></div>
      <div class="field"><span class="flbl">Hardware check</span>${seg('Hardware check for ' + t.name, [['null', 'Unchecked', '•'], ['true', 'Compliant', '✓', 'good'], ['false', 'Not compliant', '✕', 'bad']], String(t.hw ?? null), 'hw', `data-id="${id}"`, 'hw' + id)}</div>
      <div class="field"><span class="flbl">Obstacle avoidance</span>${seg('Obstacle avoidance for ' + t.name, [['pending', 'Pending', '•'], ['pass', 'Pass', '✓', 'good'], ['fail', 'Fail', '✕', 'bad']], q.obstacle, 'obs', `data-id="${id}"`, 'ob' + id)}</div>
      <div class="field"><span class="flbl">Timed evaluations <span class="muted small">The team picks one. Its best lap and completion are what count.</span></span>
        <div class="evals">${q.evals.map(e => evalBlock(S, t, e, ch, fast)).join('') || '<p class="muted small">No evaluations yet. Adding a lap starts evaluation 1.</p>'}</div>
        <div class="row">${q.evals.length ? '' : `<form class="row nowrap" data-form="lap" data-id="${id}" autocomplete="off"><label class="sr" for="li${id}">First lap time in seconds for ${esc(t.name)}</label><input id="li${id}" class="mono" data-k="li${id}" value="${dv('li' + id, '')}" inputmode="decimal" enterkeyhint="done" placeholder="seconds, e.g. 12.345"><button class="btn">Add lap</button></form>`}
          <button type="button" class="btn" data-act="addeval" data-id="${id}" data-k="ae${id}">+ New evaluation</button></div>${q.evals.length ? '' : msg('li' + id)}</div>
      <div class="tc-foot">${cbtn({ key: 'rm' + id, label: 'Remove team', confirm: `Tap again: remove ${esc(t.name)}`, act: 'rmteam', cls: 'btn danger', attrs: `data-id="${id}"` })}</div>
    </div></details>`;
}

/* ---------------- BRACKET ---------------- */
function vBracket() {
  const S = st.S, b = S.bracket, seeds = C.seedOrder(S), out = C.qualiOrder(S).filter(id => !C.advances(S, id));
  const reason = { 'hw-fail': 'hardware not compliant', 'obstacle-fail': 'failed obstacle avoidance', crash: 'chosen evaluation has a crash', incomplete: 'chosen evaluation has fewer than 2 crash-free laps', pending: '' };
  const pendWhy = id => { const t = C.team(S, id), q = C.Q(S, id); return [q.obstacle === 'pending' && 'obstacle pending', C.best(S, id) == null && 'no timed lap'].filter(Boolean).join(', '); };
  const changed = b && JSON.stringify(b.seeds) !== JSON.stringify(seeds);
  const anyRes = b?.matches.some(m => m.status !== 'pending');
  const seedsHtml = `<section class="panel"><h3>Who advances</h3><p class="small muted">Seeded by best lap in each team's chosen evaluation. A team needs to pass obstacle avoidance, not fail the hardware check, and its chosen evaluation must have 2 crash-free laps in a row with no crashes.</p>
    ${seeds.length ? `<ol class="seedlist">${seeds.map((id, i) => `<li><span class="seed mono">${i + 1}</span><span class="nm">${esc(C.tname(S, id))}</span><span class="mono">${C.fmtTime(C.best(S, id))}</span></li>`).join('')}</ol>` : '<p class="empty">No team qualifies yet.</p>'}
    ${out.length ? `<h3 class="sub">Not advancing</h3><ul class="outlist">${out.map(id => `<li><span class="nm">${esc(C.tname(S, id))}</span>${statusPill(C.qualiStatus(S, id))}<span class="small muted">${esc(reason[C.qualiStatus(S, id)] || pendWhy(id))}</span></li>`).join('')}</ul>` : ''}</section>`;
  const actions = !b
    ? `<section class="panel"><button type="button" class="btn pri xl" data-act="build" data-k="build" ${seeds.length < 2 ? 'disabled' : ''}>Build bracket from qualifying · ${seeds.length} teams</button>${seeds.length < 2 ? '<p class="small muted">At least 2 teams must advance.</p>' : ''}</section>`
    : `<section class="panel"><p class="small">${b.seeds.length} teams seeded · ${C.isDouble(S) ? 'double elimination · losers bracket · one grand final' : `${b.x}-team bracket${b.x < b.seeds.length ? ` with ${b.seeds.length - b.x} play-in${b.seeds.length - b.x > 1 ? 's' : ''}` : ''}${C.match(S, 'THIRD') ? ' · 3rd place match' : ''}`}</p>
      ${changed ? '<p class="warn" role="note"><b>⚠ Qualifying changed since the bracket was built.</b> Rebuild to re-seed. Rebuilding wipes all race results.</p>' : ''}
      <div class="row">${cbtn({ key: 'rebuild', label: 'Rebuild from qualifying', confirm: anyRes ? 'Tap again: wipes all race results' : 'Tap again to rebuild', act: 'build', cls: 'btn' + (changed ? ' pri' : '') })}
      ${cbtn({ key: 'clear', label: 'Clear bracket', confirm: anyRes ? 'Tap again: deletes all races' : 'Tap again to clear', act: 'clear', cls: 'btn danger' })}</div></section>`;
  const parts = [['b-head', '<div class="viewhead"><h2>Bracket</h2><p class="small muted">Tap a race to start it.</p></div>']];
  const dbl = b && (C.isDouble(S) || C.canDouble(b));
  if (dbl) parts.push(['b-fmt', `<section class="panel stack"><h3>Format</h3>${seg('Bracket format', [['single', 'Single elimination', '✓'], ['double', 'Double elimination', '✓']], b.format || 'single', 'fmt')}
    <p class="small muted">${C.isDouble(S) ? 'Losers bracket: the play-in losers race for a spot, that team races the quarterfinal 3 loser, and the other three quarterfinal losers join them. Semifinal and winners-final losers drop in later. The losers-bracket winner races the winners-bracket winner in one grand final.' : 'Double elimination gives every team a second chance in a losers bracket.'} Races both formats share (play-ins, quarterfinals, semifinals) keep their results when you switch, and the public board shows whichever format is on.</p></section>`]);
  const roundsHtml = rs => `<div class="rounds">${rs.map(r => `<section class="round"><h3>${esc(r.name === 'Final' && C.isDouble(S) ? 'Grand final' : r.name)}</h3>${r.matches.map(m => mcard(S, m)).join('')}</section>`).join('')}</div>`;
  if (b && C.isDouble(S)) { // winners bracket (and grand final) on top, losers bracket below
    const rs = C.rounds(S), lose = rs.filter(r => C.isLosersRound(r.name));
    parts.push(['b-rounds', `<h3 class="bk-h">Winners bracket</h3>${roundsHtml(rs.filter(r => !lose.includes(r)))}<h3 class="bk-h">Losers bracket</h3>${roundsHtml(lose)}`]);
  } else if (b) parts.push(['b-rounds', roundsHtml(C.rounds(S))]);
  parts.push(['b-act', actions], ['b-seeds', seedsHtml]);
  return parts;
}
function mcard(S, m) {
  const e = C.entrants(S, m), live = S.bracket.liveId === m.id, nx = C.nextMatch(S)?.id === m.id, ready = e[0] && e[1], ph = phase(m);
  const row = i => `<li class="${m.winner === i ? 'w' : m.winner === 1 - i ? 'l' : ''}"><span class="seed mono">${C.seedOf(S, e[i]) ?? ''}</span><span class="nm">${e[i] ? esc(C.tname(S, e[i])) : `<i class="muted">${esc(C.srcLabel(S, m.src[i]))}</i>`}${m.dq[i] ? ' <span class="pill no">DQ</span>' : ''}</span><span class="mono sc">${m.status !== 'pending' || C.distance(m, i) ? dist(m, i) : ''}</span><span class="wi" aria-label="${m.winner === i ? 'winner' : ''}">${m.winner === i ? '✓' : ''}</span></li>`;
  const pill = C.notNeeded(S, m) ? '<span class="pill">Not needed</span>' : live && ph !== 'done' ? (ph === 'running' ? '<span class="pill live">● Running</span>' : '<span class="pill live">On track</span>') : m.status === 'done' ? '<span class="pill ok">✓ Final</span>' : nx ? '<span class="pill wait">Up next</span>' : ready ? '<span class="pill">Ready</span>' : '<span class="pill">Waiting</span>';
  const btn = live ? `<button type="button" class="btn pri" data-act="tab" data-tab="heat" data-k="open-${m.id}">Open race</button>`
    : m.status === 'done' ? `<button type="button" class="btn" data-act="track" data-mid="${m.id}" data-k="track-${m.id}">Review / edit result</button>`
      : ready ? `<button type="button" class="btn${nx ? ' pri' : ''}" data-act="track" data-mid="${m.id}" data-k="track-${m.id}">Put on track</button>`
        : `<button type="button" class="btn" disabled>${C.notNeeded(S, m) ? 'Not needed: the winners-bracket team won the grand final' : m.reset ? 'Only raced if the losers-bracket team wins the grand final' : 'Waiting for entrants'}</button>`;
  return `<article class="mc${live ? ' is-live' : ''}${nx ? ' is-next' : ''}${m.status === 'done' ? ' is-done' : ''}" aria-label="${esc(m.label)}"><header><span class="mc-l">${esc(m.label)}</span>${pill}</header><ol class="mc-e">${row(0)}${row(1)}</ol>${btn}</article>`;
}

/* ---------------- FEED ---------------- */
function vFeed() {
  const S = st.S;
  return [['f-post', `<div class="viewhead"><h2>Feed</h2></div><section class="panel"><h3>Post announcement</h3><form class="row nowrap" data-form="post" autocomplete="off"><label for="postin" class="sr">Announcement</label><input id="postin" data-k="postin" value="${dv('postin', '')}" maxlength="200" placeholder="e.g. 10 minute break, next race at 3:40" enterkeyhint="send"><button class="btn pri">Post</button></form>${msg('postin')}<p class="small muted">Shows up in the public feed right away.</p></section>`],
    ['f-log', `<section class="panel"><h3>Recent activity</h3>${S.log?.length ? `<ol class="log">${S.log.slice(0, 60).map(l => `<li><time class="mono small muted" datetime="${new Date(l.t).toISOString()}">${C.clockTime(l.t)}</time><span>${esc(l.m)}</span></li>`).join('')}</ol>` : '<p class="muted">Nothing yet.</p>'}</section>`]];
}

/* ---------------- SETTINGS ---------------- */
function vSettings() {
  const S = st.S, ev = S.event, me = st.auth.user.email, admins = st.auth.admins || [];
  const eventP = `<form class="panel stack" data-form="event" autocomplete="off"><h3>Event</h3>
    <div class="field"><label for="ev-name">Course name</label><input id="ev-name" data-k="ev-name" value="${dv('ev-name', ev.name)}" maxlength="80"></div>
    <div class="field"><label for="ev-season">Season label</label><input id="ev-season" data-k="ev-season" value="${dv('ev-season', ev.season)}" maxlength="40"></div>
    <div class="field"><label for="ev-heat">Race length (minutes)</label><input id="ev-heat" type="number" inputmode="decimal" min="0.5" max="60" step="0.5" data-k="ev-heat" value="${dv('ev-heat', C.heatLength(S) / 60)}"></div>
    <div class="field"><label for="ev-target">Laps to win <span class="muted small">(0 = most laps when time runs out)</span></label><input id="ev-target" type="number" inputmode="numeric" min="0" max="100" step="1" data-k="ev-target" value="${dv('ev-target', C.targetLaps(S))}"></div>
    <button class="btn pri">Save event settings</button>${msg('ev')}</form>`;
  const taP = `<section class="panel stack"><h3>TA list</h3><p class="small muted">Everyone on this list can change anything here. Use the email of their Google account. You can’t remove yourself.</p>
    <ul class="list">${admins.map(a => `<li><span class="email">${esc(a)}</span>${a === me ? '<span class="pill">You</span>' : cbtn({ key: 'ra' + a, label: 'Remove', confirm: 'Tap again to remove', act: 'rmadmin', cls: 'btn sm danger', attrs: `data-email="${esc(a)}" aria-label="Remove ${esc(a)}"` })}</li>`).join('') || '<li class="muted">No TAs listed.</li>'}</ul>
    <form class="row nowrap" data-form="addadmin" autocomplete="off"><label for="newadmin" class="sr">TA email to add</label><input id="newadmin" type="email" data-k="newadmin" value="${dv('newadmin', '')}" placeholder="name@andrew.cmu.edu" autocapitalize="off" spellcheck="false"><button class="btn">Add TA</button></form>${msg('newadmin')}</section>`;
  const seasons = st.cfg.seasons || [];
  const seaP = `<section class="panel stack"><h3>Seasons</h3><p class="small">Each year gets its own season. A new season starts with no teams or bracket, and the public page switches to it. Old seasons are kept and can still be viewed. You can switch back at any time.</p>
    <ul class="list">${seasons.map(s => `<li><span>${esc(s.label || s.id)}</span>${s.id === st.cfg.current ? '<span class="pill live">● Current</span>' : cbtn({ key: 'mc' + s.id, label: 'Make current', confirm: 'Tap again: public board switches', act: 'makecurrent', cls: 'btn sm', attrs: `data-id="${esc(s.id)}"` })}</li>`).join('')}</ul>
    <h3 class="sub">Start a new season</h3>${seasonForm('ns', ev.name, 'Start new season', true)}</section>`;
  const dispP = `<section class="panel stack"><h3>Display on this device</h3>${seg('Theme', [['system', 'System', '✓'], ['light', 'Light', '✓'], ['dark', 'Dark', '✓']], st.theme, 'theme')}<p class="small muted">Light is easier to read in sunlight.</p></section>`;
  return [['s-head', '<div class="viewhead"><h2>Settings</h2></div>'], ['s-grid', `<div class="sgrid">${eventP}${taP}${seaP}${dispP}</div>`]];
}

/* ---------------- actions ---------------- */
const ACT = {
  tab: d => setTab(d.tab),
  signin: () => store.signIn().catch(e => { if (!/popup-closed|cancelled-popup/.test(e?.code || '')) toast('Sign-in failed: ' + (e?.message || e), true); }),
  signout: () => store.signOut().catch(e => toast(errText(e), true)),
  claim: () => job(store.claim()),
  seed: () => job(store.seedSample()).then(ok => ok && toast('Sample data loaded')),
  reset: () => store.reset(),
  side: d => { st.side = d.v; LS.set('rc-admin-side', d.v); render(); },
  theme: d => { st.theme = d.v; LS.set('rc-admin-theme', d.v); if (d.v === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = d.v; render(); },
  lap(d) {
    const i = +d.i, now = Date.now(), tap = C.nowMs();
    if (now < st.lock[i]) { vib(8); return; } // double-tap guard
    st.lock[i] = now + LAP_LOCK; st.pend[i]++; vib(35);
    setTimeout(render, LAP_LOCK + 20);
    run(S => { const m = mustMatch(S, d.mid); if (m.status === 'done') throw new Error('This race is finished. Reopen it to change laps.'); return A.lap(S, d.mid, i, 1, tap); })
      .finally(() => { st.pend[i]--; render(); });
    render();
  },
  unlap(d) {
    const i = +d.i, now = Date.now(); if (now < st.unlock[i]) return; st.unlock[i] = now + LAP_LOCK; vib(15);
    run(S => { const m = mustMatch(S, d.mid); if (m.status === 'done') throw new Error('This race is finished. Reopen it to change laps.'); return A.lap(S, d.mid, i, -1); });
  },
  clock(d) {
    const now = Date.now(); if (now < st.clockLock) return; st.clockLock = now + CLOCK_LOCK;
    const was = d.running === '1'; vib(was ? 30 : [40, 40, 40]);
    run(S => {
      const m = mustMatch(S, d.mid); if (m.status === 'done') throw new Error('This race is finished.');
      // Act on what this TA saw, so two TAs tapping Start together can't cancel each other out.
      if (!!m.timer.start !== was) throw new Error(was ? 'The clock was already paused on another device.' : 'The clock was already started on another device.');
      return A.toggleClock(S, d.mid);
    });
  },
  dq: d => run(S => { mustMatch(S, d.mid); return A.setDq(S, d.mid, +d.i, d.on === '1'); }),
  finish: d => run(S => { const m = mustMatch(S, d.mid); if (m.status === 'done') throw new Error('Already finished on another device.'); return A.finish(S, d.mid); }).then(ok => ok && (vib([60, 60, 180]), toast('Race scored'))),
  setwinner: d => run(S => { mustMatch(S, d.mid); return A.setWinner(S, d.mid, +d.i); }),
  reopen: d => run(S => { mustMatch(S, d.mid); guardTrack(S, d.mid); return A.reopen(S, d.mid); }),
  resetheat: d => run(S => { mustMatch(S, d.mid); return A.resetHeat(S, d.mid); }),
  track: d => run(S => { mustMatch(S, d.mid); return A.putOnTrack(S, d.mid); }).then(ok => ok && setTab('heat')),
  build: () => run(S => {
    if (C.seedOrder(S).length < 2) throw new Error('At least 2 teams must advance to build a bracket.');
    if (C.liveMatch(S)?.timer.start) throw new Error('Pause or finish the race on track first.');
    return A.buildBracket(S);
  }).then(ok => ok && toast('Bracket built')),
  fmt: d => run(S => A.setFormat(S, d.v)).then(ok => ok && toast(d.v === 'double' ? 'Double elimination on' : 'Single elimination on')),
  clear: () => run(S => { if (C.liveMatch(S)?.timer.start) throw new Error('Pause or finish the race on track first.'); return A.clearBracket(S); }),
  dellap: d => delLap(d.id, d.eid, +d.v),
  ltstart: d => { const now = C.nowMs(); vib(30); run(S => { mustTeam(S, d.id); return A.startLapTimer(S, d.id, d.eid, now); }); },
  ltlap(d) {
    const now = C.nowMs(), k = d.lk; if ((st.ltLock[k] || 0) > Date.now()) { vib(8); return; } // double-tap guard
    st.ltLock[k] = Date.now() + LAP_LOCK; vib(35); setTimeout(render, LAP_LOCK + 20); render();
    let out = ''; run(S => { mustTeam(S, d.id); out = A.timerLap(S, d.id, d.eid, now); return out; }).then(ok => ok && toast(out));
  },
  ltrestart: d => { const now = C.nowMs(); run(S => { mustTeam(S, d.id); return A.restartLap(S, d.id, d.eid, now); }); },
  ltstop: d => run(S => { mustTeam(S, d.id); return A.stopLapTimer(S, d.id, d.eid); }),
  addeval: d => run(S => { mustTeam(S, d.id); return A.addEval(S, d.id); }).then(ok => ok && toast('New evaluation started')),
  pickeval: d => run(S => { mustTeam(S, d.id); return A.pickEval(S, d.id, d.eid); }),
  rmeval: d => run(S => { mustTeam(S, d.id); return A.removeEval(S, d.id, d.eid); }),
  hw: d => run(S => { mustTeam(S, d.id); return A.setHardware(S, d.id, d.v === 'null' ? null : d.v === 'true'); }),
  obs: d => run(S => { mustTeam(S, d.id); return A.setObstacle(S, d.id, d.v); }),
  dist: d => run(S => { mustTeam(S, d.id); const e = C.evalById(S, d.id, d.eid); if (!e) throw new Error('That evaluation was removed.'); return A.setDistance(S, d.id, e.dist + 0.25 * d.d, d.eid); }),
  bump: d => run(S => { mustTeam(S, d.id); return A.bump(S, d.id, d.f, +d.d, d.eid); }),
  rmteam: d => run(S => {
    mustTeam(S, d.id);
    if (S.bracket?.seeds.includes(d.id)) throw new Error('This team is seeded in the bracket. Clear or rebuild the bracket first.');
    return A.removeTeam(S, d.id);
  }).then(ok => ok && (st.open.delete(d.id), toast('Team removed'))),
  rmadmin: d => job(store.setAdmins((st.auth.admins || []).filter(a => a !== d.email))),
  makecurrent: d => job(store.setCurrentSeason(d.id)).then(ok => ok && toast('Switched season')),
};
function delLap(id, eid, v) {
  return run(S => { mustTeam(S, id); const e = C.evalById(S, id, eid), i = e ? e.laps.lastIndexOf(v) : -1; if (i < 0) throw new Error('That lap was already deleted.'); A.deleteLap(S, id, i, eid); return null; })
    .then(ok => ok && toast(`Deleted ${C.fmtTime(v)}`));
}
const clearDrafts = (...ks) => ks.forEach(k => delete st.drafts[k]);
const FORM = {
  lap(f) {
    const inp = f.querySelector('input'), k = inp.dataset.k, id = f.dataset.id, eid = f.dataset.eid, raw = inp.value;
    if (!id || !C.team(st.S, id)) return setMsg(k, 'Pick a team first.', 'bad');
    if (!raw.trim()) return;
    const secs = C.parseTime(normTime(raw));
    if (secs == null) { vib([40, 30, 40]); return setMsg(k, `Couldn’t read “${raw}”. Enter the time in seconds, for example 12.345.`, 'bad'); }
    if ((secs < 3 || secs > 300) && !(st.lapWarn?.k === k && st.lapWarn.raw === raw)) {
      st.lapWarn = { k, raw }; vib([40, 30, 40]);
      return setMsg(k, `${C.fmtTime(secs)} looks unusual. Press Enter again to add it anyway.`, 'warn');
    }
    st.lapWarn = null; inp.value = ''; clearDrafts(k);
    let out = '';
    run(S => { mustTeam(S, id); out = A.addLap(S, id, secs, eid); return out; }).then(ok => {
      if (ok) { vib(20); setMsg(k, '✓ ' + out, 'ok'); }
      else { st.drafts[k] = raw; render(); }
    });
  },
  addteam(f) {
    const inp = f.querySelector('input'), name = inp.value.trim(), k = 'newteam';
    if (!name) return setMsg(k, 'Type a team name.', 'bad');
    if (st.S.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) return setMsg(k, `“${name}” already exists.`, 'bad');
    inp.value = ''; clearDrafts(k);
    run(S => A.addTeam(S, name)).then(ok => ok ? setMsg(k, `✓ ${name} added`, 'ok') : (st.drafts[k] = name, render()));
  },
  post(f) {
    const inp = f.querySelector('input'), t = inp.value.trim(); if (!t) return;
    inp.value = ''; clearDrafts('postin');
    run(S => A.post(S, t)).then(ok => ok ? setMsg('postin', '✓ Posted', 'ok') : (st.drafts.postin = t, render()));
  },
  event(f) {
    const v = id => f.querySelector('#' + id).value.trim(), min = parseFloat(v('ev-heat'));
    if (!(min >= 0.5 && min <= 60)) return setMsg('ev', 'Race length must be between 0.5 and 60 minutes.', 'bad');
    const target = +v('ev-target');
    if (!(Number.isInteger(target) && target >= 0 && target <= 100)) return setMsg('ev', 'Laps to win must be a whole number from 0 to 100.', 'bad');
    const patch = { name: v('ev-name'), season: v('ev-season'), heat: Math.round(min * 60), target };
    const sid = st.sid; run(S => A.setEvent(S, patch)).then(ok => { if (ok) { store.relabelSeason(sid, patch.name, patch.season).catch(() => {}); clearDrafts('ev-name', 'ev-season', 'ev-heat', 'ev-target'); setMsg('ev', '✓ Saved', 'ok'); } });
  },
  addadmin(f) {
    const inp = f.querySelector('input'), e = inp.value.trim().toLowerCase(), admins = st.auth.admins || [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return setMsg('newadmin', 'Enter a full email address.', 'bad');
    if (admins.includes(e)) return setMsg('newadmin', `${e} is already a TA.`, 'warn');
    job(store.setAdmins([...admins, e])).then(ok => { if (ok) { inp.value = ''; clearDrafts('newadmin'); setMsg('newadmin', `✓ ${e} added`, 'ok'); } });
  },
  season(f) {
    const p = f.dataset.p, name = f.querySelector(`#${p}-name`).value.trim(), label = f.querySelector(`#${p}-label`).value.trim();
    if (!name || !label) return setMsg(p, 'Fill in both fields.', 'bad');
    job(store.createSeason(name, label)).then(ok => { if (ok) { clearDrafts(p + '-name', p + '-label'); delete st.msgs[p]; toast(`${label} started and is now current`); setTab('quali'); } });
  },
};
const CHANGE = {
  rename(el) {
    const name = el.value.trim(), id = el.dataset.id, t = C.team(st.S, id);
    if (!t || name === t.name) return;
    if (!name) { el.value = t.name; return toast('Team name can’t be empty.', true); }
    run(S => { mustTeam(S, id); return A.renameTeam(S, id, name); });
  },
  frac(el) {
    const raw = el.value.trim(), v = raw === '' ? 0 : parseFloat(raw);
    if (!(v >= 0 && v < 1)) { el.value = ''; return toast('Partial lap must be between 0 and 0.99.', true); }
    run(S => { mustMatch(S, el.dataset.mid); return A.setFrac(S, el.dataset.mid, +el.dataset.i, v); });
  },
  evdist: el => run(S => { mustTeam(S, el.dataset.id); return A.setDistance(S, el.dataset.id, +el.value, el.dataset.eid); }),
  note: el => run(S => { mustMatch(S, el.dataset.mid); return A.setNote(S, el.dataset.mid, el.value.trim()); }),
};

/* ---------------- events ---------------- */
document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-act]');
  const key = t?.dataset.confirm, wasArmed = key && armed(key), had = Object.keys(st.confirm).length;
  st.confirm = {};
  if (t && key && !wasArmed && !t.disabled) {
    e.preventDefault(); st.confirm[key] = Date.now() + ARM_MS; vib(15); announce('Tap again to confirm');
    setTimeout(render, ARM_MS + 50); render(); return;
  }
  if (t?.dataset.act && !t.disabled && ACT[t.dataset.act]) ACT[t.dataset.act](t.dataset, t);
  if (had || key) setTimeout(render, 0); // after default actions (e.g. form submit) run
});
document.addEventListener('submit', e => { const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault(); FORM[f.dataset.form]?.(f); });
document.addEventListener('change', e => { const el = e.target; if (!el.dataset?.change) return; delete st.drafts[el.dataset.k]; CHANGE[el.dataset.change]?.(el); });
document.addEventListener('input', e => { const k = e.target.dataset?.k; if (k && e.target.matches('input,textarea')) st.drafts[k] = e.target.value; if (k?.startsWith('li')) { if (st.msgs[k]?.kind !== 'ok') delete st.msgs[k]; } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && Object.keys(st.confirm).length) { st.confirm = {}; render(); }
  if (e.key === 'Enter' && e.target.dataset?.change) { e.preventDefault(); e.target.blur(); }
});
document.addEventListener('toggle', e => { const d = e.target; if (d.matches?.('details[data-team]')) d.open ? st.open.add(d.dataset.team) : st.open.delete(d.dataset.team); }, true);
// Hold re-renders while a pointer is down so the button under the finger isn't replaced mid-tap.
document.addEventListener('pointerdown', () => { st.hold = true; }, true);
const release = () => { st.hold = false; setTimeout(() => { if (st.dirty && !st.hold) render(); }, 60); };
document.addEventListener('pointerup', release, true);
document.addEventListener('pointercancel', release, true);
addEventListener('online', () => { st.online = true; render(); });
addEventListener('offline', () => { st.online = false; render(); });
document.addEventListener('visibilitychange', () => { st.wl = null; if (document.visibilityState === 'visible') render(); });
setInterval(tick, 250);

/* ---------------- data ---------------- */
function watchSeason(id) {
  st.unS?.(); st.unS = null; st.sid = id || null; st.S = id ? undefined : null;
  if (id) st.unS = store.watchSeason(id, (S, err) => { st.S = S; if (err) st.cfgErr = err; render(); });
}
store.onAuth(a => { st.auth = a; render(); });
store.watchConfig((cfg, err) => {
  st.cfg = cfg || null; st.cfgErr = err || null;
  if ((cfg?.current || null) !== st.sid) watchSeason(cfg?.current);
  render();
});
render();
