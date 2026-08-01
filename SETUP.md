# Setting up Ledger

Two things to stand up: a Firebase project (accounts and storage) and GitHub Pages
(hosting). Then, optionally, a USDA API key so you can regenerate the food dataset.

Budget about twenty minutes. You will not need to write any code — the only file
you edit is `firebase-config.js`, and you are pasting six values into it.

This is written assuming you will come back to it in a year having forgotten all
of it.

---

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Create a project**.
2. **Project name:** `ledger` (or anything; it only shows in the console).
3. **Google Analytics: turn it OFF.** This app has no analytics and never will.
   Leaving it on adds a tag manager you would then have to ignore forever.
4. Click **Create project**, wait, then **Continue**.

## 2. Register the web app and copy the config

1. On the project overview page, click the **`</>`** (Web) icon.
2. **App nickname:** `ledger-web`.
3. **Do not** tick "Also set up Firebase Hosting" — GitHub Pages is doing that job.
4. Click **Register app**. Firebase shows a `firebaseConfig` object.
5. Copy those six values into **`firebase-config.js`** in this repo, replacing the
   `REPLACE_ME` placeholders.

```js
export const firebaseConfig = {
  apiKey: 'AIza…',
  authDomain: 'ledger-xxxxx.firebaseapp.com',
  projectId: 'ledger-xxxxx',
  storageBucket: 'ledger-xxxxx.firebasestorage.app',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:abc123',
};
```

**These values are not secret.** A Firebase web config identifies your project; it
is not a credential, and every Firebase web app in existence ships it in the
browser. What protects your data is the security rules in step 4. Committing this
file is correct and expected.

## 3. Turn on the two sign-in methods

**Build → Authentication → Get started → Sign-in method**

1. **Google** → Enable. Set the **project support email** to your own address
   (it is required, and it is what users see on the Google consent screen). Save.
2. **Email/Password** → Enable the **first** toggle only. Leave "Email link
   (passwordless sign-in)" **off** — the app does not implement that flow.

Nothing else on that page needs enabling.

## 4. Create the database and publish the rules

**Build → Firestore Database → Create database**

1. Choose **Start in production mode**. (Test mode leaves the database world-
   readable for 30 days. You are about to paste real rules, so skip that entirely.)
2. **Location:** pick the region closest to you — `nam5 (us-central)` is a fine
   default in the US. **This cannot be changed later**, so if you care, decide now.
3. Click **Create**, then open the **Rules** tab.
4. Delete what is there. Paste the entire contents of **`firestore.rules`** from
   this repo. Click **Publish**.

Those rules say one thing: a signed-in user can read and write documents under
`users/{their own uid}`, and nothing else. Everything else is denied.

> If you have the Firebase CLI installed, `firebase deploy --only firestore:rules`
> does the same thing from the repo.

## 5. Create the one composite index

The per-exercise progression view queries sessions by exercise and orders them by
date, which Firestore always needs a composite index for. Two ways to create it:

- **The lazy way:** do nothing now. The first time you open the Progress screen,
  the browser console shows an error containing a link. Click the link, click
  **Create index**, wait a minute. Done.
- **The tidy way:** with the Firebase CLI, run
  `firebase deploy --only firestore:indexes` — the definition is already in
  `firestore.indexes.json`.

## 6. Publish to GitHub Pages

In this repository on GitHub: **Settings → Pages**

- **Source:** Deploy from a branch
- **Branch:** `main`, folder `/ (root)`
- **Save**

A minute later the site is at `https://<your-username>.github.io/<repo-name>/`.
Everything in this app uses relative paths, so a project subpath works fine.

## 7. Authorize the Pages domain in Firebase

This is the step everyone forgets, and its symptom is a sign-in popup that opens
and immediately fails.

**Authentication → Settings → Authorized domains → Add domain**

Add `<your-username>.github.io` (just the host — no `https://`, no repo path).
`localhost` is already there, which is what makes local testing work.

## 8. Sign in

Open the site, sign in with Google. Your account is created on first sign-in and
you are dropped at the plan chooser: paste your own plan, or start from the
bundled bodyweight placeholder.

---

## Running it locally

Any static file server. Do **not** open `index.html` as a `file://` URL — ES
modules and `fetch` both refuse to work that way.

```
python3 -m http.server 8000
# then http://localhost:8000
```

`localhost` is pre-authorized in Firebase Auth, so sign-in works against the same
project. That means local testing writes to your real data — a second Firebase
project is worth it if you plan to experiment.

---

## Regenerating the food dataset

`data/common-foods.json` ships with a curated set of staples so search works
immediately. Regenerating it from the full USDA dataset is optional and occasional.

### One-time: get a key and store it

1. Get a free key at <https://fdc.nal.usda.gov/api-key-signup.html>. It arrives by
   email in a minute.
2. In this repository: **Settings → Secrets and variables → Actions → New
   repository secret**
   - **Name:** `USDA_API_KEY`
   - **Secret:** the key
3. Save.

That key is used by one GitHub Actions workflow and nothing else. It never reaches
the browser, it is never committed, and the script redacts it from any URL it
prints, so it cannot leak into a public job log.

### Whenever you want to refresh it

**Actions → Build food data → Run workflow → Run workflow.**

The job fetches USDA's Foundation Foods and SR Legacy datasets, writes
`data/common-foods.json`, and commits it. If the fetch fails or returns
implausibly few records, the job fails instead of committing a truncated file over
a good one. There is no schedule — this runs when you press the button.

The same script runs locally if you ever want it to:

```
USDA_API_KEY=your-key node tools/build-common-foods.js
```

---

## Cost

This app is built to sit inside Firebase's free (Spark) tier for a handful of
users: reads are fetched by date range rather than by collection, the food dataset
is a static file rather than a query, and there are no Cloud Functions.

**Check the current free-tier limits in the Firebase console** rather than trusting
a number written down here — Google changes them, and a stale figure in a README is
worse than no figure. The console shows your actual usage against the current
quotas under **Usage and billing**.

The one thing that would change this: adding live USDA lookup via a Cloud Function
(listed in `PROPOSALS.md`) requires the pay-as-you-go Blaze plan and therefore a
linked billing account, even though a substantial no-cost tier sits underneath it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "The Firebase config in firebase-config.js is not valid" | Step 2 not done, or a value mistyped. |
| Sign-in popup opens and closes immediately | Step 7 — the Pages domain is not in the authorized list. |
| "That sign-in method is not enabled" | Step 3 — the provider is off in the console. |
| "Missing or insufficient permissions" | Step 4 — rules not published, or published to a different project. |
| Progress screen errors, console mentions an index | Step 5 — click the link in the console error. |
| Everything loads but nothing saves | Check you are signed in; a signed-out session has nothing to write to. |
| Food search finds nothing from the common list | `data/common-foods.json` is missing or was not deployed. Your own foods still work. |
| Changes do not appear after a push | GitHub Pages caches. Hard-refresh, and give the deploy a minute. |

If sign-in works but data does not appear on another device, check you signed in
with the same provider. Google and email/password with the same address are two
different accounts as far as Firebase is concerned, and this app deliberately does
not link them.
