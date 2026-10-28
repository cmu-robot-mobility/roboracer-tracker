// Data layer. Firestore when js/firebase-config.js is filled in; otherwise a local
// demo mode (localStorage + BroadcastChannel) where everyone is a TA, for development.
//
// Firestore layout:
//   meta/config   { current: "<seasonId>", seasons: [{id, label}] }
//   meta/admins   { emails: ["ta@andrew.cmu.edu", ...] }       ← who may write
//   seasons/{id}  the whole season state (see core.emptySeason)
import { firebaseConfig } from './firebase-config.js';
import { emptySeason, setClockSkew } from './core.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const configured = !!(firebaseConfig && firebaseConfig.apiKey);
const clean = o => JSON.parse(JSON.stringify(o)); // Firestore rejects undefined
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'season';
// Measure this device's clock against the web server's Date header (±0.5 s), so heat
// countdowns agree across devices even if a phone's clock has drifted.
async function syncClock() {
  try {
    let bestRtt = Infinity, offset = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now(), r = await fetch(location.pathname + '?t=' + t0, { method: 'HEAD', cache: 'no-store' }), t1 = Date.now();
      const d = Date.parse(r.headers.get('date')); if (!isFinite(d)) return;
      if (t1 - t0 < bestRtt) { bestRtt = t1 - t0; offset = d + 500 - (t0 + t1) / 2; }
    }
    if (Math.abs(offset) > 1000) setClockSkew(offset); // ignore sub-second noise from the 1 s header resolution
  } catch {}
}
syncClock(); setInterval(syncClock, 10 * 60 * 1000);
const lc = e => String(e || '').trim().toLowerCase();
const withLog = (S, msg) => { if (msg) { S.log = [{ t: Date.now(), m: msg }, ...(S.log || [])].slice(0, 80); } S.updated = Date.now(); };

function firebaseStore() {
  let fb; // loaded SDK pieces
  const ready = (async () => {
    const [app, fs, auth] = await Promise.all(['firebase-app.js', 'firebase-firestore.js', 'firebase-auth.js'].map(f => import(SDK + f)));
    const a = app.initializeApp(firebaseConfig);
    fb = { fs, auth, db: fs.getFirestore(a), au: auth.getAuth(a) };
  })();
  const ref = path => fb.fs.doc(fb.db, path);

  return {
    mode: 'firebase',
    ready,
    watchConfig(cb) {
      let un = () => {}; ready.then(() => { un = fb.fs.onSnapshot(ref('meta/config'), s => cb(s.exists() ? s.data() : { current: null, seasons: [] }), e => cb(null, e)); });
      return () => un();
    },
    watchSeason(id, cb) {
      let un = () => {}; ready.then(() => { un = fb.fs.onSnapshot(ref('seasons/' + id), s => cb(s.exists() ? s.data() : null), e => cb(null, e)); });
      return () => un();
    },
    /** cb({user: {email, name, photo} | null, isTA, canClaim}) */
    onAuth(cb) {
      let unA = () => {}, unAdm = () => {};
      ready.then(() => {
        unA = fb.auth.onAuthStateChanged(fb.au, user => {
          unAdm();
          if (!user) return cb({ user: null, isTA: false, canClaim: false });
          const u = { email: user.email, name: user.displayName, photo: user.photoURL };
          unAdm = fb.fs.onSnapshot(ref('meta/admins'), s => {
            const emails = s.exists() ? (s.data().emails || []) : [];
            cb({ user: u, isTA: emails.map(lc).includes(lc(user.email)), canClaim: !s.exists(), admins: emails });
          }, () => cb({ user: u, isTA: false, canClaim: false, admins: [] }));
        });
      });
      return () => { unA(); unAdm(); };
    },
    async signIn() { await ready; await fb.auth.signInWithPopup(fb.au, new fb.auth.GoogleAuthProvider()); },
    async signOut() { await ready; await fb.auth.signOut(fb.au); },
    /** First sign-in on a fresh project: make yourself the first TA. */
    async claim() { await ready; await fb.fs.setDoc(ref('meta/admins'), { emails: [lc(fb.au.currentUser.email)] }); },
    async setAdmins(emails) { await ready; await fb.fs.setDoc(ref('meta/admins'), { emails: [...new Set(emails.map(lc).filter(Boolean))] }); },
    /** Run fn(S) → feed message inside a transaction. Throws fn's errors and permission errors. */
    async mutate(id, fn) {
      await ready;
      await fb.fs.runTransaction(fb.db, async tx => {
        const s = await tx.get(ref('seasons/' + id)); if (!s.exists()) throw new Error('This season no longer exists.');
        const S = s.data(); const msg = fn(S); withLog(S, msg); tx.set(ref('seasons/' + id), clean(S));
      });
    },
    async createSeason(name, season) {
      await ready;
      const cfgSnap = await fb.fs.getDoc(ref('meta/config')); const cfg = cfgSnap.exists() ? cfgSnap.data() : { seasons: [] };
      let id = slug(season || name), n = 2; while (cfg.seasons.some(s => s.id === id)) id = slug(season || name) + '-' + n++;
      const S = emptySeason(name, season); withLog(S, 'New season started');
      await fb.fs.setDoc(ref('seasons/' + id), clean(S));
      await fb.fs.setDoc(ref('meta/config'), { current: id, seasons: [...cfg.seasons, { id, label: [season, name].filter(Boolean).join(' · ') }] });
      return id;
    },
    async setCurrentSeason(id) { await ready; await fb.fs.updateDoc(ref('meta/config'), { current: id }); },
    /** Keep the season picker's label in step with the season's course name / label. */
    async relabelSeason(id, name, season) {
      await ready;
      await fb.fs.runTransaction(fb.db, async tx => {
        const c = await tx.get(ref('meta/config')); if (!c.exists()) return;
        tx.update(ref('meta/config'), { seasons: c.data().seasons.map(s => s.id === id ? { id, label: [season, name].filter(Boolean).join(' · ') } : s) });
      });
    },
  };
}

function demoStore() {
  const KEY = 'rc-demo', bc = 'BroadcastChannel' in window ? new BroadcastChannel('rc-demo') : null, subs = new Set();
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  let db = load();
  if (!db) { const S = emptySeason('CMU 16-665 Robot Mobility', 'Fall 2026'); db = { config: { current: 'demo', seasons: [{ id: 'demo', label: 'Fall 2026 · CMU 16-665 Robot Mobility' }] }, seasons: { demo: S }, admins: ['demo@example.com'] }; }
  const emit = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} bc?.postMessage(1); subs.forEach(f => f()); };
  bc && (bc.onmessage = () => { db = load() || db; subs.forEach(f => f()); });
  const watch = f => { subs.add(f); queueMicrotask(f); return () => subs.delete(f); };
  return {
    mode: 'demo',
    ready: Promise.resolve(),
    watchConfig: cb => watch(() => cb(clean(db.config))),
    watchSeason: (id, cb) => watch(() => cb(db.seasons[id] ? clean(db.seasons[id]) : null)),
    onAuth: cb => watch(() => cb({ user: { email: 'demo@example.com', name: 'Demo TA' }, isTA: true, canClaim: false, admins: db.admins })),
    async signIn() {}, async signOut() {}, async claim() {},
    async setAdmins(emails) { db.admins = emails; emit(); },
    async mutate(id, fn) { const S = clean(db.seasons[id]); const msg = fn(S); withLog(S, msg); db.seasons[id] = S; emit(); },
    async createSeason(name, season) { let id = slug(season || name), n = 2; while (db.seasons[id]) id = slug(season || name) + '-' + n++; const S = emptySeason(name, season); withLog(S, 'New season started'); db.seasons[id] = S; db.config = { current: id, seasons: [...db.config.seasons, { id, label: [season, name].filter(Boolean).join(' · ') }] }; emit(); return id; },
    async setCurrentSeason(id) { db.config.current = id; emit(); },
    async relabelSeason(id, name, season) { db.config.seasons = db.config.seasons.map(s => s.id === id ? { id, label: [season, name].filter(Boolean).join(' · ') } : s); emit(); },
    /** Demo only: fill the current season with sample teams and results. */
    async seedSample() {
      const { A, parseTime } = await import('./core.js');
      await this.mutate(db.config.current, S => {
        const names = ['Apex Predators', 'Lidar Lizards', 'Team Ackermann', 'Gap Followers', 'Pure Pursuit', 'Slip Angle'];
        const laps = [['11.842', '12.105'], ['12.390'], ['11.507', '11.913', '12.004'], ['13.281'], ['12.776', '12.640'], []];
        names.forEach((n, i) => { A.addTeam(S, n); const t = S.teams[S.teams.length - 1]; t.hw = i === 3 ? false : true;
          S.quali[t.id].obstacle = i === 5 ? 'pending' : 'pass';
          if (!laps[i].length) return;
          A.addEval(S, t.id); const e = S.quali[t.id].evals[0]; e.dist = i === 4 ? 1.5 : 2; e.scrapes = i % 4; e.crashes = i === 1 ? 1 : 0;
          laps[i].forEach(l => e.laps.push(parseTime(l)));
          if (i === 0) { A.addEval(S, t.id); const e2 = S.quali[t.id].evals[1]; e2.dist = 2; e2.laps.push(11.97, 11.66); } });
        A.buildBracket(S); return 'Sample data loaded';
      });
    },
    /** Demo only: wipe local data. */
    reset() { localStorage.removeItem(KEY); location.reload(); },
  };
}

export const store = configured ? firebaseStore() : demoStore();
