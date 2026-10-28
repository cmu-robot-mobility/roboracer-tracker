# RoboRacer Race Control

Live qualifying times, bracket and results for the CMU 16-665 RoboRacer race.

- **Public board** (`index.html`): anyone can open it with no login. It updates live.
- **TA console** (`admin.html`): sign in with Google. Only emails on the TA list can make changes.

It's a static site (GitHub Pages) backed by Firebase Firestore on the free Spark plan. There's no server or build step, and nothing costs money.

## Reusing it next year

1. Get added to this GitHub repo/org and to the TA list. Any current TA can add you from **TA console → Settings**. To change who owns the Firebase project, go to Firebase console → Project settings → Users and permissions.
2. Open the TA console, go to **Settings**, and choose **Start new season**. Past seasons stay archived and can still be viewed on the public board.
3. Update the course name, season label and heat length in Settings if anything changed. Race logic is in `js/core.js`. Change it there if the rules change.

## How it works

| File | What it is |
|---|---|
| `js/core.js` | All race rules: grading, seeding, bracket, tiebreakers, TA actions. No DOM. |
| `js/store.js` | Data layer: Firestore when configured, local demo mode otherwise. |
| `js/firebase-config.js` | Public Firebase web config. Leave it empty for demo mode. |
| `firestore.rules` | Security: everyone reads, only TAs on `meta/admins` write. |
| `index.html`, `js/public.js`, `css/public.css` | Public board. |
| `admin.html`, `js/admin.js`, `css/admin.css` | TA console. |
| `css/base.css` | Shared design tokens and components (light and dark). |

Firestore layout: `meta/config` (current season and season list), `meta/admins` (TA emails), `seasons/{id}` (one document per season).

## Running locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. While `js/firebase-config.js` is empty, the site runs in **demo mode**: data stays in your browser and everyone is a TA. That's useful for practice and for trying out changes.

## One-time Firebase setup (fresh project)

1. Create a project at https://console.firebase.google.com. You don't need Google Analytics.
2. **Build → Firestore Database → Create database**: production mode, any location.
3. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
4. **Authentication → Settings → Authorized domains → Add domain:** `<your-org>.github.io`.
5. **Project settings → Your apps → Web app (</>)**: register it, then copy the config into `js/firebase-config.js`.
6. Deploy the security rules. Either paste `firestore.rules` into **Firestore → Rules → Publish**, or run `npx firebase-tools deploy --only firestore:rules --project <project-id>`.
7. Open `admin.html` on the live site, sign in, and choose **Set up this race board**. The first person to do this becomes the first TA, so do it right after deploying.

## Hosting on GitHub Pages

In the repo, go to **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**. The site appears at `https://<org>.github.io/<repo>/`.
