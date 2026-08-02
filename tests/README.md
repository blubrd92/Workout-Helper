# Tests

Four suites, none of which needs a Firebase project. Run them from the repo root.

| Suite | Command | Needs |
|---|---|---|
| Plan parser | `npm test` | Node only |
| Food dataset generator | `npm test` | Node only |
| Browser smoke test | `node tests/browser/smoke.mjs` | a global Playwright install |
| Security rules | see below | Firebase CLI + a JDK |

`npm test` runs the two Node suites.

---

## 1. Plan parser — `npm test`

22 dependency-free tests over `js/plan-parser.js`: the bundled starter plan,
markdown round-tripping, and the exact line number reported for each class of
parse error. Also runs in a browser at `tests/index.html` (through a local
server, not `file://`).

**Status: passing.**

## 2. Food dataset generator — `node tests/food-data.test.mjs`

12 tests over the filtering and selection logic in
`tools/build-common-foods.js`. No network — they run against the pure functions.

These exist because of a specific failure. The generator ran cleanly, reported
success, committed 4,000 records, and produced a file containing no rice,
lentils, milk, salmon or yogurt: it sorted alphabetically and *then* applied the
record cap, keeping A–I and dropping the rest. Nothing failed, because nothing
checked what was in the file — only how much.

So the suite covers what the counting rails could not: that exclusions catch what
they claim to (`Babyfood` is one word in USDA data, and the original pattern
matched none of them), and that staples survive when the candidate list exceeds
the cap. The generator itself now carries a sentinel list — if chicken breast or
lentils are missing from a result, the job fails and names what went missing.

**Status: passing.**

## 3. Browser smoke test — `node tests/browser/smoke.mjs`

Drives the real app in Chromium at a 390px viewport, with Firebase's CDN modules
swapped for the in-memory stubs in `tests/browser/firebase-stub/`. It walks the
app the way a person would — adopt a plan, log a session, reload mid-session,
finish, read it back in history and on the progression table, log food, search the
bundled dataset, record a weight, generate a coach report — and fails on:

- any console error or uncaught exception
- any stray `null` / `undefined` / `NaN` rendered as visible text
- horizontal overflow at 390px
- any tap target under 44px

Add `--shots` to write screenshots to `tests/browser/screens/` (gitignored).

Playwright is not a project dependency — this app has none. Install it globally
(`npm i -g playwright`) or the runner skips with a message.

The stubs are a test double, not an emulator. They do not enforce security rules,
so this suite says nothing about whether `firestore.rules` is correct. That is
what suite 3 is for.

**Status: passing (55 checks).**

## 4. Security rules — `tests/rules/rules.test.mjs`

```
npm install --no-save @firebase/rules-unit-testing
npx firebase emulators:exec --only firestore "node tests/rules/rules.test.mjs"
```

Requires the Firebase CLI (`npm i -g firebase-tools`) and a JDK, which the
Firestore emulator needs.

25 assertions against `firestore.rules`: every operation the app performs on its
own data must succeed, and every attempt to touch another account's documents —
read, write, delete, or list — must fail, signed in as someone else or signed out
entirely.

**Status: written but NOT executed.** The environment this project was built in
had no network access to install the emulator or the test package. Run this once
before trusting the rules with real data. If an assertion fails, the rules are
wrong and the test is right.
