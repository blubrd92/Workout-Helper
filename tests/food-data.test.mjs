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

import {
  finalize, isExcluded, stapleScore, pickPortion, MAX_RECORDS,
  normalizeDescription, selectByHeadNoun,
} from '../tools/build-common-foods.js';
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

test('drops brands whose capitals have no word boundary', () => {
  // Nine of these shipped. /\b[A-Z]{3,}\b/ misses "McDONALD'S" because the
  // lowercase "c" removes the boundary before DONALD and the "'S" removes the one
  // after it — the pattern was checking for a tidiness the data does not have.
  ok(isExcluded("McDONALD'S, Egg McMUFFIN"), 'McDONALD\'S');
  ok(isExcluded("McDONALD'S, Sausage Biscuit with Egg"), 'sausage biscuit');
  ok(isExcluded('Bacon, Egg & Cheese McGRIDDLES'), 'McGRIDDLES');
});

test('drops title-case brands that carry no capitals run at all', () => {
  // "Oscar Mayer, Chicken Breast (honey glazed)" ranked 6th for "chicken breast".
  // No pattern over letter case can catch it; an explicit list is the honest fix.
  ok(isExcluded('Oscar Mayer, Chicken Breast (honey glazed)'), 'Oscar Mayer');
  ok(isExcluded('Kellogg, corn flakes'), 'Kellogg');
});

test('brand filtering does not catch legitimate descriptions', () => {
  for (const name of [
    'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
    'Milk, whole, 3.25% milkfat, with added vitamin D',
    'Cheese, cheddar',
    'Oil, olive, salad or cooking',
    'Butter, salted',
    'Salmonberries, raw (Alaska Native)',
  ]) {
    ok(!isExcluded(name), `should keep: ${name}`);
  }
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

test('organ meat and trim rank below the cut people log', () => {
  // "chicken" used to return ground chicken, then chicken feet, then three kinds
  // of giblets: 146 records share that head noun, and the tie-break was length.
  const parts = [
    { name: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', serving: '0.5 breast' },
    { name: 'Chicken, feet, boiled', serving: '100 g' },
    { name: 'Chicken, capons, giblets, raw', serving: '100 g' },
  ];
  ok(/breast/.test(searchLibrary('chicken', parts)[0].name),
    `"chicken" returned ${searchLibrary('chicken', parts)[0].name}`);
});

test('a raw form ranks below the cooked one', () => {
  // Dry rice is ~3x the calorie density of cooked, so this is a wrong number in
  // the log rather than an untidy result.
  const rice = [
    { name: 'Rice, white, long-grain, regular, raw', serving: '1 cup' },
    { name: 'Rice, white, long-grain, regular, cooked', serving: '1 cup' },
  ];
  ok(/cooked/.test(searchLibrary('rice', rice)[0].name), 'cooked rice should win');
});

test('ordinary words that look like offal are not treated as offal', () => {
  // "skin" demoted "Potatoes, baked, flesh and skin" below potato pancakes.
  const spuds = [
    { name: 'Potatoes, baked, flesh and skin, with salt', serving: '1 potato medium' },
    { name: 'Potato pancakes', serving: '1 medium' },
  ];
  ok(/^Potatoes, baked/.test(searchLibrary('potato', spuds)[0].name),
    'a baked potato is not offal');
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

console.log('\nSelection — breadth');

test('USDA bookkeeping is stripped, not treated as a brand', () => {
  // "Cheese, cheddar (Includes foods for USDA's Food Distribution Program)" is the
  // canonical cheddar record. The brand filter dropped it, because "USDA" is three
  // capitals in a row — which is how a 2,490-record food file came to contain 13
  // cheeses and no cheddar. The note rides on the plainest records in the set.
  const annotated = "Cheese, cheddar (Includes foods for USDA's Food Distribution Program)";
  ok(normalizeDescription(annotated) === 'Cheese, cheddar', `got ${normalizeDescription(annotated)}`);
  ok(!isExcluded(annotated), 'the food must survive its own paperwork');
  // The genuinely institutional entries are still excluded, on the stripped name.
  ok(isExcluded('Beef, ground, USDA Commodity, frozen'), 'commodity packs are still out');
});

test('one food with thousands of records cannot crowd out a food with one', () => {
  // The shape of the failure this selection replaces: 194 kinds of fish, 146
  // chicken, 132 beef, 101 veal, and no butter, salt, honey, oil or flour at all.
  // Sorting globally by score does not pick the best records, it picks the
  // best-scoring CATEGORY — +40 for a cooking word is unreachable for a food
  // nobody cooks.
  const crowd = Array.from({ length: MAX_RECORDS }, (_, i) =>
    rec(`Fish, species ${String(i).padStart(4, '0')}, cooked, dry heat`, stapleScore({}, 'x, cooked')));
  const loners = ['Butter, salted', 'Honey', 'Salt, table', 'Oil, olive, salad or cooking', 'Cheese, cheddar']
    .map((name) => rec(name, stapleScore({}, name)));

  const result = finalize([...crowd, ...loners, ...staples()]);
  for (const { name } of loners) {
    ok(result.some((r) => r.name === name), `${name} was crowded out`);
  }
});

test('a sentinel guarantees one slot, not one per match', () => {
  // /\bmilk\b/ matched 43 records and the +10000 bonus made every one of them
  // immune to the cut. Between milk and potato the sentinel list was holding 511
  // of 2,500 slots to answer a question that needed one record each.
  const milks = Array.from({ length: 60 }, (_, i) => rec(`Milk, variety ${String(i).padStart(3, '0')}, fluid`));
  const result = finalize([...filler(MAX_RECORDS), ...staples(), ...milks]);
  const kept = result.filter((r) => /^Milk, variety/.test(r.name));
  ok(kept.length <= 5, `milk variants took ${kept.length} slots`);
});

test('a food is not shipped twice as "with salt" and "without salt"', () => {
  // USDA ships most prepared vegetables and grains as a pair with identical energy
  // and protein. 188 such pairs were in the file — 188 slots spent saying the same
  // thing twice, in a file with no room for butter.
  const pair = [
    rec('Carrots, cooked, boiled, drained, with salt'),
    rec('Carrots, cooked, boiled, drained, without salt'),
  ];
  const result = finalize([...filler(600), ...staples(), ...pair]);
  ok(result.filter((r) => /^Carrots, cooked/.test(r.name)).length === 1, 'the pair should collapse to one');
});

test('cuts are distinguished at whichever clause carries them', () => {
  // "Chicken, broilers or fryers, thigh, meat only, cooked, stewed" — the second
  // clause is a bird-size qualifier and the CUT, the part anyone searches for, is
  // the third. Splitting only on the second clause spent the chicken allowance on
  // four kinds of breast and dropped the thigh.
  const cuts = ['breast', 'thigh', 'drumstick', 'wing'].flatMap((cut) =>
    [0, 1, 2].map((i) => rec(`Chicken, broilers or fryers, ${cut}, meat only, cooked, variant ${i}`, 40)));
  const picked = selectByHeadNoun(cuts, 4).map((r) => r.name);
  for (const cut of ['breast', 'thigh', 'drumstick', 'wing']) {
    ok(picked.some((n) => n.includes(`, ${cut},`)), `no ${cut} in ${picked.length} slots: ${picked}`);
  }
});

test('a broad head noun spends its slots on different foods', () => {
  // "Fish" covers 234 records. Ordering its species by score put the 43
  // shortest-named fish in the file and no tuna, because every species scores the
  // same and the tie-break was name length.
  const fish = [
    ...Array.from({ length: 12 }, (_, i) => rec(`Fish, tuna, form ${i}, cooked, dry heat`, 40)),
    ...['burbot', 'cusk', 'sucker', 'wolffish'].map((s) => rec(`Fish, ${s}, cooked`, 40)),
  ];
  const picked = selectByHeadNoun(fish, 4).map((r) => r.name);
  ok(picked.filter((n) => /tuna/.test(n)).length <= 2, `tuna took ${picked.length} of 4 slots: ${picked}`);
  ok(picked.some((n) => /tuna/.test(n)), `tuna missing entirely: ${picked}`);
});

console.log('\nSelection — which record speaks for a food');

test('stapleScore is a tier, not a near-tie broken by name length', () => {
  // The length penalty meant two records of the same food never tied, so every
  // later comparison — cooked over raw, a portion you can picture over "3 oz" —
  // was unreachable. Raw tuna beat cooked tuna by five characters.
  ok(stapleScore({}, 'Fish, tuna, skipjack, fresh, cooked, dry heat')
    === stapleScore({}, 'Fish, tuna, fresh, bluefin, raw'),
  'two eaten forms of one food must tie, and let the tie-breaks decide');
});

test('a food is represented by its cooked form, not its shorter raw one', () => {
  // The file described tuna as "Fish, tuna, fresh, bluefin, raw". Note this only
  // compares records of the SAME food — preferring cooked as a blanket rule has
  // been tried, and it fixed rice while breaking broccoli.
  const tuna = ['Fish, tuna, fresh, bluefin, raw', 'Fish, tuna, skipjack, fresh, cooked, dry heat']
    .map((name) => rec(name, stapleScore({}, name)));
  const picked = selectByHeadNoun(tuna, 1).map((r) => r.name);
  ok(/cooked/.test(picked[0]), `got ${picked[0]}`);
});

test('the record that speaks for a food has a portion you can picture', () => {
  // Same food, same preparation, both labels legitimate: "3 oz" is not something
  // anyone can estimate on a plate, and this is the last chance to prefer the one
  // that is. It decided chicken thigh.
  const thigh = [
    { ...rec('Chicken, broilers or fryers, thigh, meat only, cooked, roasted', 40), serving: '3 oz' },
    { ...rec('Chicken, broilers or fryers, thigh, meat only, cooked, stewed', 40), serving: '1 cup, chopped or diced' },
  ];
  const picked = selectByHeadNoun(thigh, 1);
  ok(picked[0].serving === '1 cup, chopped or diced', `got ${picked[0].serving}`);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
