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
import { fileURLToPath } from 'node:url';

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
const MAX_RECORDS = 4000;

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
];

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

  // Deduplicate by name. SR Legacy and Foundation overlap on some staples; the
  // first one wins, and Foundation is listed first because its analyses are newer.
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = record.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }

  unique.sort((a, b) => a.name.localeCompare(b.name));
  const final = unique.slice(0, MAX_RECORDS);

  if (final.length < MIN_RECORDS) {
    fail(`Only ${final.length} usable records (minimum ${MIN_RECORDS}). Refusing to overwrite the existing dataset with a truncated one.`);
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  // No pretty-printing: this file is downloaded by phones on a gym connection.
  await writeFile(OUT_PATH, `${JSON.stringify(final)}\n`, 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(final));
  console.log(`\nWrote ${final.length} records to data/common-foods.json (${(bytes / 1024).toFixed(0)} KB).`);
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

function isExcluded(description) {
  if (!description) return true;
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(description));
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

main().catch((err) => fail(err.stack || err.message));
