/**
 * Tests for the food dataset generator's filtering and selection logic.
 *
 *   node tests/food-data.test.mjs
 *
 * These exist because of a specific failure: the generator ran cleanly, reported
 * success, committed 4,000 records, and produced a file with no rice, lentils,
 * milk, salmon or yogurt in it. It had sorted alphabetically and then applied the
 * record cap, keeping A–I and dropping the rest. Nothing in the job failed,
 * because nothing checked what was in the file — only how much.
 *
 * No network: these run against the pure functions, which is exactly where the bug
 * lived.
 */

import { finalize, isExcluded, stapleScore, pickPortion, MAX_RECORDS } from '../tools/build-common-foods.js';
import { searchLibrary } from '../js/foods.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
}

const ok = (cond, what) => { if (!cond) throw new Error(what || 'expected truthy'); };
const throws = (fn, pattern, what) => {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  if (!error) throw new Error(`${what || 'expected a throw'} — nothing was thrown`);
  if (pattern && !pattern.test(error.message)) {
    throw new Error(`message did not match ${pattern}: ${error.message}`);
  }
};

// A record as toRecord() produces it.
const rec = (name, score = 0) => ({ name, serving: '100 g', kcal: 100, protein: 10, score });

/** The staples the sentinel list insists on, as records. */
const staples = () => [
  rec('Chicken, broilers or fryers, breast, meat only, cooked, roasted'),
  rec('Eggs, whole, raw, fresh'),
  rec('Cereals, oats, regular and quick, not fortified, dry'),
  rec('Rice, white, long-grain, regular, cooked'),
  rec('Rice, brown, long-grain, cooked'),
  rec('Lentils, mature seeds, cooked, boiled'),
  rec('Milk, whole, 3.25% milkfat'),
  rec('Fish, salmon, Atlantic, farmed, cooked'),
  rec('Beef, ground, 90% lean meat, cooked'),
  rec('Potatoes, baked, flesh and skin'),
  rec('Broccoli, cooked, boiled, drained'),
  rec('Bananas, raw'),
  rec('Peanut butter, smooth style'),
  rec('Yogurt, Greek, plain, nonfat'),
];

/** Enough filler to exceed the cap. */
const filler = (count, prefix = 'Filler') =>
  Array.from({ length: count }, (_, i) => rec(`${prefix} ${String(i).padStart(5, '0')}`, -1));

console.log('\nExclusions');

test('drops baby food, which USDA writes as one word', () => {
  ok(isExcluded('Babyfood, cereal, with egg yolks, junior'), 'Babyfood');
  ok(isExcluded('Baby food, carrots, strained'), 'spaced spelling too');
});

test('drops ALL-CAPS brand names', () => {
  ok(isExcluded('Beverages, drink mix, QUAKER OATS, GATORADE, orange flavor, powder'), 'QUAKER');
  ok(isExcluded('Cereals ready-to-eat, GENERAL MILLS, CHEERIOS'), 'GENERAL MILLS');
  ok(isExcluded('Babyfood, Baby MUM MUM Rice Biscuits'), 'MUM MUM');
});

test('drops alcohol, restaurant and fast food entries', () => {
  ok(isExcluded('Alcoholic beverage, rice (sake)'), 'sake');
  ok(isExcluded('Fast foods, cheeseburger, double'), 'fast food');
  ok(isExcluded('Restaurant, Chinese, sweet and sour pork'), 'restaurant');
});

test('keeps the plain generic descriptions this app is for', () => {
  for (const name of [
    'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
    'Lentils, mature seeds, cooked, boiled, without salt',
    'Rice, white, long-grain, regular, enriched, cooked',
    'Eggs, whole, raw, fresh',
    'Oil, olive, salad or cooking',
    'Yogurt, Greek, plain, nonfat',
  ]) {
    ok(!isExcluded(name), `should keep: ${name}`);
  }
});

console.log('\nRanking');

test('Foundation analyses outrank SR Legacy', () => {
  const name = 'Broccoli, raw';
  ok(stapleScore({ dataType: 'Foundation' }, name) > stapleScore({ dataType: 'SR Legacy' }, name),
    'Foundation should score higher');
});

test('the food outranks the product made from it', () => {
  // An earlier version subtracted points per comma, which is exactly backwards for
  // USDA: the canonical staples are the long five-clause descriptions, and the
  // short names belong to products. That scoring kept Rice crackers and cut rice.
  const pairs = [
    ['Chicken, broilers or fryers, breast, meat only, cooked, roasted', 'Chicken breast, roll, oven-roasted'],
    ['Rice, white, long-grain, regular, enriched, cooked', 'Rice crackers'],
    ['Oats, whole grain, rolled, old fashioned', 'Rice flour, brown'],
  ];
  for (const [food, product] of pairs) {
    ok(stapleScore({}, food) > stapleScore({}, product),
      `"${food}" should outrank "${product}"`);
  }
});

test('a staple is only a sentinel in its plain form', () => {
  // The run that shipped: the sentinel matched "Chicken breast tenders, breaded"
  // and passed, while the actual chicken breast was missing from the file.
  const withOnlyProcessed = [
    ...staples().filter((r) => !/chicken/i.test(r.name)),
    rec('Chicken breast tenders, breaded, uncooked'),
    rec('Chicken breast, roll, oven-roasted'),
  ];
  throws(() => finalize([...filler(600), ...withOnlyProcessed]), /chicken breast/,
    'processed variants must not satisfy the staple check');
});

console.log('\nPortion labels');

test('rejects USDA measurement jargon as a serving label', () => {
  // 197 records shipped saying "1 RACC" — Reference Amount Customarily Consumed.
  ok(pickPortion({ foodPortions: [{ gramWeight: 40, amount: 1, measureUnit: { name: 'RACC' } }] }) === null,
    'RACC should fall back to 100 g');
  ok(pickPortion({ foodPortions: [{ gramWeight: 40, amount: 1, measureUnit: { name: 'serving' } }] }) === null,
    '"1 serving" says nothing');
});

test('a zero amount becomes one', () => {
  // USDA reports amount 0 on some portions, which produced "0 breast, bone removed".
  const p = pickPortion({ foodPortions: [{ gramWeight: 120, amount: 0, measureUnit: { name: 'breast' } }] });
  ok(p && p.label === '1 breast', `got ${p && p.label}`);
});

test('prefers a household measure over whatever came first', () => {
  const p = pickPortion({ foodPortions: [
    { gramWeight: 100, amount: 1, measureUnit: { name: 'RACC' } },
    { gramWeight: 158, amount: 1, measureUnit: { name: 'cup' } },
  ] });
  ok(p && p.label === '1 cup', `got ${p && p.label}`);
});

console.log('\nSearch ranking');

const catalogue = [
  { name: 'Potatoes, baked, flesh and skin, with salt' },
  { name: 'Potato pancakes' },
  { name: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted' },
  { name: 'Chicken breast tenders, breaded, uncooked' },
  { name: 'Rice, white, long-grain, regular, enriched, cooked' },
  { name: 'Rice crackers' },
  { name: 'Rice bran, crude' },
  { name: 'Eggs, whole, raw, fresh' },
  { name: 'Eggnog' },
  { name: 'Eggplant, raw' },
  { name: 'Oats, whole grain, rolled, old fashioned' },
  { name: 'Buckwheat groats, roasted, dry' },
  { name: 'Fish, salmon, Atlantic, farmed, cooked, dry heat' },
  { name: 'Salmonberries, raw (Alaska Native)' },
];
const top = (q) => searchLibrary(q, catalogue)[0]?.name;

test('the head noun wins over a product sharing its prefix', () => {
  ok(/^Rice, white/.test(top('rice')), `"rice" returned ${top('rice')}`);
  ok(/^Eggs, whole/.test(top('egg')), `"egg" returned ${top('egg')}`);
});

test('words may be split across clauses', () => {
  // "chicken breast" is not one run of characters in the canonical description.
  ok(/broilers or fryers/.test(top('chicken breast')),
    `"chicken breast" returned ${top('chicken breast')}`);
});

test('a mid-word match ranks below a real one', () => {
  ok(/^Oats/.test(top('oats')), `"oats" returned ${top('oats')} — groats should not win`);
  ok(/salmon, Atlantic/.test(top('salmon')), `"salmon" returned ${top('salmon')}`);
});

test('derivative products rank last', () => {
  const names = searchLibrary('rice', catalogue).map((f) => f.name);
  ok(names.indexOf('Rice crackers') > names.findIndex((n) => /^Rice, white/.test(n)),
    'crackers should trail actual rice');
});

test('a singular query matches a plural head noun', () => {
  // "potato" scored as a partial match against "Potatoes, baked" and lost to
  // "Potato pancakes", which matched the singular exactly. USDA pluralises the way
  // English does, so the word test has to as well.
  ok(/^Potatoes, baked/.test(top('potato')), `"potato" returned ${top('potato')}`);
});

test('a query matching nothing returns nothing', () => {
  ok(searchLibrary('zzzz', catalogue).length === 0, 'no spurious matches');
});

console.log('\nSelection — the bug that shipped');

test('staples survive when the candidate list exceeds the cap', () => {
  // The exact shape of the original failure: staples whose names sort late,
  // buried in filler that sorts early. A name-ordered cap loses all of them.
  const records = [...filler(MAX_RECORDS + 1000, 'Aaa filler'), ...staples()];
  const result = finalize(records);
  for (const [label, matcher] of [
    ['lentils', /^Lentils/], ['rice', /^Rice, white/], ['milk', /^Milk/],
    ['salmon', /salmon/i], ['yogurt', /Yogurt/],
  ]) {
    ok(result.some((r) => matcher.test(r.name)), `${label} should have survived the cap`);
  }
});

test('a staple survives the cap even when it scores badly on its own', () => {
  // The run that failed on this: "Cereals, oats, regular and quick, not fortified,
  // dry" carries four commas and ranks poorly, so the heuristic alone would cut it.
  // Sentinel foods are lifted out of reach of the cap entirely.
  const awkward = rec('Cereals, oats, regular and quick, not fortified, dry',
    stapleScore({}, 'Cereals, oats, regular and quick, not fortified, dry'));
  const result = finalize([...filler(MAX_RECORDS + 2000), ...staples(), awkward]);
  ok(result.some((r) => /oats, regular and quick/i.test(r.name)),
    'the awkwardly-named oats record should have been protected');
});

test('sentinel matchers are loose enough for USDA renaming', () => {
  // Foundation calls rolled oats "Oats, whole grain, rolled, old fashioned" — no
  // "Cereals," prefix. An anchored matcher failed a good run over exactly this.
  const foundationOats = [
    rec('Oats, whole grain, rolled, old fashioned'),
    ...staples().filter((r) => !/oat/i.test(r.name)),
  ];
  finalize([...filler(600), ...foundationOats]);  // throws if the matcher is too strict
});

test('the cap is still applied', () => {
  const result = finalize([...filler(MAX_RECORDS + 1000), ...staples()]);
  ok(result.length === MAX_RECORDS, `expected ${MAX_RECORDS}, got ${result.length}`);
});

test('output is sorted by name, and carries only the four shipped fields', () => {
  const result = finalize([...filler(600), ...staples()]);
  const names = result.map((r) => r.name);
  ok(String(names) === String([...names].sort((a, b) => a.localeCompare(b))), 'sorted by name');
  ok(!('score' in result[0]), 'the internal score must not be written to the file');
  ok(String(Object.keys(result[0]).sort()) === 'kcal,name,protein,serving',
    `unexpected fields: ${Object.keys(result[0])}`);
});

test('a missing staple fails the run instead of writing the file', () => {
  const withoutRice = staples().filter((r) => !/^Rice, white/.test(r.name));
  throws(() => finalize([...filler(600), ...withoutRice]), /white rice/,
    'should refuse and name the missing staple');
});

test('a too-small result fails the run', () => {
  throws(() => finalize([...staples(), ...filler(10)]), /minimum/,
    'should refuse a short dataset');
});

test('duplicates collapse to the higher-scoring record', () => {
  const name = 'Milk, whole, 3.25% milkfat';
  const result = finalize([
    ...filler(600),
    ...staples(),
    { ...rec(name, 99), kcal: 149 },
    { ...rec(name, -99), kcal: 999 },
  ]);
  const milk = result.filter((r) => r.name === name);
  ok(milk.length === 1, `expected one record, got ${milk.length}`);
  ok(milk[0].kcal === 149, `kept the wrong duplicate: ${milk[0].kcal}`);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
