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
export const MAX_RECORDS = 2500;

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

/** Does this description look like one of the staples above? */
function isSentinel(name) {
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
 * Brand names, which SR Legacy writes in capitals: "Beverages, drink mix, QUAKER
 * OATS, GATORADE, orange flavor". Three or more capitals in a row is a reliable
 * signal, and generic descriptions essentially never contain one.
 *
 * Packaged goods are explicitly out of scope for this app — they are faster typed
 * into your own library once than searched for repeatedly.
 */
const BRAND_PATTERN = /\b[A-Z]{3,}\b/;

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
export function finalize(records) {
  // Deduplicate by name. SR Legacy and Foundation overlap on some staples; the
  // higher-scoring record wins, which prefers the Foundation analysis.
  const byName = new Map();
  for (const record of records) {
    const key = record.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || record.score > existing.score) byName.set(key, record);
  }
  const unique = [...byName.values()];

  /*
    Applying the cap.

    This MUST happen before the alphabetical sort, and must drop the least useful
    records rather than the last ones by name. The first version sorted by name and
    then sliced, which quietly threw away everything after "I".

    The ranking is a staple heuristic: Foundation Foods are newer analyses and win
    over SR Legacy; then fewer commas, because USDA descriptions get more specific
    with each clause ("Beef, ground, 80% lean meat / 20% fat, patty, cooked,
    pan-broiled" is five clauses deep and nobody logs it by name); then shorter
    overall. It is crude, and it is meant to be adjusted.
  */
  const capped = [...unique].sort((a, b) => b.score - a.score).slice(0, MAX_RECORDS);

  // Sort for output only, once the cap has already been applied.
  const final = capped
    .map(({ score, ...record }) => record)   // drop the internal ranking score
    .sort((a, b) => a.name.localeCompare(b.name));

  if (final.length < MIN_RECORDS) {
    throw new Error(`Only ${final.length} usable records (minimum ${MIN_RECORDS}). Refusing to overwrite the existing dataset with a truncated one.`);
  }

  // The check that actually catches a bad run — see SENTINELS above.
  const missing = SENTINELS.filter(([, matcher]) => !final.some((r) => matcher.test(r.name)));
  if (missing.length) {
    throw new Error(
      `These staples are missing from the result: ${missing.map(([label]) => label).join(', ')}. `
      + 'That means the filtering or the record cap threw away something basic. '
      + 'Refusing to overwrite the existing dataset.',
    );
  }

  return final;
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
  if (BRAND_PATTERN.test(description)) return true;
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(description));
}

/**
 * How staple-looking a description is. Higher wins when the cap is applied.
 * See the note at the call site for why this exists.
 */
export function stapleScore(food, name) {
  let score = 0;
  /*
    A staple is never a candidate for the cap.

    Ranking alone is a heuristic, and a heuristic will eventually rank something
    basic below 2500 other things — "Cereals, oats, regular and quick, not
    fortified, dry" carries four commas and scores badly for it. Rather than hope
    the heuristic behaves, put anything matching a sentinel out of reach of the cut
    entirely. The check at the end then only has to catch filtering mistakes.
  */
  if (isSentinel(name)) score += 10000;
  if (food.dataType === 'Foundation') score += 50;      // newer, cleaner analyses
  score -= (name.match(/,/g) || []).length * 6;         // each clause is more specific
  score -= name.length / 12;                            // and shorter is more generic
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
  return String(description || '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '')
    .trim();
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

function pickPortion(food) {
  const portions = (food.foodPortions || [])
    .map((p) => {
      const grams = p.gramWeight;
      if (typeof grams !== 'number' || grams < 15 || grams > 500) return null;
      const amount = p.amount ?? 1;
      const unit = p.measureUnit?.name && p.measureUnit.name !== 'undetermined'
        ? p.measureUnit.name
        : (p.modifier || '');
      const label = `${trimNumber(amount)} ${unit}`.replace(/\s+/g, ' ').trim();
      if (!label || /^\d+$/.test(label)) return null;
      return { grams, label: `${label}${p.portionDescription && !unit ? ` ${p.portionDescription}` : ''}`.trim() };
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
