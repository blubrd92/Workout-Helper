/**
 * Food search: the user's own library first, the bundled USDA dataset second.
 *
 * The bundled dataset (data/common-foods.json) is loaded LAZILY — only the first
 * time a search actually needs it, never on app boot. Opening the app mid-workout
 * must not wait on a few hundred kilobytes of food data, and logging from your own
 * library must not either. Once fetched it stays in memory for the session, and
 * the browser cache handles repeat visits.
 *
 * Search is case-insensitive substring matching. No index, no search library, no
 * server call — with a few thousand short strings this is a fraction of a frame on
 * a phone, and it works offline like everything else.
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
 * Rank matches within one list.
 * A name that starts with the query beats one that merely contains it, and shorter
 * names beat longer ones — "Egg" should outrank "Egg substitute, liquid".
 */
function rank(items, needle, nameOf) {
  const scored = [];
  for (const item of items) {
    const name = nameOf(item);
    const at = name.indexOf(needle);
    if (at === -1) continue;
    scored.push({ item, score: (at === 0 ? 0 : 1000) + at + name.length / 100 });
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
