# Handoff — open work on the food dataset and search

Everything else in this app is finished and working. This file is about one area:
the bundled food dataset and the search over it. Read it before touching either,
because this problem has produced four fixes that each broke something the
previous one got right.

**Start here:** `node tests/search-benchmark.mjs`. That is the yardstick. Do not
change ranking or dataset selection without running it before and after.

Current numbers, as of the last commit on `main`:

```
RANKING    top-1 24/27 (89%)   top-3 25/27 (93%)   loggable 21/27
COVERAGE   9/15 staples present
  missing: cheddar cheese, butter, olive oil, salt, honey, flour
```

---

## The three open items

### 1. Coverage — the dataset is missing basic foods (highest value)

`data/common-foods.json` has 2,490 records and contains **no cheddar, no butter,
no olive oil, no salt, no honey, no flour**. It does contain 194 kinds of fish,
146 chicken, 132 beef, 132 pork and **101 veal**. Only **418 distinct head nouns**
across the whole file — 83% of the slots go to repeats of the same food.

The likely cause, diagnosed but **not yet confirmed**: in
`tools/build-common-foods.js`, `stapleScore()` awards +40 for containing a cooking
word (`cooked|roasted|boiled|...`) and +50 for Foundation data type, while every
other record scores roughly −1 (a small length penalty). So any record whose
description happens to say "cooked" outranks staples that never carry such a
word — butter, oils, cheeses, condiments, sweeteners, flours. With ~6,500
candidates competing for 2,500 slots, whole categories get squeezed out.

An agent was assigned to verify this and redesign the selection; it was killed by
a session limit before reporting. The hypothesis is unverified.

**A promising direction, not yet tested:** cap records per head noun. The failure
is not "the wrong records score highly", it is "one food eats 194 slots while
another gets zero". A per-head-noun quota would free a large number of slots for
breadth without raising `MAX_RECORDS` at all — which matters, because the file is
fetched on a phone (currently 256 KB).

**Do not** just add the missing foods to `SENTINELS` one at a time. That treats
the symptom, and the list is already carrying more than it should.

Verify with the `COVERAGE` half of the benchmark. Note you **cannot run the
generator** without network access and a `USDA_API_KEY`; you can only reason about
the scoring offline, using the shipped file as a sample of real USDA descriptions.

### 2. Three ranking misses that are inherent ties

```
milk      -> Milk, sheep, fluid          (want cow's milk)
broccoli  -> Broccoli, chinese, cooked   (want plain broccoli)
bread     -> Bread, potato               (want white/wheat bread)
```

All three are legitimate records tying at the same scoring tier, resolved by name
length. There is no structural signal in a USDA description that says "this is the
common one" — that is a curation question, not a ranking one. **Low value, high
risk of regression.** Consider leaving these alone.

### 3. A pending decision for the owner: two bundled files?

An agent evaluated shipping the 160 hand-curated staples (recoverable with
`git show e7edbfa:data/common-foods.json`) as a small file ranked *above* the USDA
set. Measured: **27/27 loggable versus 17/27** at the time, for 11 KB on top of
255 KB.

It recommended doing it, at ~70% confidence, and argued against itself well:

- The spec (`ledger-claude-code-prompt.md` §4) names **one** bundled file. This is
  a deviation that needs an explicit yes from the owner.
- It creates a permanent second source of truth that will disagree with the USDA
  layer in ways the user sees in one list — `Peanut butter, 188 kcal / 2 tbsp`
  next to `Peanut butter, creamy, 589 / 100 g`. Both correct, 3x apart.
- The project's standing rule is "implement exactly what is asked; propose the
  rest." This was not asked for.
- The heuristic path's ceiling was measured at 26/27 loggable — near parity — so
  this is a judgement call about maintenance burden, not a forced move.

Its condition for shipping: give each curated record an `fdc` id plus a test that
re-derives its values, converting a hand-maintained assertion into a checked one.

**Do not implement this without the owner saying yes.**

---

## What has already been tried, and failed

Read this before proposing a fix. Each of these looked obviously correct.

| Attempt | Result |
|---|---|
| Penalise records by comma count as "over-specific" | **Backwards.** USDA's canonical staples are the LONG names (`Chicken, broilers or fryers, breast, meat only, cooked, roasted`); short names belong to products. It cut the food and kept the snack. |
| Sort alphabetically, then apply the record cap | Kept A–I, silently dropped everything after. No rice, lentils, milk, salmon or yogurt. The job reported success. |
| Blanket "prefer cooked, penalise raw" everywhere | A wash. Fixed rice and lentils, broke broccoli and egg. |
| Match-position weighting in search | No measurable gain over the simpler rules. Dropped. |
| `/\bbaby food\b/` to exclude baby food | USDA writes it as one word, `Babyfood`. Matched none of 236. |
| `/\b[A-Z]{3,}\b/` to exclude shouted brands | Missed nine `McDONALD'S` records — the lowercase "c" kills the word boundary. |
| Sentinel `/^cereals?,? .*oats/` for rolled oats | Failed a good run. Foundation files it as `Oats, whole grain, rolled` with no `Cereals,` prefix. |
| `\begg\b` as a sentinel | Does not match `Eggs`. Plural breaks the boundary. |
| `skin` in the organ-meat demotion list | Demoted `Potatoes, baked, flesh and skin`. A baked potato is not offal. |

The pattern: **every one of these was a regex or heuristic that looked right and
was never measured against real data.** That is what the benchmark is for.

## Two traps specific to this problem

**Optimising top-1 can make results worse.** An oracle picking the shortest
name-acceptable record scores 27/27 on top-1 and only 15/27 on loggable — below
the real ranker. Name-match accuracy and log correctness pull against each other
here. Always report both.

**The benchmark can be biased without looking biased.** The first version used
USDA phrasing in its patterns, which made 11 of 27 queries unsatisfiable by any
plain-English record. It silently measured naming convention instead of answer
quality. `checkFeasible()` exists to catch that — run it whenever the dataset
changes.

## Where things live

| Path | What |
|---|---|
| `tests/search-benchmark.mjs` | The yardstick. Ranking, loggability, coverage. |
| `js/foods.js` | Search ranking — `scoreMatch()` is the whole thing. |
| `tools/build-common-foods.js` | The generator: exclusions, `stapleScore()`, `SENTINELS`, `pickPortion()`. |
| `tests/food-data.test.mjs` | 30 unit tests over both. Every one encodes a bug that actually shipped. |
| `.github/workflows/build-food-data.yml` | Manual `workflow_dispatch`. Needs the `USDA_API_KEY` repo secret. |

Run everything: `npm test && node tests/search-benchmark.mjs && node tests/browser/smoke.mjs`

## One unrelated item still outstanding

`tests/rules/rules.test.mjs` — 25 assertions that Firestore security rules keep
accounts isolated. **Written but never executed**, because this environment has no
network to install the emulator. It needs the Firebase CLI and a JDK. See
`tests/README.md`. This is the only untested thing in the project that guards
something that matters.
