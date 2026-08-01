# Browser smoke test

```
node tests/browser/smoke.mjs            # headless
node tests/browser/smoke.mjs --shots    # also write screenshots to screens/
```

## What this is

`smoke.mjs` serves the repo, opens it in Chromium at 390px wide, and intercepts
every request to `https://www.gstatic.com/firebasejs/**` — serving the modules in
`firebase-stub/` instead of the real SDK. The app is otherwise completely
unmodified: same `index.html`, same modules, same code paths.

That means the whole app is runnable and testable **without a Firebase project**,
which is the point. It also means a contributor can verify a change without
touching anyone's real data.

## The stubs

| File | Stands in for | Behaviour |
|---|---|---|
| `firebase-app.js` | `firebase-app.js` | returns an app object |
| `firebase-auth.js` | `firebase-auth.js` | reports a signed-in test user immediately |
| `firebase-firestore.js` | `firebase-firestore.js` | an in-memory Firestore, mirrored to `sessionStorage` so a page reload keeps its data |

The Firestore stub implements exactly the surface `js/store.js` uses, and only the
query operators this app issues: `>=`, `<=`, `==`, `array-contains`, `orderBy`,
`limit`. An unimplemented operator throws rather than silently returning
everything — if a new query needs a new operator, this test tells you.

## What it does not prove

**The stubs do not enforce security rules.** Nothing in this suite says anything
about whether `firestore.rules` is correct; the stub happily lets the test user
read anything. Rules are covered by `tests/rules/`, against the real Firestore
emulator.

It also does not exercise real offline behaviour, real auth providers, or
Firestore's actual index requirements — the progression query works here without
the composite index that production needs.

## Adding a check

Checks are plain assertions inside `run()`:

```js
step('A description of the group');
await check('what should be true', async () => somePredicate);
```

Return `false` or throw to fail. Throwing is better when you can put the actual
value in the message.

Playwright is not a project dependency — this app has none. The runner looks for a
global install (`npm i -g playwright`) and exits cleanly with a message if it is
not there, so this never blocks anyone.
