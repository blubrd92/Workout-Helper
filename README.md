# Ledger

A personal strength training and nutrition tracker. Vanilla HTML, CSS, and
JavaScript; Firebase for accounts and storage; hosted as static files on GitHub
Pages.

**The log is the referee.** No ads, no analytics, no social features, no
notifications, no streaks. Accounts exist for exactly one reason: keeping each
person's data private to them.

New here? **[SETUP.md](SETUP.md)** stands the whole thing up in about twenty
minutes.

---

## What it does

- **Log a session** against a plan: per-set reps (or seconds), a *tank* value —
  reps left in the tank — and a free-text load. Left and right are logged
  separately on unilateral exercises, always.
- **Read it back** as a per-exercise progression table: every time you did a
  movement, newest first, with load and every set. This table is the point of the
  whole app.
- **Track nutrition** against daily calorie and protein targets, from your own
  food library, your saved meals, a bundled dataset of common foods, or by hand.
- **Track weight** as a weekly average, because the trend is the signal and a
  single day is noise.
- **Export a coach report**: a markdown summary of any date range, built to paste
  straight into a chat.

Plans arrive as markdown files — see **[PLAN_FORMAT.md](PLAN_FORMAT.md)**, which is
written so an AI coach can generate valid plans from the spec alone.

## Design rules

These are requirements, not preferences. They are why some obvious features are
missing.

**Mid-workout, one thumb, no signal.** The primary target is a phone browser at
390px. Every tap target is at least 44px. Typing is minimised: steppers, chips, and
tap-to-repeat instead of text fields wherever a value can be guessed or repeated.
Firestore's offline cache is enabled, and an in-progress session is mirrored to
`localStorage` on every change, so a locked screen or a dead connection in a gym
basement costs nothing.

**No moralising.** A planned day with no session renders exactly like any other
empty day — a dashed outline and nothing else. There are no streak counters, no
"days missed", no red anywhere in the adherence path, and no copy in the app that
comments on a gap. Going over a calorie target shows a number, not an alarm. The
program's slip protocol is "notice, shrug, resume", and the UI embodies it: it
shows what happened and never editorialises about what didn't. The coach report
follows the same rule.

**Nothing is assumed about you.** The bundled starter plan is equipment-free and
labelled a placeholder. The watch item — the thing you monitor across sessions — is
whatever you name it; no body part is hardcoded anywhere in this codebase.

**Every account is an island.** There is no sharing, no visibility between
accounts, and no rule in `firestore.rules` that would permit either.

## How it is built

No framework, no build step, no bundler, no CDN except one: the official Firebase
JS SDK, loaded as ES modules from Google's CDN with its version pinned in a single
constant in `js/firebase.js`. Everything else is static files served as-is.

```
index.html          shell: boot, sign-in, tab bar
styles.css          all styling; --house is the accent
firebase-config.js  your project's config (public by design — see SETUP.md)
firestore.rules     a user reads and writes only their own documents
js/
  app.js            boot, auth, hash router
  firebase.js       SDK loading, offline persistence
  store.js          every Firestore read and write
  plan-parser.js    plan markdown -> objects (pure, no DOM)
  migrations.js     schema version + migration scaffold
  sets.js           set entry shape and formatting
  foods.js          food search; lazy-loads the bundled dataset
  export.js         JSON backup and the coach report
  components.js     stepper, segmented, chips, sheet
  views/            one module per screen
plans/starter.md    the only bundled plan
data/common-foods.json  bundled USDA staples
tools/              dataset generator (Node; not part of the app)
tests/              see tests/README.md
```

### Data model

Everything lives under the signed-in user's uid.

| Path | Holds |
|---|---|
| `users/{uid}` | settings, `schemaVersion`, active plan pointer |
| `users/{uid}/plans/{id}` | parsed plan plus its raw markdown source |
| `users/{uid}/sessions/{id}` | one logged session |
| `users/{uid}/foods/{id}` | the personal food library |
| `users/{uid}/meals/{id}` | named bundles of foods, values copied in |
| `users/{uid}/nutrition/{date}` | one document per day: food entries **and that day's weight** |

Two decisions worth knowing:

- **Weight lives in the nutrition day document** rather than its own collection.
  It is entered on the same screen, on the same day, as food — one document means
  one read and one write. Each reading stores the unit it was recorded in, so
  switching the display unit never rescales history.
- **Logged data copies its values.** A session copies the plan's exercises; a food
  entry copies calories and protein; a meal copies its components. Editing a plan,
  a saved food, or a meal therefore never rewrites a day you already logged. This
  costs some duplication and buys a history that stays true.

Sessions also carry a denormalised `exerciseKeys` array so the progression view can
query by exercise instead of downloading history and filtering in the browser.

### Schema versioning

Each user document stores a `schemaVersion`. On sign-in the app runs any
migrations between that version and the current one (`js/migrations.js`). A gap —
a version bumped without a migration written — fails loudly rather than marking
unmigrated data as current.

## Tests

`npm test` runs the plan parser suite. `node tests/browser/smoke.mjs` drives the
whole app in a real browser with Firebase stubbed out. `tests/rules/` covers the
security rules against the Firestore emulator — **written but not yet executed**;
see [tests/README.md](tests/README.md) for the honest status of each suite and how
to run them.

## Data source

Bundled food data is derived from **USDA FoodData Central**, U.S. Department of
Agriculture, Agricultural Research Service. FoodData Central, <https://fdc.nal.usda.gov>.
It is in the public domain. Only four fields per food are kept — name, serving,
calories, protein — because the file is downloaded on a phone.

The dataset is read-only at runtime: saving a result to your library copies the
values, so regenerating the file never alters anyone's saved foods or logged days.

## What this deliberately does not do

No runtime nutrition API calls and no barcode scanning — a public static site
cannot hold a third-party key safely, and a live lookup is a failure mode when the
signal is bad. No branded, packaged, or restaurant food coverage; those are manual
entries, which is faster than searching for them anyway. No sharing between
accounts. No notifications, reminders, or streaks. No chart libraries.

Ideas that were considered and deliberately not built are listed in
**[PROPOSALS.md](PROPOSALS.md)**, with tradeoffs. Nothing there gets built without
being asked for.
