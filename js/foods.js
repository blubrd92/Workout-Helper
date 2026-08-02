/**
 * Food search: the user's own library first, the bundled USDA dataset second.
 *
 * The bundled dataset (data/common-foods.json) is loaded LAZILY — only the first
 * time a search actually needs it, never on app boot. Opening the app mid-workout
 * must not wait on a few hundred kilobytes of food data, and logging from your own
 * library must not either. Once fetched it stays in memory for the session, and
 * the browser cache handles repeat visits.
 *
 * Search is case-insensitive and client-side: no index, no search library, no
 * server call. With a few thousand short strings this is a fraction of a frame on
 * a phone, and it works offline like everything else.
 *
 * It matches on query WORDS rather than one literal run of characters, which is a
 * small step beyond plain substring matching and the only way "chicken breast"
 * finds "Chicken, broilers or fryers, breast, meat only, cooked, roasted".
 */

import { COMMON_FOODS_URL, FOOD_SEARCH_LIMIT } from './config.js';

let commonFoods = null;      // the parsed dataset, once loaded
let loadPromise = null;      // in-flight load, so concurrent searches share one fetch
let loadFailed = false;

/** True once the dataset is in memory — lets the UI avoid promising what it cannot do. */
export function isCommonLoaded() {
  return commonFoods !== null;
}

/**
 * Fetch the bundled dataset. Safe to call repeatedly; only the first call fetches.
 * Returns [] if the file is missing or unreadable, because a missing food dataset
 * must degrade to "search your own foods" rather than breaking the food screen.
 */
export async function loadCommonFoods() {
  if (commonFoods) return commonFoods;
  if (loadFailed) return [];
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const res = await fetch(COMMON_FOODS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const records = Array.isArray(data) ? data : data.foods;
      if (!Array.isArray(records)) throw new Error('unexpected shape');
      // Precompute the lowercase name once rather than on every keystroke.
      commonFoods = records.map((r) => ({ ...r, _lc: String(r.name).toLowerCase() }));
      return commonFoods;
    } catch (err) {
      console.warn('Common foods dataset unavailable.', err);
      loadFailed = true;
      return [];
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/** Metadata for the UI: how many records, and whether the file is there at all. */
export function commonStatus() {
  if (loadFailed) return { available: false, count: 0 };
  return { available: commonFoods !== null, count: commonFoods?.length || 0 };
}

/**
 * Words marking a derivative product rather than the food itself.
 * Mirrors the list in tools/build-common-foods.js — the generator demotes these
 * when choosing what to ship, and search demotes whatever still gets through.
 */
const DERIVATIVE = /\b(breaded|batter|battered|nuggets?|patty|patties|rolls?|dried|dehydrated|powdered?|flour|bran|instant|imitation|substitute|candied|sweetened|crackers?|chips?|puffs?|sticks?|paste|extract|concentrate)\b/i;

/**
 * Score one name against a query. Lower is better; null means no match.
 *
 * Two things this has to cope with, both consequences of USDA naming:
 *
 * 1. The words you type are often split across clauses. "chicken breast" appears
 *    in "Chicken, broilers or fryers, breast, meat only, cooked, roasted" but not
 *    adjacently, so a plain substring test finds nothing. Every query WORD must
 *    appear, rather than the query as one run of characters.
 *
 * 2. Derivative products have shorter names than the foods they derive from, so
 *    ranking on brevity puts them first: "rice" returned Rice crackers, Rice bran
 *    and Rice flour ahead of rice, and "egg" returned Eggnog and Eggplant ahead of
 *    eggs. What actually distinguishes them is the first comma-clause — the head
 *    noun. "Rice, white, long-grain" has a head of "rice"; "Rice crackers" does not.
 *
 * So: head-noun match first, then any-prefix, then words-anywhere, with a heavy
 * penalty for derivative forms and length only as a tie-break.
 */
function scoreMatch(lcName, query, tokens) {
  let midWord = false;
  let partialWord = false;
  for (const { text, whole, prefix } of tokens) {
    if (!lcName.includes(text)) return null;
    // Three strengths of match, and the difference matters more than it looks:
    //   whole word   "salmon" in "Fish, salmon, Atlantic"   — the food itself
    //   word prefix  "salmon" in "Salmonberries"            — a different food
    //   mid-word     "oats"   in "Buckwheat groats"         — a coincidence
    // Weaker matches still count, they just go to the back.
    if (!whole.test(lcName)) {
      if (prefix.test(lcName)) partialWord = true;
      else midWord = true;
    }
  }

  const head = lcName.split(',')[0].trim();
  let score;
  if (sameWord(head, query)) score = 0;
  else if (head.startsWith(query)) score = 200;
  else if (lcName.startsWith(query)) score = 300;
  else score = 400;

  if (midWord) score += 800;
  else if (partialWord) score += 250;
  if (DERIVATIVE.test(lcName)) score += 600;
  return score + lcName.length / 200;
}

/**
 * Are these the same word, allowing for a plural on either side?
 *
 * Only the +s form was handled at first, which meant "potato" did not match the
 * head noun "potatoes" and lost to "Potato pancakes". USDA pluralises the way
 * English does — potatoes, tomatoes, berries — so +es and y->ies count too.
 */
function sameWord(a, b) {
  if (a === b) return true;
  const forms = (word) => [word, `${word}s`, `${word}es`, word.replace(/y$/, 'ies')];
  return forms(a).includes(b) || forms(b).includes(a);
}

/** Escape a user-typed token for use in a RegExp. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rank(items, query, nameOf) {
  // Boundary patterns are built once per query, not once per candidate.
  const tokens = query.split(/\s+/).filter(Boolean).map((text) => ({
    text,
    // The whole-word test has to tolerate a plural, or typing "potato" scores as a
    // partial match against "Potatoes, baked" and loses to "Potato pancakes",
    // which matches the singular exactly. Same shape as sameWord() above.
    whole: new RegExp(`\\b(?:${escapeRe(text)}(?:s|es)?${
      text.endsWith('y') ? `|${escapeRe(text.slice(0, -1))}ies` : ''})\\b`),
    prefix: new RegExp(`\\b${escapeRe(text)}`),
  }));
  const scored = [];
  for (const item of items) {
    const score = scoreMatch(nameOf(item), query, tokens);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.item);
}

/**
 * Search the personal library. Always synchronous and always first: a user's own
 * entries are the faster and more accurate path, so they rank above the bundled
 * dataset without exception.
 */
export function searchLibrary(query, foods) {
  const needle = String(query).trim().toLowerCase();
  if (!needle) return [];
  return rank(foods, needle, (f) => String(f.name).toLowerCase())
    .slice(0, FOOD_SEARCH_LIMIT)
    .map((f) => ({ ...f, source: 'library' }));
}

/**
 * Search the bundled dataset. Triggers the lazy load on first use.
 * `exclude` holds lowercase library names so the same food does not appear twice.
 */
export async function searchCommon(query, exclude = new Set()) {
  const needle = String(query).trim().toLowerCase();
  if (!needle) return [];
  const all = await loadCommonFoods();
  return rank(all, needle, (f) => f._lc)
    .filter((f) => !exclude.has(f._lc))
    .slice(0, FOOD_SEARCH_LIMIT)
    .map((f) => ({
      // Copy the values out. The bundled dataset is read-only and never written to;
      // saving a result to the library copies numbers rather than referencing the
      // file, so regenerating the file never alters anyone's saved foods or logged
      // days.
      name: f.name,
      serving: f.serving || '',
      kcal: f.kcal,
      protein: f.protein,
      source: 'common',
    }));
}

/** Both lists, library first. */
export async function searchAll(query, libraryFoods) {
  const library = searchLibrary(query, libraryFoods);
  const exclude = new Set(library.map((f) => String(f.name).toLowerCase()));
  const common = await searchCommon(query, exclude);
  return { library, common };
}
