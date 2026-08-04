#!/usr/bin/env node
/**
 * Regenerate data/common-foods.json from USDA FoodData Central.
 *
 * This is a maintenance script, not part of the app. Nothing in the browser ever
 * runs it, and the app has no build step — this only rewrites a data file that is
 * then committed.
 *
 * Run it:
 *   USDA_API_KEY=xxxx node tools/build-common-foods.js
 * or, the usual path, from the repository's Actions tab:
 *   "Build food data" -> Run workflow
 *
 * The key is read from the environment in both cases, so CI and local runs are the
 * same code path. It is never a command-line argument (arguments show up in process
 * lists and shell history) and never printed.
 *
 * FoodData Central is a public-domain dataset from the USDA Agricultural Research
 * Service. See https://fdc.nal.usda.gov/
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, '..', 'data', 'common-foods.json');

const API = 'https://api.nal.usda.gov/fdc/v1';

/**
 * Which USDA datasets to pull.
 *
 * Foundation Foods and SR Legacy are the analysed, generic entries: "Chicken,
 * broilers or fryers, breast, meat only, cooked, roasted". That is what this app
 * wants — staples. The Branded set is ~1.5 million packaged products, which would
 * bloat the file into uselessness and is explicitly out of scope: packaged and
 * restaurant items are manual entries into the personal library, which is faster
 * than searching for them anyway.
 */
const DATA_TYPES = ['Foundation', 'SR Legacy'];

/** USDA nutrient ids. These are stable across the dataset. */
const NUTRIENT_ENERGY_KCAL = 1008;
const NUTRIENT_PROTEIN = 1003;
// Some Foundation foods report energy only as Atwater-calculated values.
const NUTRIENT_ENERGY_ATWATER_GENERAL = 2047;
const NUTRIENT_ENERGY_ATWATER_SPECIFIC = 2048;

/**
 * Safety rails. The job must fail loudly rather than commit a truncated or empty
 * dataset over a good one — a half-fetched file would silently break search for
 * every user and look like nothing happened.
 */
const MIN_RECORDS = 500;

/**
 * A runaway guard, NOT a curation knob. Read this before lowering it.
 *
 * This was 2,500, on the stated grounds that "the file is 256 KB and fetched on a
 * phone". That reasoning measured the wrong number. 256 KB is the uncompressed
 * size; Firebase Hosting serves JSON gzipped, and the wire cost is:
 *
 *     2,500 records ->  44 KB gzipped
 *     ~7,000 records ->  93 KB gzipped      (~11 bytes per extra record)
 *
 * On top of that the dataset is loaded LAZILY — js/foods.js fetches it on the
 * first food search, not at startup — and searching 7,000 records takes 1.1 ms
 * against a ~16 ms budget for a keystroke to feel instant. So the entire cost of
 * shipping every generic USDA food is about 50 KB, once, on a connection the user
 * has already spent more than that on the page itself.
 *
 * That 2,500 was the source of the whole selection problem: it forced a choice of
 * 2,500 out of ~7,000, and every rule for making that choice was wrong in a way
 * nobody noticed until something basic went missing. Deleting the shortage deletes
 * the problem. The number below exists only to stop a runaway — it matches the
 * 100-page ceiling in fetchAllSummaries() — so if a USDA API change ever starts
 * returning the 1.5-million-record Branded set, the job fails instead of
 * committing it.
 *
 * Relevance is still enforced, just not by a quota: EXCLUDE_PATTERNS drops baby
 * food, fast food, brands and alcohol, and collapseSaltVariants() drops the
 * duplicate half of a with/without-salt pair. Those decide what is worth shipping.
 * This decides nothing.
 */
export const MAX_RECORDS = 20000;

/**
 * Staples that must survive filtering, as [label, matcher] pairs.
 *
 * This is the real safety rail. The first run of this script produced a file that
 * passed every count check and was still useless: it sorted alphabetically before
 * applying the record cap, so it kept A through I and silently dropped lentils,
 * rice, milk, salmon, turkey and everything else past the cut. A count cannot
 * catch that. Asking "is chicken breast in here?" can.
 *
 * If you tighten the filters and a sentinel disappears, the job fails and tells
 * you which one. Add to this list freely — anything you would be annoyed to find
 * missing belongs here.
 *
 * Keep the matchers LOOSE. The first version asked for /^cereals?,? .*oats/ and
 * failed a perfectly good run, because USDA files rolled oats under Foundation as
 * "Oats, whole grain, rolled, old fashioned" with no "Cereals," prefix at all.
 * A sentinel is asking "is there something oat-like in here", not "does this exact
 * phrasing exist" — anchoring one to a spelling makes it a tripwire for USDA's
 * naming rather than for our own filtering.
 */
export const SENTINELS = [
  ['chicken breast', /chicken.*breast/i],
  ['egg', /\beggs?\b/i],   // \begg\b misses the plural; \begg alone matches eggplant
  ['oats', /\boat/i],
  ['white rice', /rice.*white|white rice/i],
  ['brown rice', /rice.*brown|brown rice/i],
  ['lentils', /lentil/i],
  ['milk', /\bmilk\b/i],
  ['salmon', /salmon/i],
  ['ground beef', /beef.*ground|ground beef/i],
  ['potato', /potato/i],
  ['broccoli', /broccoli/i],
  ['banana', /banana/i],
  ['peanut butter', /peanut butter/i],
  ['yogurt', /yogurt/i],
];

/**
 * Derivative and processed forms.
 *
 * These are the entries that crowded out the staples in the second run: searching
 * "chicken breast" returned breaded tenders and oven-roasted deli roll, and "rice"
 * returned crackers, bran and flour, because those have SHORTER names than the
 * canonical descriptions and the ranking rewarded brevity.
 *
 * They are demoted rather than excluded — oat bran and rice flour are real foods,
 * they just should not outrank rice and oats. With a cap in play, demotion usually
 * amounts to exclusion, which is the intent.
 */
const DERIVATIVE = /\b(breaded|batter|battered|nuggets?|patty|patties|rolls?|dried|dehydrated|powdered?|flour|bran|instant|imitation|substitute|candied|sweetened|crackers?|chips?|puffs?|sticks?|paste|extract|concentrate|infant)\b/i;

/**
 * Words that mark a description as a form you actually eat, which is what a food
 * log wants: "cooked, roasted" over "raw, unprepared" for meat, and plain "raw" for
 * produce.
 */
const EATEN_FORM = /\b(cooked|roasted|boiled|baked|grilled|braised|steamed|raw)\b/i;

/**
 * Does this description look like a PLAIN version of one of the staples above?
 *
 * The "plain" half matters. The second run passed this check while containing only
 * "Chicken breast tenders, breaded" and "Chicken breast, roll, oven-roasted" — the
 * sentinel matched, the file was still missing the food. Requiring a non-derivative
 * match is what makes the guard mean "the actual staple is in here".
 */
function isSentinel(name) {
  if (DERIVATIVE.test(name)) return false;
  return SENTINELS.some(([, matcher]) => matcher.test(name));
}

const PAGE_SIZE = 200;      // /foods/list maximum
const DETAIL_CHUNK = 20;    // /foods maximum ids per request
const MAX_RETRIES = 4;

/**
 * Descriptions to drop.
 *
 * The generic sets still contain plenty of entries nobody logs by hand: baby food,
 * fast-food chain items that slipped in as SR Legacy, restaurant dishes, and school
 * lunch program products. Adjust this list freely — it is the main knob for what
 * ends up in the file.
 */
const EXCLUDE_PATTERNS = [
  // USDA writes this as ONE word: "Babyfood, cereal, with egg yolks, junior".
  // The old /\bbaby food\b/ matched none of them and 236 got through.
  /babyfood/i,
  /\bbaby food\b/i,
  /\binfant formula\b/i,
  /^formulated bar/i,
  /\bfast foods?\b/i,
  /\brestaurant\b/i,
  /\bschool lunch\b/i,
  /\bmilitary\b/i,
  /\bUSDA Commodity\b/i,
  /\bpuerto rican\b/i,      /* regionally specific prepared dishes, not staples */
  /\bincluding USDA commodity\b/i,
  /\bunprepared\b/i,        /* dry mixes that are not eaten as-is */
  /^alcoholic beverage/i,   /* a calorie log does not need 69 kinds of liqueur */
  /\bdrink mix\b/i,
  /\bnutritional supplement\b/i,
  /\bmeal replacement\b/i,
];

/**
 * Brand names. Two mechanisms, because USDA writes them two ways.
 *
 * 1. SHOUTED: "Beverages, drink mix, QUAKER OATS, GATORADE, orange flavor".
 *    Note there is deliberately NO \b before the capitals run. The first version
 *    used /\b[A-Z]{3,}\b/ and let nine "McDONALD'S, ..." records through — the
 *    lowercase "c" in "Mc" means there is no word boundary in front of DONALD,
 *    and the trailing "'S" kills the one behind it. Anchoring the pattern to word
 *    boundaries was checking for a tidiness the data does not have.
 *
 * 2. TITLE CASE: "Oscar Mayer, Chicken Breast (honey glazed)" carries no capitals
 *    run at all, so no pattern over letter case will find it. A short explicit
 *    list is the honest mechanism for these; add to it when one gets through.
 *
 * Packaged and restaurant goods are a stated non-goal for this app — they are
 * faster typed into your own library once than searched for repeatedly.
 */
const BRAND_PATTERN = /[A-Z]{3,}/;

/**
 * A USDA bookkeeping note, not part of the food's name.
 *
 *   "Cheese, cheddar (Includes foods for USDA's Food Distribution Program)"
 *
 * This is appended to the plainest records in the set — cheddar, whole eggs, raw
 * apples, ground beef, pinto beans — because those are the foods the distribution
 * programme actually hands out. It is exactly the wrong thing to filter on, and
 * the brand pattern above ate every one of them: "USDA" is three capitals in a row.
 * That is why the dataset shipped 13 cheeses and no cheddar.
 *
 * Stripping the note before anything else looks at the description keeps the food
 * and drops the bookkeeping. Note this is NOT the same as the "USDA Commodity"
 * entries in EXCLUDE_PATTERNS — those are institutional pack sizes, and are still
 * excluded on the stripped name.
 */
const FDP_NOTE = /\s*\(Includes foods for USDA'?s Food Distribution Program\)/gi;

/**
 * Strip USDA's bookkeeping from a description before it is filtered or kept.
 *
 * Both isExcluded() and cleanName() run this, so the exclusion check and the name
 * that ships always see the same string. They did not before: the filter judged
 * the raw description and the record kept the cleaned one.
 */
export function normalizeDescription(description) {
  return String(description || '')
    .replace(FDP_NOTE, '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '')
    .trim();
}
const KNOWN_BRANDS = new RegExp([
  // Restaurant and fast food.
  'mcdonald', "wendy's", 'burger king', 'kentucky fried', 'pizza hut', 'taco bell',
  'subway', 'starbucks', "domino's",
  // Packaged goods.
  'oscar mayer', 'kraft', 'nestle', 'general mills', 'kellogg', 'quaker', 'gatorade',
  'hormel', 'tyson', "campbell's", 'hershey', 'nabisco',
  /*
    Added after 23 of these shipped at once. Uncapping the file did not create the
    hole — it just stopped rationing what fell through it, so one Archway cookie
    became seventeen. Every name here is title case with no capitals run, which is
    what makes BRAND_PATTERN useless against them.

    A rule was tried instead of a list and abandoned: "two title-case words in the
    head noun" reads as a brand and catches most of these, but USDA writes
    "Alaska Pollock", "Canada Goose", "Sweet Potatoes" and "Peanut Butter" the same
    way. That is the same lesson /\b[A-Z]{3,}\b/ taught — checking for a tidiness
    the data does not have. A list is honest about being a list.
  */
  'archway', 'pepperidge farm', 'pillsbury', 'glutino', "udi's", "rudi's", 'schar',
  "mary's gone crackers", 'martha white', 'mckee baking', 'little debbie',
  'mission foods', 'continental mills', 'krusteaz', 'interstate brands',
  'lean pockets', 'reddi wip', 'sage valley', "andrea's", 'goya', 'gamesa',
  'la moderna', 'la ricura', 'weight watcher', 'heinz', 'muscle milk',
]
  // Word-anchored, unlike BRAND_PATTERN above: these are ordinary lowercase words,
  // and an unanchored "goya" or "schar" would match inside an unrelated one.
  .map((brand) => `\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  .join('|'), 'i');

async function main() {
  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) {
    fail('USDA_API_KEY is not set. Provide it as an environment variable — never as an argument.');
  }

  console.log(`Fetching ${DATA_TYPES.join(' + ')} foods from FoodData Central…`);
  const summaries = await fetchAllSummaries(apiKey);
  console.log(`  ${summaries.length} foods listed.`);

  const kept = summaries.filter((food) => !isExcluded(food.description));
  console.log(`  ${kept.length} remain after filtering.`);

  console.log('Fetching details for portion sizes…');
  const details = await fetchDetails(kept.map((f) => f.fdcId), apiKey);
  console.log(`  ${details.length} detailed records.`);

  const records = [];
  for (const food of details) {
    const record = toRecord(food);
    if (record) records.push(record);
  }

  /*
    Optionally keep the candidate pool.

    Everything that does not make it into the file has, until now, existed only in
    memory for the length of this run and then been discarded. That is why
    diagnosing a missing food meant reconstructing a pool out of git history and
    reasoning around the gaps — and why "is olive oil absent from USDA, or did it
    lose a tie-break?" was unanswerable offline.

    Set POOL_OUT to write the pool as it stands before selection, scores included.
    The build workflow does this and keeps it as an artifact. It is a diagnostic,
    never the shipped file.
  */
  if (process.env.POOL_OUT) {
    await mkdir(dirname(process.env.POOL_OUT), { recursive: true });
    await writeFile(process.env.POOL_OUT, `${JSON.stringify(records)}\n`, 'utf8');
    console.log(`Wrote the ${records.length}-record candidate pool to ${process.env.POOL_OUT}.`);
  }

  const final = finalize(records);

  await mkdir(dirname(OUT_PATH), { recursive: true });
  // No pretty-printing: this file is downloaded by phones on a gym connection.
  await writeFile(OUT_PATH, `${JSON.stringify(final)}\n`, 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(final));
  console.log(`\nWrote ${final.length} records to data/common-foods.json (${(bytes / 1024).toFixed(0)} KB).`);
}

/**
 * Turn raw records into the final list, or throw explaining why not.
 *
 * Split out of main() so it can be tested without touching the network — the bug
 * that shipped a useless dataset lived entirely in here, and was invisible because
 * this logic only ever ran inside a live API call. tests/food-data.test.mjs covers
 * it now.
 */
export function finalize(records, { exponent = BREADTH_EXPONENT } = {}) {
  // Deduplicate by name. SR Legacy and Foundation overlap on some staples; the
  // higher-scoring record wins, which prefers the Foundation analysis.
  const byName = new Map();
  for (const record of records) {
    const key = record.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || record.score > existing.score) byName.set(key, record);
  }
  const unique = collapseSaltVariants([...byName.values()]);

  /*
    Applying the cap.

    This MUST happen before the alphabetical sort, and must drop the least useful
    records rather than the last ones by name. The first version sorted by name and
    then sliced, which quietly threw away everything after "I".

    The version after that sorted by stapleScore and sliced, which is the failure
    this code replaces. Sorting globally by score does not choose the best records,
    it chooses the best-SCORING CATEGORIES: +40 for a cooking word is unreachable
    for foods nobody cooks, so 84% of the file came to be things described as
    cooked, roasted or raw, and butter, salt, honey, oil and flour — which are
    never any of those — could not place a single record. 194 kinds of fish and
    101 kinds of veal shared out the slots instead.

    Selection is now a quota, not a ranking: every head noun gets its first record
    before any head noun gets its second. Score still decides WHICH record
    represents a food, and in what order the foods are offered slots, but it can no
    longer decide whether a whole food appears at all.
  */
  const reserved = reserveSentinels(unique);
  const rest = unique.filter((record) => !reserved.has(record));
  const capped = [...reserved, ...selectByHeadNoun(rest, MAX_RECORDS - reserved.size, exponent)];

  // Sort for output only, once the cap has already been applied.
  const final = capped
    .map(({ score, ...record }) => record)   // drop the internal ranking score
    .sort((a, b) => a.name.localeCompare(b.name));

  if (final.length < MIN_RECORDS) {
    throw new Error(`Only ${final.length} usable records (minimum ${MIN_RECORDS}). Refusing to overwrite the existing dataset with a truncated one.`);
  }

  // The check that actually catches a bad run — see SENTINELS above.
  const missing = SENTINELS.filter(([, matcher]) =>
    !final.some((r) => matcher.test(r.name) && !DERIVATIVE.test(r.name)));
  if (missing.length) {
    throw new Error(
      `No plain version of these staples made it into the result: ${missing.map(([label]) => label).join(', ')}. `
      + 'Processed variants do not count — a file with breaded chicken tenders but no chicken breast '
      + 'is the failure this check exists for. Refusing to overwrite the existing dataset.',
    );
  }

  return final;
}

// ---------------------------------------------------------------- selection

/**
 * The food a description is about: everything before the first comma.
 *
 * USDA descriptions are written head noun first — "Beef, ground, 85% lean meat /
 * 15% fat, raw" — so this is the one piece of structure the format reliably has.
 * It is not always a single food ("Fish" covers 234 records), which is what
 * buildQueue()'s per-clause round-robin inside a group is for.
 */
function headNoun(name) {
  return String(name).split(',')[0].trim().toLowerCase();
}

/**
 * Order a group of records so that taking the first N of them gets you N
 * different foods, as far as the descriptions allow.
 *
 * USDA nests its descriptions: "Chicken, broilers or fryers, thigh, meat only,
 * cooked, stewed" is chicken -> broilers or fryers -> thigh -> ... Which clause
 * carries the distinction is not fixed. For fish it is the second (the species);
 * for chicken the second clause is a bird-size qualifier and the CUT — the part a
 * person searches for — is the third.
 *
 * So this takes turns at every depth rather than guessing which one matters.
 * Splitting only on the second clause put four kinds of chicken breast and the
 * chicken skin ahead of the thigh, and spent the whole "Fish" allowance before
 * reaching tuna. Both showed up as a loggable regression in the benchmark.
 */
function buildQueue(records, exponent, depth = 1) {
  if (records.length <= 1) return [...records];

  const maxClauses = Math.max(...records.map((r) => r.name.split(',').length));
  if (depth >= maxClauses) return [...records].sort(byRank);

  const groups = new Map();
  for (const record of records) {
    const key = (record.name.split(',')[depth] || '').trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  // Nothing to tell them apart at this depth — try the next clause along.
  if (groups.size === 1) return buildQueue(records, exponent, depth + 1);

  /*
    Branches are offered slots BIGGEST FIRST, which is the only commonness signal
    this data has.

    Sorting them by score put the 43 shortest-named fish in the file and no tuna
    at all: every species scores the same, so the tie-break — name length — was
    picking which fish a person can log. USDA analyses a food as many times as it
    matters, so "tuna" carries a dozen records (fresh, canned, skipjack,
    yellowfin) where "burbot" carries one. Counting them is not a judgement about
    which fish is more common, it is reading the one USDA already made.
  */
  const lists = [...groups.values()]
    .map((group) => buildQueue(group, exponent, depth + 1))
    .sort((a, b) => b.length - a.length || byRank(a[0], b[0]));

  /*
    The first record taken from a branch is its best one, not the head of its
    biggest sub-branch. Those are different things: "tuna" has more raw fresh
    records than cooked ones, so size ordering alone spent tuna's single slot on
    "Fish, tuna, fresh, bluefin, raw". Breadth decides which foods appear; quality
    decides which record speaks for one.
  */
  const queue = interleave(lists, exponent);
  const best = queue.reduce((a, b) => (byRank(a, b) <= 0 ? a : b));
  return [best, ...queue.filter((record) => record !== best)];
}

/**
 * Take turns between lists, giving bigger ones proportionally more turns —
 * but sublinearly, which is the whole point.
 *
 * At BREADTH_EXPONENT 1 a list gets turns in proportion to its size: that is the
 * old behaviour, where beef's 960 records buried everything else. At 0 every list
 * gets exactly one turn each round regardless of size, which sounds fair and is
 * not: it puts "Chicken, skin" and "Chicken, capons, giblets" on equal footing
 * with "Chicken, broilers or fryers", the branch holding every cut anyone eats,
 * and the thigh falls off the end.
 *
 * In between, a branch with 100 records gets more turns than one with 4, without
 * getting 25 times as many. The value is measured, not assumed — see the sweep in
 * the commit that introduced it.
 */
export const BREADTH_EXPONENT = 0.5;

function interleave(lists, exponent) {
  const weights = lists.map((list) => list.length ** exponent || 1);
  const taken = lists.map(() => 0);
  const total = lists.reduce((n, list) => n + list.length, 0);
  const out = [];

  while (out.length < total) {
    // The list furthest behind its share goes next. Lists arrive sorted best
    // first, so an exact tie resolves to the better-scoring branch.
    let pick = -1;
    let lowest = Infinity;
    for (let i = 0; i < lists.length; i++) {
      if (taken[i] >= lists[i].length) continue;
      const share = taken[i] / weights[i];
      if (share < lowest - 1e-9) { lowest = share; pick = i; }
    }
    if (pick < 0) break;
    out.push(lists[pick][taken[pick]++]);
  }
  return out;
}

/**
 * Which of two records should represent a food. Best first.
 *
 * The preparation step is narrower than it looks, and deliberately so. Preferring
 * cooked forms as a blanket rule has been tried and was a wash — it fixed rice and
 * lentils and broke broccoli and egg. This comparison only ever runs BETWEEN
 * RECORDS OF THE SAME FOOD: buildQueue() has already split by every clause the
 * descriptions share, so the choice is "raw tuna or cooked tuna", never "cooked
 * broccoli or raw apple". stapleScore's EATEN_FORM rates the two identically, so
 * without this the tie fell to the shorter name, which is how the file came to
 * represent tuna with "Fish, tuna, fresh, bluefin, raw".
 */
const COOKED_FORM = /\b(cooked|roasted|boiled|baked|grilled|braised|steamed)\b/i;
const RAW_FORM = /\braw\b/i;

function preparation(record) {
  if (COOKED_FORM.test(record.name)) return 1;
  if (RAW_FORM.test(record.name)) return -1;
  return 0;
}

/**
 * A portion someone can picture without a scale.
 *
 * Deliberately narrower than HOUSEHOLD_UNITS, which pickPortion uses to choose a
 * label at all: ounces and grams are legitimate labels and nobody can eyeball
 * them. When two records describe the same food this decides which one ships, so
 * "1 cup, chopped or diced" beats "3 oz" for the same stewed chicken thigh.
 */
const PICTUREABLE = /\b(cup|tbsp|tablespoon|tsp|teaspoon|slice|piece|fillet|breast|thigh|link|patty|medium|large|small|clove|stick|packet|bar|egg)\b/i;

function byRank(a, b) {
  return b.score - a.score
    || preparation(b) - preparation(a)
    || (PICTUREABLE.test(b.serving || '') ? 1 : 0) - (PICTUREABLE.test(a.serving || '') ? 1 : 0)
    || a.name.length - b.name.length
    || a.name.localeCompare(b.name);
}

/**
 * USDA ships most prepared vegetables, grains and legumes twice — once "with
 * salt" and once "without salt" — with identical energy and protein. 427 of the
 * 2,490 shipped records were one half of such a pair, 188 of them both halves:
 * 188 slots spent to say the same thing twice, in a file that had no room for
 * butter.
 *
 * Only records that are otherwise identical collapse. "Potatoes, baked, flesh and
 * skin, with salt" and "...without salt" are the same food; "Beans, snap, canned,
 * with salt" and "Beans, snap, raw" are not, and both survive.
 */
const SALT_VARIANT = /,\s*(with|without)\s+salt\b/i;

export function collapseSaltVariants(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.name.replace(SALT_VARIANT, '').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    // Keep the plain one where there is a choice: a name that never mentions salt
    // reads better in a log than either half of the pair.
    const plain = group.filter((r) => !SALT_VARIANT.test(r.name));
    out.push((plain.length ? plain : group).sort(byRank)[0]);
  }
  return out;
}

/**
 * One guaranteed slot per sentinel, for the plain form of that staple.
 *
 * The old mechanism gave every sentinel match +10000, which lifted it out of reach
 * of the cap. That worked, and it cost 511 of 2,500 slots: /\bmilk\b/ protected 43
 * milk records, /potato/ 63. The guarantee only ever needed to be "a plain milk is
 * in the file" — the rest of the milks can queue for a slot like everything else.
 */
function reserveSentinels(records) {
  const reserved = new Set();
  for (const [, matcher] of SENTINELS) {
    const best = records
      .filter((r) => matcher.test(r.name) && !DERIVATIVE.test(r.name))
      .sort(byRank)[0];
    if (best) reserved.add(best);
  }
  return reserved;
}

/**
 * Fill the remaining slots by taking turns between head nouns.
 *
 * Pass 1 gives every head noun its best record, pass 2 its second, and so on. A
 * food with 960 candidate records and a food with one are therefore equally
 * certain to appear — which is the entire point, because the missing staples were
 * never outscored by a better butter, they were outnumbered by beef.
 *
 * Within a head noun, buildQueue() takes turns at every clause depth, so "Fish"
 * spends its slots on salmon, cod and tuna rather than on four cuts of the same
 * salmon.
 *
 * Groups are offered slots best-scoring first, so when the budget runs out
 * mid-pass it is the least staple-looking foods that miss out.
 */
export function selectByHeadNoun(records, budget, exponent = BREADTH_EXPONENT) {
  if (budget <= 0) return [];

  const heads = new Map();
  for (const record of records) {
    const head = headNoun(record.name);
    if (!heads.has(head)) heads.set(head, []);
    heads.get(head).push(record);
  }

  // Flatten each head noun into the order it would like its slots used.
  const queues = [...heads.values()].map((group) => buildQueue(group, exponent));
  queues.sort((a, b) => byRank(a[0], b[0]));

  const out = [];
  for (let pass = 0; out.length < budget; pass++) {
    let progressed = false;
    for (const queue of queues) {
      if (out.length >= budget) break;
      if (pass < queue.length) { out.push(queue[pass]); progressed = true; }
    }
    if (!progressed) break;   // every head noun is exhausted; the pool was small
  }
  return out;
}

// ---------------------------------------------------------------- fetching

async function fetchAllSummaries(apiKey) {
  const all = [];
  let pageNumber = 1;

  for (;;) {
    const page = await request(`${API}/foods/list?api_key=${apiKey}`, {
      method: 'POST',
      body: {
        dataType: DATA_TYPES,
        pageSize: PAGE_SIZE,
        pageNumber,
        sortBy: 'fdcId',
        sortOrder: 'asc',
      },
    });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    process.stdout.write(`\r  page ${pageNumber} (${all.length} so far)`);
    if (page.length < PAGE_SIZE) break;
    pageNumber++;
    // The generic datasets are ~9k foods; this guard stops a runaway loop if the
    // API ever stops honouring pageNumber.
    if (pageNumber > 100) break;
  }
  process.stdout.write('\n');
  return all;
}

async function fetchDetails(ids, apiKey) {
  const out = [];
  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) {
    const chunk = ids.slice(i, i + DETAIL_CHUNK);
    const batch = await request(`${API}/foods?api_key=${apiKey}`, {
      method: 'POST',
      body: { fdcIds: chunk, format: 'full' },
    });
    if (Array.isArray(batch)) out.push(...batch);
    process.stdout.write(`\r  ${out.length}/${ids.length}`);
  }
  process.stdout.write('\n');
  return out;
}

/**
 * Fetch with retries on transient failures.
 * The URL contains the API key, so error messages print the URL with the key
 * redacted — a stack trace in a public CI log must not leak it.
 */
async function request(url, { method = 'GET', body = null } = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: res.status === 403 || res.status === 401 });
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.fatal) break;
      // 1s, 2s, 4s, 8s. The USDA key is rate limited per hour; backing off is
      // cheaper than failing a 150-request job on one blip.
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  fail(`Request failed: ${redact(url)} — ${lastError?.message}`);
}

function redact(url) {
  return String(url).replace(/api_key=[^&]+/, 'api_key=REDACTED');
}

// ---------------------------------------------------------------- shaping

export function isExcluded(description) {
  if (!description) return true;
  const name = normalizeDescription(description);
  if (!name) return true;
  if (BRAND_PATTERN.test(name) || KNOWN_BRANDS.test(name)) return true;
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * How staple-looking a description is. Higher wins when the cap is applied.
 * See the note at the call site for why this exists.
 */
export function stapleScore(food, name) {
  let score = 0;
  /*
    A staple sorts first among its own kind.

    This used to read "a staple is never a candidate for the cap" — the bonus was
    large enough to lift all 511 sentinel matches out of reach of the cut, which
    spent a fifth of the file on 43 milks and 63 potatoes. The guarantee now lives
    in reserveSentinels(), which holds one slot for the plain form of each staple;
    what the bonus does here is make sure that reserved slot goes to the staple
    itself rather than to a variant of it.
  */
  if (isSentinel(name)) score += 10000;
  if (food.dataType === 'Foundation') score += 50;      // newer, cleaner analyses

  /*
    NOTE: an earlier version subtracted 6 points per comma, on the theory that
    USDA descriptions get more specific with each clause. That is true and it was
    exactly backwards. The canonical staples are the LONG ones — "Chicken,
    broilers or fryers, breast, meat only, cooked, roasted" is five clauses — while
    "Chicken breast, roll" and "Rice crackers" are short because they are products.
    Penalising commas cut the food and kept the snack.
  */
  if (EATEN_FORM.test(name)) score += 40;
  if (DERIVATIVE.test(name)) score -= 200;

  /*
    NOTE: this used to end with `score -= name.length / 40`, described as a mild
    tie-break. It was neither mild nor a tie-break: it meant two records of the
    same food never tied, so every later comparison in byRank() — cooked over raw,
    a portion you can picture over "3 oz" — was unreachable, and the file
    represented chicken thigh and tuna with their RAW forms because those names are
    a few characters shorter. Score is a tier now. byRank() breaks the ties, and
    breaks them on name length last, which is what this was trying to do.
  */
  return score;
}

/**
 * Turn a USDA food into the four fields this app uses, and nothing else.
 *
 * The file must stay small: every extra field is multiplied by a few thousand
 * records and downloaded on a phone. Vitamin content, fdcIds, and food categories
 * are all things Ledger never displays, so they are dropped here rather than
 * shipped and ignored.
 */
function toRecord(food) {
  const per100g = {
    kcal: nutrientValue(food, [NUTRIENT_ENERGY_KCAL, NUTRIENT_ENERGY_ATWATER_SPECIFIC, NUTRIENT_ENERGY_ATWATER_GENERAL]),
    protein: nutrientValue(food, [NUTRIENT_PROTEIN]),
  };

  // A food with no energy value is unusable for a calorie log. Protein legitimately
  // reads 0 (oil, sugar), so only energy disqualifies a record.
  if (per100g.kcal === null) return null;

  const name = cleanName(food.description);
  if (!name) return null;

  const portion = pickPortion(food);
  const grams = portion ? portion.grams : 100;
  const scale = grams / 100;

  return {
    name,
    serving: portion ? portion.label : '100 g',
    kcal: round(per100g.kcal * scale, 0),
    protein: round((per100g.protein ?? 0) * scale, 1),
    // Used only to rank records when the cap is applied; stripped before writing.
    score: stapleScore(food, name),
  };
}

function nutrientValue(food, ids) {
  for (const id of ids) {
    const match = (food.foodNutrients || []).find((n) => (n.nutrient?.id ?? n.nutrientId) === id);
    const value = match?.amount ?? match?.value;
    if (typeof value === 'number') return value;
  }
  return null;
}

/**
 * USDA descriptions are written for a database, not for a phone screen:
 * "Chicken, broilers or fryers, breast, meat only, cooked, roasted".
 *
 * Reordering that into natural English is guesswork that goes wrong more often than
 * it goes right, so the description is kept as-is apart from tidying whitespace and
 * trailing commas. Substring search finds "chicken breast" in it either way, which
 * is what actually matters.
 */
function cleanName(description) {
  return normalizeDescription(description);
}

/**
 * Choose a human-readable portion.
 *
 * Preference order:
 *   1. A household measure — cup, piece, slice, tbsp, egg, fillet.
 *   2. Any listed portion whose gram weight is a sane single serving (15–500 g).
 *   3. Nothing, in which case the record is reported per 100 g.
 *
 * Rationale: "1 cup, cooked" is a portion someone can picture; "1 serving" is not,
 * and a 2 g portion of spices is worse than useless in a calorie log. The 15–500 g
 * band is a judgement call — widen it if too many staples fall back to 100 g.
 */
const HOUSEHOLD_UNITS = /\b(cup|tbsp|tablespoon|tsp|teaspoon|slice|piece|egg|fillet|breast|medium|large|small|link|patty|oz)\b/i;

/**
 * Portion labels that tell a person nothing.
 *
 * "1 RACC" is USDA's Reference Amount Customarily Consumed — a regulatory unit,
 * not something you can picture. 197 records shipped with it. "1 serving" and
 * "1 portion" are no better. Falling back to "100 g" is honest; printing an
 * acronym is not.
 */
const MEANINGLESS_UNITS = /^(racc|servings?|portions?|quantity not specified|undetermined|unit)$/i;

export function pickPortion(food) {
  const portions = (food.foodPortions || [])
    .map((p) => {
      const grams = p.gramWeight;
      if (typeof grams !== 'number' || grams < 15 || grams > 500) return null;

      // USDA sometimes reports amount 0, which produced labels like
      // "0 breast, bone removed". Treat a missing or zero amount as one.
      const amount = Number(p.amount) > 0 ? Number(p.amount) : 1;

      const rawUnit = p.measureUnit?.name && p.measureUnit.name !== 'undetermined'
        ? p.measureUnit.name
        : (p.modifier || '');
      const unit = String(rawUnit).trim();
      if (!unit || MEANINGLESS_UNITS.test(unit)) return null;

      const label = `${trimNumber(amount)} ${unit}`.replace(/\s+/g, ' ').trim();
      if (!label || /^[\d.]+$/.test(label)) return null;
      return { grams, label };
    })
    .filter(Boolean);

  if (!portions.length) return null;
  const household = portions.find((p) => HOUSEHOLD_UNITS.test(p.label));
  return household || portions[0];
}

function trimNumber(n) {
  return String(Number(Number(n).toFixed(2)));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

// Run only when executed directly; importing this file (as the tests do) must not
// kick off a fetch.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => fail(err.stack || err.message));
}
