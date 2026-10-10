# DSA Tracker

A mobile-friendly PWA checklist of 281 LeetCode problems. Works offline, syncs across devices when you sign in.

- **Signed out:** progress lives in your browser (`localStorage`).
- **Signed in (Google or email/password):** progress syncs through Firebase. Only the problems you've touched are stored, as tiny docs
  at `solved/{uid}/entries/{slug}` → `{ status: 0|1|2, star: bool }`. The problem list itself (`problems.json`) ships with the app and is never written to Firestore.
- Optional public leaderboard (username + counts only).

## Firebase setup

1. [Firebase console](https://console.firebase.google.com) → create a project → **Add app → Web (`</>`)** → copy the `firebaseConfig`.
2. **Authentication → Sign-in method**: enable *Email/Password* and *Google*.
3. **Authentication → Settings → Authorized domains**: add `<your-github-username>.github.io` (`localhost` is there by default).
4. **Firestore Database → Create database**, then paste `firestore.rules` into the **Rules** tab and publish
   (or let the workflow do it, see below).
5. GitHub repo → **Settings → Secrets and variables → Actions → Variables** → add:

   | Variable | From `firebaseConfig` |
   |---|---|
   | `FIREBASE_API_KEY` | `apiKey` |
   | `FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `FIREBASE_PROJECT_ID` | `projectId` |
   | `FIREBASE_APP_ID` | `appId` |

   These are public identifiers (they end up in the shipped JS), so *Variables* is the right place; security comes from the Firestore rules, not from hiding them.
6. GitHub repo → **Settings → Pages → Source: GitHub Actions**, then push to `main`. The workflow validates, injects the config, and deploys.

### Optional: auto-deploy Firestore rules from CI
Create a service account (Firebase console → Project settings → Service accounts → Generate key; give it the *Firebase Rules Admin* role)
and save the JSON as a repo **Secret** named `FIREBASE_SERVICE_ACCOUNT`. The workflow then publishes `firestore.rules` on every deploy.
Skip it and paste the rules manually if you prefer.

## Local development
```bash
# paste your firebaseConfig into firebase-config.js (or leave empty for local-only mode)
npx serve .          # or: python3 -m http.server
npm run validate     # checks problems.json + JS syntax (also runs in CI)
```
