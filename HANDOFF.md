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

These are unchanged by the selection rewrite below, and will stay unchanged until
somebody runs the generator — see "what is still outstanding" in item 1.

---

## The three open items

### 1. Coverage — selection rewritten, awaiting a generator run

**Status: the generator is fixed and measured. The shipped data file is not, and
cannot be from here.**

#### What was actually wrong

The hypothesis in the previous handoff was right about the mechanism and wrong
about it being the only one. Four separate causes, all confirmed against real USDA
records recovered from git history (see "how to measure this offline" below):

1. **The cooking-word bonus selected for categories, not quality.** `stapleScore()`
   awards +40 for `cooked|roasted|boiled|...`, which is a word that simply never
   appears on butter, salt, honey, oil, flour or cheese. Confirmed: **84% of the
   shipped file contains a cooking word against 59% of the candidate pool**, and
   the A–H slice of the pool alone holds 1,813 records in that +40 tier — against
   1,989 non-sentinel slots for the entire alphabet. Whole categories could not
   place a single record. The cap was genuinely binding: the generated file was
   exactly 2,500 records (the 2,490 today is after `3c0b0f0` stripped ten brand
   records by hand).

2. **The brand filter was eating the plainest records in the set.** USDA appends
   `(Includes foods for USDA's Food Distribution Program)` to commodity staples —
   cheddar, whole eggs, raw apples, ground beef, pinto beans. `BRAND_PATTERN`
   is `/[A-Z]{3,}/`, and "USDA" is three capitals in a row. **This is why the file
   had 13 cheeses and no cheddar.** It is not a scoring problem and no amount of
   quota would have fixed it.

3. **`DERIVATIVE` was a ban, not a demotion.** −200 put a record below every
   possible competitor: **0% of the shipped 2,490 contain a derivative word**. The
   list includes `flour`, so wheat flour could never ship, whatever else changed.

4. **Two large sources of duplicate slots.** The `+10000` sentinel bonus made all
   511 sentinel matches immune to the cut (43 milks, 63 potatoes) to guarantee
   something that needed one record each; and 188 foods shipped twice as
   `…, with salt` and `…, without salt`, with identical energy and protein.

#### What changed

All of it in `tools/build-common-foods.js`; `js/foods.js` was not touched.

- `normalizeDescription()` strips the Food Distribution Program note before either
  the exclusion filter or the shipped name sees it. Genuine `USDA Commodity`
  entries are still excluded, now on the stripped name.
- Selection is a **quota, not a ranking**. `selectByHeadNoun()` gives every head
  noun its first record before any head noun gets its second. Within a head noun,
  `buildQueue()` takes turns at *every* clause depth — which matters because the
  distinguishing clause moves (species is second for `Fish, tuna, …`; the cut is
  third for `Chicken, broilers or fryers, thigh, …`).
- Branches are offered slots **biggest first**, which is the only commonness signal
  this data has: USDA analyses a food as many times as it matters, so tuna carries
  a dozen records and burbot carries one. Sorting them by score instead put the 43
  shortest-named fish in the file and no tuna at all.
- `BREADTH_EXPONENT` (0.5) controls how much a big branch outweighs a small one.
  0 gives every branch one turn per round, which sounds fair and is not — it puts
  `Chicken, skin` level with `Chicken, broilers or fryers`, the branch holding
  every cut anyone eats. 1 reproduces the old bias. **The value was swept, not
  guessed**: 0.5 is the lowest setting that reaches the best measured loggable.
- Sentinels now reserve **one** slot for the plain form of each staple, instead of
  lifting all 511 matches out of reach of the cut.
- `collapseSaltVariants()` drops the redundant half of a with/without-salt pair.
- **`stapleScore` is now a tier.** The old `score -= name.length / 40` was
  described as a mild tie-break; it meant two records of the same food never tied,
  so every finer comparison was unreachable and raw tuna beat cooked tuna by five
  characters of name. `byRank()` now breaks ties explicitly: cooked over raw, then
  a portion you can picture ("1 cup, chopped or diced" over "3 oz"), then length.
  The cooked-over-raw preference only ever compares records of the *same* food,
  which is what makes it survivable — as a blanket rule it has been tried and it
  broke broccoli and egg.

#### Measured

Old selection against new, same reconstructed pool, same 2,500 slots:

```
            coverage   head nouns   top-1   top-3   loggable   infeasible
OLD            8/15          391      23      24        22          1
NEW           13/15          559      24      26        21          0
```

Report both columns, as the file says. **Loggable is down one**, and the cause is
known: breadth admits `Tuna, ahi or yellowfin, frozen, wild caught`, whose only
portion is 100 g, and search ranks it above `Fish, tuna, skipjack, fresh, cooked,
dry heat` — which the new selection does ship, and which the old file also had.
That is a ranking tie, i.e. item 2 below, not a selection failure. Everything else
moved the right way, and the one query that no record could satisfy is now
satisfiable.

#### How to measure this offline

You cannot run the generator without network and a `USDA_API_KEY`, but you do not
have to reason from the shipped file alone. Two commits hold real USDA records
that never survived selection:

- `git show 37f2654:data/common-foods.json` — 4,000 records from the run with the
  alphabetical-slice bug. Because it kept the first 4,000 names in order, it is the
  **complete filtered candidate set for A–H**: 3,179 records, 326 head nouns, 960
  of them beef. This is where butter, honey and cheddar can be seen scoring −1
  against a cut line of 48.
- The shipped file is complete for every sentinel-matched head noun, since +10000
  made those immune to the cut.

Union the two, re-apply `isExcluded`, and you have a 4,562-record pool to run both
selections over. Be careful of two things: score the old arm with the old scoring
(the length penalty is gone from `stapleScore`, and reusing it flatters the
baseline), and remember the pool holds only what the old selection kept for
non-sentinel head nouns after H — which is why **olive oil and salt cannot be
recovered in simulation**. Both are their own head nouns and should appear in a
real run.

#### What is still outstanding

**The data file has not been regenerated, so the benchmark still reports 9/15.**
Run "Build food data" from the Actions tab (it needs the `USDA_API_KEY` repo
secret), then run `node tests/search-benchmark.mjs` and compare against the numbers
at the top of this file. Expect coverage to rise and `loggable` to move by roughly
±1; if `loggable` drops by more than that, or `checkFeasible()` starts reporting
unsatisfiable queries, the run is worth investigating rather than committing.

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
| Per-head-noun quota with a hard cap, then filling leftover slots by score | The fill handed the freed slots straight back to the biggest categories: fish went 195 → 191. Round-robin is fair at every depth on its own; the cap and the fill were both removed. |
| Giving every branch one turn per round (`BREADTH_EXPONENT` 0) | Levels `Chicken, skin` with `Chicken, broilers or fryers` — 21 junk sub-nouns starved the branch holding every cut anyone eats, and the thigh fell off the end. |
| Ordering branches by score so the "best" species go first | Every fish scores the same, so the tie-break was name length: the 43 shortest-named fish shipped and tuna did not. Branch size is the better signal. |

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
