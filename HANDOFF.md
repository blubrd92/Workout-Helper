# Handoff — open work on the food dataset and search

Everything else in this app is finished and working. This file is about one area:
the bundled food dataset and the search over it. Read it before touching either,
because this problem has produced four fixes that each broke something the
previous one got right.

**Start here:** `node tests/search-benchmark.mjs`. That is the yardstick. Do not
change ranking or dataset selection without running it before and after.

Current numbers, as of the last commit on `main`:

```
RANKING    top-1 25/27 (93%)   top-3 26/27 (96%)   loggable 21/27
COVERAGE   14/15 staples present
  missing: olive oil
```

For comparison, the same benchmark before the selection rewrite and the generator
run that followed it:

```
RANKING    top-1 24/27 (89%)   top-3 25/27 (93%)   loggable 21/27
COVERAGE   9/15 staples present
  missing: cheddar cheese, butter, olive oil, salt, honey, flour
```

One of the two top-1 points is a benchmark correction rather than a search
improvement, and should be read as such: the `oats` pattern required `Oats,` with
a comma, which scored Foundation's plainest possible record — described as exactly
`Oats` — as a miss. On the same dataset the uncorrected pattern reads 24/27. The
other point is real: `bread` now returns `Bread, wheat` instead of `Bread, potato`.

---

## The three open items

### 1. Coverage — done, with one food still missing

**Status: the selection is rewritten and the generator has been run. The dataset in
`data/common-foods.json` is the new one. Only olive oil is still missing, and why
is an open question — see the end of this item.**

What the real run produced, against the file it replaced:

| | before | after |
|---|---|---|
| coverage | 9/15 | **14/15** |
| distinct head nouns | 416 | **824** |
| largest single head noun | fish, 194 records | rice, 14 records |
| records carrying a cooking word | 84% | 38% |
| `with salt` / `without salt` records | 427 | 206 |
| file size | 256 KB | **241 KB** |
| top-1 / top-3 / loggable | 24 / 25 / 21 | 25 / 26 / 21 |

Loggable held rather than dropping the point the simulation predicted, and no
benchmark query is unsatisfiable. The file got smaller while nearly doubling the
number of foods in it, which is the result the per-head-noun quota was for.

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

#### The cap is gone, and it should never have been the size it was

`MAX_RECORDS` was 2,500 because "the file is 256 KB and fetched on a phone". That
measured the uncompressed size. Firebase Hosting serves JSON gzipped:

```
2,500 records ->  44 KB gzipped      ~11 bytes per additional record
~7,000 records ->  93 KB gzipped
```

The dataset is also loaded lazily — `js/foods.js` fetches it on the first food
search, not at startup — and searching 7,000 records takes 1.1 ms against the
~16 ms a keystroke can afford. The entire cost of shipping every generic USDA food
is about 50 KB, once, cached.

So the shortage that caused all of this was imaginary, and **the cap is now a
runaway guard at 20,000** rather than a curation decision. Relevance is still
enforced, just not by rationing: `EXCLUDE_PATTERNS` drops baby food, fast food,
brands and alcohol, and `collapseSaltVariants()` drops the duplicate half of a
with/without-salt pair. If you want those ~200 pairs back, that function is the
one place to change — they are identical in energy and protein, which is why they
go.

Measured on the reconstructed pool, uncapping did not degrade search the way it
might have: at 4,592 records instead of 2,500, coverage went 13/15 -> 14/15 and
loggable 21 -> 22, with no query becoming unsatisfiable. More records meant more
competitors for the ranker and it still came out ahead.

The selection code is unaffected by this. When the budget exceeds the pool,
`selectByHeadNoun()` simply returns everything, so the quota quietly becomes a
no-op rather than something that needs unwinding.

#### Still open: olive oil

It is the one coverage staple that did not come back, and **the cause is not
established**. What is known:

The `Oil` head noun shipped 12 records, one for each distinct second clause it
had — almond, canola, coconut, corn, flaxseed, industrial, oat, palm, safflower,
soybean, sunflower, vegetable. There is no olive branch among them, and nothing in
the file starts with `Olive` except olives and olive loaf. So either no olive oil
record reached selection at all, or it was branch 13 of 12 and lost the tie-break.

**The next generator run settles this without any further guessing.** With the cap
lifted, nothing is cut for want of room: if an olive oil record reaches selection
at all, it ships. So if olive oil appears, it was a tie-break loss and is now
fixed; if it is still missing, it is genuinely absent from Foundation and SR
Legacy or being dropped by a filter — and the candidate pool artifact that run
uploads will say which, in one grep. Note the reconstructed pool cannot answer
this: olive oil is an "O" name, so it is in neither of the two source files.

`isExcluded('Oil, olive, salad or cooking')` is false — there is a test asserting
it — so the exclusion filters are not the obvious culprit.
Within a head noun, branches are ordered by size, then by `byRank`: score,
preparation, a portion you can picture, then name length. Every oil scores 0 (none
carries a cooking word — note `EATEN_FORM` matches "cooked" but not the "cooking"
in "salad or cooking"), so olive oil would be settled by its portion label and its
name length against twelve near-identical competitors. That is a coin toss decided
by punctuation, which is the same complaint item 2 makes about milk and broccoli.

If it turns out the record is in the pool and simply lost, the honest fix is
probably a `SENTINELS` entry, and the standing advice against that has weakened
now that the structural problem is fixed: cheddar, butter, salt, honey and flour
all arrived without one, and a sentinel now reserves a single slot instead of the
511 the old `+10000` bonus took. **But keep the matcher loose and check it matches
something first** — a sentinel that matches nothing fails the whole run, and
`/olive oil/i` on its own is satisfied by "Mayonnaise, reduced fat, with olive
oil", which would pass the check while shipping no olive oil at all.

#### Re-running the generator

"Build food data" -> "Run workflow" from the Actions tab. It needs the
`USDA_API_KEY` repository secret (Settings -> Secrets and variables -> Actions;
free key at <https://fdc.nal.usda.gov/api-key-signup.html>), and fails immediately
with a named error if it is missing. The job benchmarks the dataset before and
after, runs the tests against the new data, and writes both sets of numbers, the
record and head-noun counts, and the gzipped size to the run summary — read that
rather than the log. It then commits the regenerated file to the branch it ran on.

It also uploads **`candidate-pool`**, an artifact holding every record that
survived filtering, with scores, before selection chose between them. Download it
from the run page when a food is missing and you need to know whether USDA ships
it at all. That pool used to be discarded at the end of every run, which is the
only reason questions like the olive oil one were ever hard to answer.

Watch `loggable` and `checkFeasible()`. A drop of more than a point, or any query
reported unsatisfiable, is worth investigating before the commit is kept.

### 2. Three ranking misses that are inherent ties

```
milk      -> Milk, sheep, fluid          (want cow's milk)
broccoli  -> Broccoli, chinese, cooked   (want plain broccoli)
```

Both are legitimate records tying at the same scoring tier, resolved by name
length. There is no structural signal in a USDA description that says "this is the
common one" — that is a curation question, not a ranking one. **Low value, high
risk of regression.** Consider leaving these alone.

`bread -> Bread, potato` used to be the third of these and is now fixed, though
not by anything done to the ranker: the new dataset simply contains `Bread, wheat`,
which it did not before. Worth knowing, because it suggests the remaining two are
also more likely to move from the dataset side than from `scoreMatch()`. Olive oil
in item 1 is the same tie in its unresolved form.

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
| `.github/workflows/build-food-data.yml` | Manual `workflow_dispatch`. Needs the `USDA_API_KEY` repo secret. Benchmarks the dataset before and after, runs the tests, and reports both to the run summary. |

Run everything: `npm test && node tests/search-benchmark.mjs && node tests/browser/smoke.mjs`

## One unrelated item still outstanding

`tests/rules/rules.test.mjs` — 25 assertions that Firestore security rules keep
accounts isolated. **Written but never executed**, because this environment has no
network to install the emulator. It needs the Firebase CLI and a JDK. See
`tests/README.md`. This is the only untested thing in the project that guards
something that matters.
