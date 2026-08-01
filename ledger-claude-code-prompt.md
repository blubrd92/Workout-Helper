# Claude Code Prompt: "Ledger" — Personal Training & Nutrition Tracker

Copy everything below this line into Claude Code as the opening prompt.

---

## Project overview

Build **Ledger**, a personal strength training and nutrition tracker for a small circle of users: the owner, plus any friends he invites to sign up. It exists to support a specific coaching program, and its design philosophy comes from that program: **the log is the referee.** No ads, no analytics, no social feeds, ever. Accounts exist for exactly one reason: keeping each person's data private to them.

The user (Javi) trains three days a week on a full-body program and tracks nutrition against daily calorie and protein targets. His coach is an AI he consults in chat: the coach reads exported logs and issues updated training plans as markdown files, which this app must ingest. The app is the system of record; the coach is the reader and writer of plans. Other users operate the same way with their own plans and their own data; there is no data sharing or visibility between accounts in v1.

Primary use case: **a phone browser, mid-workout, with one available thumb.** Desktop is secondary.

## Hard constraints

- **Vanilla HTML, CSS, and JavaScript only.** No frameworks, no build step, no bundler, no external CDNs or fonts, with one exception: the official Firebase JS SDK, loaded as ES modules from Google's CDN. Everything else must work as static files. (A Node script exists in `tools/` for regenerating the bundled food dataset, but it is a local developer utility, not part of the app's build or runtime.)
- **No third-party API keys in shipped code.** The Firebase web config is public by design and belongs in the client; that is expected, not a leak. Any other service key, such as the USDA key used to generate the food dataset, lives only as a CI secret, is read from an environment variable at generation time, and must never appear in a committed file, a job log, or the browser.
- **Hostable on GitHub Pages** (static site, relative paths).
- **Mobile-first.** Tap targets minimum 44px. Minimize typing: use steppers, chips, and tap-to-repeat over free text wherever sensible. Number inputs must raise numeric keyboards (`inputmode`).
- **Backend: Firebase.** Firebase Authentication for accounts and Cloud Firestore for all data. Every document lives under the signed-in user's uid (`users/{uid}/...`), and Firestore security rules must enforce that a user can read and write only their own documents. Include the rules file in the repo.
- **Offline-first logging.** Enable Firestore's offline persistence so a session can be logged with no signal (gym basement, garage) and sync when the connection returns. Mid-workout logging must never depend on connectivity.
- **Schema versioning.** Store a schema version on user data and include a small migration scaffold so future changes upgrade old data instead of breaking it.
- **Accent color:** define `const HOUSE = '#d4d9e4';` as a named constant and use it as the accent color throughout. This is the user's established house color.
- **Code must be readable and commented** for a maintainer who is proficient with vanilla JS but not an expert. Explain non-obvious decisions in comments. Prefer clarity over cleverness.
- **No moralizing UI.** See the adherence rules below; this is a design requirement, not a tone suggestion.

## Features (build all of these)

### 0. Accounts

- Sign in with Google (primary path) and email/password (fallback). Signed-out visitors see a minimal landing screen with sign-in only; no marketing copy.
- Sign out from Settings.
- Delete-my-account in Settings: double-confirmed, removes the auth user and all of their Firestore data.
- New accounts choose a starting point: paste or upload their own plan, or start from the bundled **minimal bodyweight starter plan** (see below). The app ships no assumptions about a user's equipment, training history, or body.

### 1. Plans

- The app parses workout plan files in the markdown format specified below.
- Ship `plans/starter.md` in the repo: a deliberately minimal, equipment-free bodyweight plan (see the seed plan section below). It is the only plan the app bundles, offered to new accounts as an editable starting point and clearly labeled as a placeholder meant to be replaced.
- Personal plans, including the owner's, are pasted or uploaded like any other user's. The app has no privileged plan.
- Plans have a name and an effective date. Keep prior plans in storage; each logged session records which plan version it was logged under.
- **Plan updates:** a Settings screen with (a) a textarea to paste new plan markdown and (b) a file input accepting `.md`. Validate the format, show parse errors clearly, and on success activate the new plan.
- Document the final plan format in a `PLAN_FORMAT.md` file in the repo so the coach can generate valid plan files. If you refine the format beyond the spec below, keep it human-writable and human-readable, and update `PLAN_FORMAT.md` to match.

### 2. Today / session logging

- Pick a session from the active plan (e.g. Gym, Home A, Home B — whatever the plan defines).
- Each exercise renders as a card with:
  - Load field, prefilled from the plan (free text, because loads include plate combos like "KB 20 (handle + 6s)" and surfaces like "chair height"), editable.
  - Per-set entry: reps (or seconds, for timed exercises) plus a **tank** value (reps left: 0, 1, 2, 3, 4+).
  - For exercises flagged per-side: separate Left and Right entries per set. Left and right are always logged separately.
  - Cues from the plan shown small; video link from the plan opens in a new tab.
  - A checkmark that marks the exercise complete.
- Session metadata: date (defaults to today, editable), sleep hours, an optional **watch item** status, and one optional one-line note.
- **Watch item:** a user-named thing they are monitoring across sessions (e.g. "knee", "shoulder", "sleep quality"), logged per session on a green / yellow / red selector. The label is set in Settings and the whole field can be turned off. Do not hardcode any body part. The progression views should be able to show watch-item status alongside session history so a trend is visible.
- **Fallback toggle:** a "short day" switch that marks the session as the 20-minute fallback version. Fallback sessions save, render, and count exactly like full sessions. No reduced-credit styling.
- Finishing a session saves it to history. Support editing a saved session afterward (typos happen mid-workout).

### 3. History and adherence

- Reverse-chronological list of sessions; tap for full detail.
- Month calendar view: completed sessions show a filled dot; planned training days (default Monday / Wednesday / Friday, configurable in Settings) are indicated.
- **Adherence rules (non-negotiable design requirement):** a planned day with no session renders neutrally — same visual weight as any other empty day. No red, no streak counters, no "X days missed," no guilt copy anywhere in the app. The program's slip protocol is "notice, shrug, resume," and the UI must embody it. Show what happened; never editorialize about what didn't.
- **Per-exercise progression view:** pick an exercise, see a table newest-first of date, load, per-set reps and tank (L/R shown separately where applicable). This table is the point of the whole app; make it clean.

### 4. Nutrition

- Daily food log: entries of label, calories, protein grams, logged against a date.
- **User-owned food library.** Each user builds their own list of saved foods: name, calories, protein, optional serving label (e.g. "1 bottle", "6 oz", "1 cup cooked"). Saving is one tap from a logged entry ("save this to my foods"), and logging from the library is one tap back. Library items are editable and deletable.
- **Saved meals.** A user can bundle several library foods into a named meal (e.g. "usual breakfast", "post-workout") that logs all of its components in one tap. Meals are editable; editing a meal does not retroactively alter already-logged days.
- Quick-add surface on the day view, ordered by most recently used, so repeat foods and meals never require typing.
- **Bundled common-foods dataset.** Ship `data/common-foods.json` in the repo: a few thousand common whole and staple foods derived from USDA FoodData Central, which is public domain. Each record carries only what this app uses: `name`, `serving` (a human-readable portion string), `kcal`, `protein`. Nothing else; the file must stay small.
  - Users search this dataset from the food-entry screen. Selecting a result logs it and offers to save it to their personal library. The personal library always ranks above the bundled dataset in search results, because a user's own entries are the faster and more accurate path.
  - **Load it lazily.** Fetch the JSON only the first time a user searches the common dataset in a session, never on app boot. Mid-workout and mid-meal logging must not wait on it. Once loaded, keep it in memory and let the browser cache handle repeat visits.
  - Search is client-side substring matching on `name`, case-insensitive. No search library, no server call, no index. If results exceed a sane cap, show the top matches and let the user type more.
  - The dataset is read-only and never written to. Saving a result to the personal library **copies the values**; later edits to the library never touch the bundled file, and regenerating the bundled file never alters anyone's saved foods or logged days.
- **Dataset generation, as a GitHub Action.** Write `tools/build-common-foods.js`, a standalone Node script (not part of the shipped app) that regenerates `data/common-foods.json` from USDA FoodData Central, and wire it to a workflow at `.github/workflows/build-food-data.yml`.
  - The workflow uses a `workflow_dispatch` trigger so it is run manually from the repository's Actions tab. No schedule; this is an occasional maintenance task, not a cron job.
  - The USDA API key is read from a repository secret (e.g. `USDA_API_KEY`) and exposed to the script as an environment variable. It must never be a workflow input, never appear in a committed file, and never be echoed into the job log.
  - The job runs the script, then commits the regenerated `data/common-foods.json` back to the default branch with a plain commit message. Grant the workflow only `contents: write`.
  - The script must run identically outside CI, reading the same environment variable, so it can be run locally if ever needed. CI is the default path, not the only one.
  - Include the filtering and portion-normalizing logic in the script with comments explaining the choices, since the owner will need to adjust it. Prefer USDA's Foundation Foods and SR Legacy data types over the branded set; the goal is staples (chicken breast, oats, eggs, rice, lentils) rather than packaged-goods coverage.
  - If the script fails or returns an implausibly small result set, the job must fail loudly rather than committing a truncated or empty dataset over a good one.
- Credit USDA FoodData Central as the data source in the README, with the standard citation.
- Day view shows totals against targets with remaining amounts. Targets default to **2,300 kcal and 150 g protein**, editable in Settings.
- Going over target renders neutrally (a number, not an alarm). Same philosophy as adherence.
- **Weight tracking:** quick daily entry; the app computes and displays weekly averages, and the weekly-average trend is the primary display. Individual daily weights are visible but de-emphasized. (Program rule: the trend is the signal, daily readings are noise.)

### 5. Settings

- Edit calorie/protein targets and planned training days.
- Plan paste/upload (see Plans).
- **Export:** (a) full JSON backup of all data as a downloaded file; (b) **coach report** — a formatted markdown summary of a selected date range (sessions with all sets, loads, tank values, knee statuses, notes, plus nutrition daily totals and weekly weight averages) designed to be pasted into a chat with the coach. Copy-to-clipboard button and file download for both.
- **Import:** restore a JSON backup into the signed-in account, with a confirmation step.
- Wipe all data, double-confirmed.

## Plan markdown format

Requirements: human-writable, human-readable, parseable with straightforward vanilla JS (no markdown library). Use the structure below; refine only if needed, and document the final format in `PLAN_FORMAT.md`.

```markdown
# Plan: Example Plan (format illustration only, not bundled)
Effective: 2026-07-20
Notes: Weeks 1-2 are deliberately easy: 2 sets per exercise, stop with 3-4 reps in the tank.

## Session: Home A
- name: Goblit Squat
  load: KB 20 (handle + 6s)
  sets: 2
  target: 8-12 reps
  rest: 120
  cues: heels down, chest proud, sit between hips, knees over toes
  video: https://www.youtube.com/watch?v=sFvas9RkSlc
- name: Kettlebell RDL
  load: KB 31 (handle + 6s + 5.5s)
  sets: 2
  target: 5-8 reps, knees-only depth, 3s down
  rest: 120
  cues: hips back, bell grazes thighs, back long, hamstrings end the rep
  video: https://www.youtube.com/watch?v=Uc5rP5xs7qQ
```

Field rules:
- `name`, `sets`, `target`, `rest` (seconds) are required. `load`, `cues`, `video` optional.
- `per_side: true` marks unilateral exercises (rows, one-arm presses, kickstand RDLs).
- `type: seconds` marks timed exercises (dead hangs); default type is reps.
- `target` is free text (rep ranges, depth notes, tempo notes all live there).

## Data model guidance

Keep it simple, per-user, and versioned. Suggested Firestore layout (adjust as needed):

- `users/{uid}/meta` — settings (targets, planned days), schema version
- `users/{uid}/plans/{planId}` — parsed plan plus its raw markdown source
- `users/{uid}/sessions/{sessionId}` — logged sessions (date, planId, sessionName, fallback flag, sleep, knee, note, exercises with per-set entries)
- `users/{uid}/foods/{foodId}` — the user's saved food library (name, calories, protein, serving label, lastUsed)
- `users/{uid}/meals/{mealId}` — named bundles referencing food entries by value (copy the numbers in, so editing a meal never rewrites history)
- `users/{uid}/nutrition/{date}` — one document per day of food entries and weight; entries store their own calories and protein rather than referencing the library, so library edits never alter logged days
- `users/{uid}/weights/{date}` — dated weight entries (or fold into the nutrition day doc; your call, document it)

Keep reads lean: fetch by date range (a month of sessions, a day of nutrition), never whole collections. This app should sit comfortably inside Firebase's free tier for a handful of users; have `SETUP.md` tell the owner to confirm current free-tier limits in the Firebase console rather than assuming them.

## Non-goals (do not build)

- No runtime nutrition API calls and no barcode scanning. Food data comes from the user's own library, the bundled dataset, or manual entry. (Rationale: a public static site cannot hold a third-party key safely, live lookups are a mid-workout failure mode when signal is poor, and the point of the bundled file is that search works offline like everything else.)
- No coverage of branded, packaged, or restaurant items. Those are manual entries into the personal library, which is faster than searching for them anyway. Do not attempt to fill this gap.
- No data sharing or visibility between accounts in v1; every account is an island.
- No notifications, reminders, or streaks.
- No charts libraries; if visualization beyond tables is wanted later it will be hand-rolled SVG, but that is an optional extra, not v1.

## Optional extras — propose, do not build

After delivering v1, list these (and anything else you think earns its place) with one-line tradeoffs, and **wait for explicit approval before implementing any of them.** This is a standing rule for this user: implement exactly what is asked; propose the rest.

1. Rest timer buttons on exercise cards (90s / 120s presets with a visible countdown).
2. PWA manifest + service worker for add-to-home-screen and full offline behavior.
3. Hand-rolled inline SVG sparklines on the progression view and weight trend.
4. Dark mode via `prefers-color-scheme`.
5. Plan sharing: export a plan as a link or short code that another user can import as a template into their own account.
6. Live USDA FoodData Central search via a Firebase Cloud Function proxy, for branded and packaged items the bundled dataset deliberately omits. The function holds the USDA key in its environment config so it never reaches the browser. State the tradeoffs plainly if proposing it: Cloud Functions require the Blaze pay-as-you-go plan and therefore a linked billing account, though a substantial no-cost tier sits underneath it; and live lookup introduces a network dependency the rest of the app does not have, so it must degrade gracefully to the offline path rather than blocking food entry.

## Firebase setup

Scaffold `firebase-config.js` with clearly marked placeholder values, and write a `SETUP.md` walking the owner through the console steps: create the Firebase project, enable the Google and email/password sign-in providers, create the Firestore database, deploy or paste the security rules from the repo, and add the GitHub Pages domain to Auth's authorized domains. The owner has stood up Firebase-backed static sites before; write the steps plainly anyway.

`SETUP.md` should also cover regenerating the food dataset: obtaining a free USDA FoodData Central API key, storing it as the `USDA_API_KEY` repository secret in GitHub, and running the "build food data" workflow from the Actions tab. Note that the key is used only by that workflow, never reaches the browser, and is never committed. Mention the local fallback (same script, same environment variable) in one line, but write the instructions assuming the owner will use the Actions button and will not have looked at this project in a year.

## Process

- Work iteratively with small, coherent commits.
- Test the plan parser against the seed plan below before building UI on top of it.
- Test the security rules: one account must never be able to read or write another account's documents.
- Verify the layout at a 390px viewport width; that is the primary target.
- If anything in this spec conflicts, mobile usability wins, then data integrity, then everything else.

## Seed plan (ship as `plans/starter.md`)

This is the only plan the app bundles. It is deliberately minimal: no equipment, no assumed history, no assumed body. Its job is to be a valid, parseable example that a new user can log against on day one and then replace. Label it in the UI as a starting point, not a recommendation.

```markdown
# Plan: Starter (Bodyweight)
Effective: 2026-07-25
Notes: A minimal placeholder so a new account has something to log against. Replace it with your own plan. Two sets per exercise, stopping a few reps short of failure, is a reasonable way to begin anything.

## Session: Full Body A
- name: Bodyweight Squat
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: heels down, chest up, sit back
- name: Hip Hinge
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: push the hips back, keep the back long, stand up by squeezing the glutes
- name: Push-Up
  load: floor or elevated (counter, chair, stairs)
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: body in one line, elbows about 45 degrees, chest leads
- name: Row
  load: table edge, suspension strap, or any weight you have
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: shoulder blade back and down first, then pull
- name: Overhead Press
  load: any weight you have, or a wall slide if you have none
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: ribs down, press up and slightly back
- name: Dead Hang or Doorframe Pull
  load: bodyweight
  sets: 2
  target: max hold
  rest: 90
  type: seconds
  cues: grip hard, shoulders set, breathe
- name: Dead Bug
  sets: 2
  target: 8-10 per side, slow
  rest: 60
  per_side: true
  cues: low back stays pressed down, exhale on the extend

## Session: Full Body B
- name: Tempo Bodyweight Squat
  sets: 2
  target: 8-10 reps, 3s down, 1s pause
  rest: 90
  cues: own the pause, no bouncing
- name: Single-Leg Hinge (Kickstand)
  sets: 2
  target: 8-10 reps
  rest: 90
  per_side: true
  cues: back toes level with front heel, weight on the front leg
- name: Push-Up
  load: floor or elevated
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: body in one line, chest leads
- name: Row
  load: table edge, suspension strap, or any weight you have
  sets: 2
  target: 8-12 reps
  rest: 90
  per_side: true
  cues: pull to the hip, not the armpit
- name: Overhead Press
  load: any weight you have
  sets: 2
  target: 8-12 reps
  rest: 90
  per_side: true
  cues: ribs down, bicep to the ear at the top
- name: Dead Hang
  load: bodyweight
  sets: 2
  target: max hold
  rest: 90
  type: seconds
  cues: shoulders set, legs quiet
- name: Side Plank
  sets: 2
  target: max hold per side
  rest: 60
  per_side: true
  type: seconds
  cues: stack the shoulder over the elbow, hips up
```
