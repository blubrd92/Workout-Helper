/**
 * Food search benchmark.
 *
 *   node tests/search-benchmark.mjs
 *
 * Not a pass/fail test — a MEASUREMENT. Food search quality is a judgement call
 * over 2500 database-style records, and judgement calls get argued about unless
 * somebody writes down a yardstick. This is the yardstick. Change the ranking in
 * js/foods.js, run this, and see whether you helped.
 *
 * It exists because of a specific pattern of failure. Search ranking was "fixed"
 * four separate times by eye, and each fix broke something the previous one had
 * got right: penalising long names cut the real foods and kept the snacks;
 * preferring cooked forms fixed rice and broke broccoli. Every one of those looked
 * obviously correct while being written.
 *
 * THREE THINGS ARE MEASURED, and they do not move together:
 *
 *   top-1 / top-3   Is an acceptable record the first (or in the first three)
 *                   result? Acceptable means the plain food, not a product made
 *                   from it and not an unusual varietal.
 *
 *   loggable        Could you log the top result without being wrong by 2-3x?
 *                   Fails on a raw/dry form of something eaten cooked (dry rice is
 *                   ~3x the calorie density of cooked) and on a portion nobody can
 *                   estimate ("1 skin", "1 cup, pureed"). This is the column that
 *                   matters most and the one an eyeball review never catches.
 *
 *   coverage        Does the DATASET contain these staples at all? No amount of
 *                   ranking work finds a record that was never shipped, and the
 *                   generator has twice shipped a file with no butter in it.
 *
 * Optimising one of these can hurt another. An oracle picking the shortest
 * name-acceptable record scores 27/27 on top-1 and only 15/27 on loggable — worse
 * than the real ranker. Report all three or you will tune yourself backwards.
 *
 * The patterns are naming-agnostic on purpose: they accept USDA phrasing
 * ("Chicken, broilers or fryers, breast...") and plain-English phrasing
 * ("Chicken breast, skinless, roasted") equally, so the benchmark measures answer
 * quality rather than which file the answer came from. If you swap the dataset,
 * check `checkFeasible()` first — a query no record can satisfy is a broken
 * benchmark, not a failing ranker.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchLibrary } from '../js/foods.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Applied to every query: a product made from the food is never the food. */
const PRODUCT = /\b(sliced|deli|luncheon|nuggets?|breaded|batter|patt(y|ies)|cakes?|crackers?|chips?|snacks?|juice|nog|imitation|substitute|flavou?red|sweetened|candied|powdered?|extract|paste|concentrate|pancakes?)\b|applesauce/i;

/** [query, acceptable, additionally-rejected] */
export const BENCHMARK = [
  ['chicken breast', /chicken.*breast|^chicken breast/i, /fat-free|rotisserie/i],
  ['chicken thigh',  /chicken.*thigh/i, null],
  ['rice',           /^Rice, (white|brown|black|red|wild)/i, null],
  ['brown rice',     /^Rice, brown/i, null],
  ['egg',            /^Eggs?,? ?(whole|scrambled|boiled|fried|poached|raw|large|cooked|$)/i, /yolk|white|beater|substitute/i],
  ['milk',           /^Milk,? (whole|reduced fat|lowfat|low.fat|nonfat|skim|2%|1%|fluid)/i, null],
  ['oats',           /^(Oats,|Cereals, oats)/i, null],
  ['yogurt',         /^Yogurt,/i, null],
  ['lentils',        /^Lentils,? (mature seeds, )?cooked/i, null],
  ['black beans',    /^(Beans, black|Black beans)/i, null],
  ['salmon',         /^(Fish, salmon|Salmon,)/i, null],
  ['tuna',           /^(Fish, tuna|Tuna,)/i, null],
  ['ground beef',    /^(Beef,.*\bground\b|Ground beef)/i, null],
  ['potato',         /^Potatoe?s?,/i, null],
  ['sweet potato',   /^Sweet potatoe?s?,/i, null],
  ['broccoli',       /^Broccoli,? (raw|cooked)/i, null],
  ['spinach',        /^Spinach,/i, null],
  ['banana',         /^Bananas?(,|$)/i, null],
  ['apple',          /^Apples?(,|$)/i, null],
  ['peanut butter',  /^Peanut butter/i, null],
  ['almonds',        /^(Nuts, almonds|Almonds)/i, null],
  ['bread',          /^Bread, (white|whole|wheat|italian|french)/i, null],
  ['pasta',          /^(Pasta,|Spaghetti,|Macaroni,)/i, null],
  ['cottage cheese', /^(Cheese, cottage|Cottage cheese)/i, null],
  ['avocado',        /^Avocados?(,|$)/i, null],
  ['orange',         /^Oranges?(,|$)/i, null],
  ['carrot',         /^Carrots?(,|$)/i, null],
];

/**
 * Staples the dataset must CONTAIN, regardless of ranking.
 * A separate failure with a separate fix: this one lives in
 * tools/build-common-foods.js, not in search.
 */
export const COVERAGE = [
  ['cheddar cheese',     /^(Cheese, cheddar|Cheddar)/i],
  ['butter',             /^Butter(,|$)/i],
  ['olive oil',          /^(Oil, olive|Olive oil)/i],
  ['whole milk',         /^Milk, whole/i],
  ['white bread',        /^Bread, white/i],
  ['pasta',              /^(Pasta,|Spaghetti,|Macaroni,)/i],
  ['sugar',              /^Sugars?,/i],
  ['salt',               /^Salt(,|$)/i],
  ['onion',              /^Onions?(,|$)/i],
  ['garlic',             /^Garlic/i],
  ['tomato',             /^Tomatoe?s?(,|$)/i],
  ['cheese, mozzarella', /mozzarella/i],
  ['coffee',             /^(Beverages, coffee|Coffee)/i],
  ['honey',              /^Honey/i],
  ['flour, wheat',       /^(Wheat flour|Flour,)/i],
];

/** Foods that are inedible, or nutritionally unrecognisable, uncooked. */
const COOKED_REQUIRED = new Set(['chicken breast', 'chicken thigh', 'rice', 'brown rice',
  'lentils', 'black beans', 'ground beef', 'pasta', 'potato', 'sweet potato']);
const UNPREPARED = /\b(raw|dry|uncooked|unprepared|frozen)\b/i;
const ESTIMABLE = /\b(cup|tbsp|tablespoon|tsp|teaspoon|slices?|medium|large|small|piece|egg|can|bottle|scoop|fillet|clove|stick|packet|bar|breast|thigh|links?|patty)\b/i;

export function acceptable(name, accept, reject) {
  if (!name) return false;
  if (!accept.test(name)) return false;
  if (PRODUCT.test(name)) return false;
  if (reject && reject.test(name)) return false;
  return true;
}

function loggable(query, record) {
  if (!record) return false;
  if (COOKED_REQUIRED.has(query) && UNPREPARED.test(record.name)) return false;
  return ESTIMABLE.test(record.serving || '');
}

/** `search(query) -> ranked [{ name, serving }]`. */
export function score(search) {
  let top1 = 0; let top3 = 0; let logged = 0;
  const misses = [];
  for (const [query, accept, reject] of BENCHMARK) {
    const results = search(query) || [];
    const names = results.slice(0, 3).map((r) => r.name);
    if (acceptable(names[0], accept, reject)) top1++;
    else misses.push({ query, got: names[0] || '(nothing)' });
    if (names.some((n) => acceptable(n, accept, reject))) top3++;
    if (loggable(query, results[0])) logged++;
  }
  return { top1, top3, logged, total: BENCHMARK.length, misses };
}

export function coverage(foods) {
  const missing = COVERAGE.filter(([, re]) => !foods.some((f) => re.test(f.name))).map(([l]) => l);
  return { present: COVERAGE.length - missing.length, total: COVERAGE.length, missing };
}

/** A query no record can satisfy means the benchmark is broken, not the ranker. */
export function checkFeasible(foods) {
  return BENCHMARK
    .filter(([, accept, reject]) => !foods.some((f) => acceptable(f.name, accept, reject)))
    .map(([query]) => query);
}

// ---------------------------------------------------------------- runner

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const foods = JSON.parse(await readFile(join(HERE, '..', 'data', 'common-foods.json'), 'utf8'));

  const impossible = checkFeasible(foods);
  if (impossible.length) {
    console.log(`WARNING — no record can satisfy: ${impossible.join(', ')}`);
    console.log('Fix the dataset or the patterns before trusting the score below.\n');
  }

  const r = score((q) => searchLibrary(q, foods));
  const c = coverage(foods);

  console.log(`RANKING    top-1 ${r.top1}/${r.total} (${Math.round(r.top1 / r.total * 100)}%)`
    + `   top-3 ${r.top3}/${r.total} (${Math.round(r.top3 / r.total * 100)}%)`
    + `   loggable ${r.logged}/${r.total}`);
  console.log(`COVERAGE   ${c.present}/${c.total} staples present`);
  if (c.missing.length) console.log(`  missing: ${c.missing.join(', ')}`);
  if (r.misses.length) {
    console.log('\nranking misses:');
    for (const m of r.misses) console.log(`  ${m.query.padEnd(16)}got: ${m.got}`);
  }
}
