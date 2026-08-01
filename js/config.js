/**
 * App-wide constants and defaults.
 * Everything a maintainer is likely to want to change lives here.
 */

// The user's established house color. Used as the accent throughout.
// Exported to JS and mirrored as --house in styles.css; change both together.
export const HOUSE = '#d4d9e4';

/**
 * Schema version stored on each user document.
 * Bump this and add a migration in js/migrations.js whenever the shape of stored
 * data changes in a way old data would not survive.
 */
export const SCHEMA_VERSION = 1;

/** Tank = "reps left in the tank". 4 is stored with plus:true and displays as "4+". */
export const TANK_VALUES = [0, 1, 2, 3, 4];

/** Watch item statuses. Neutral names; the UI colors them green/yellow/red. */
export const WATCH_STATUSES = ['green', 'yellow', 'red'];

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Default settings for a new account.
 * Note what is NOT here: no assumed body, no assumed equipment, no assumed
 * training history. The watch item is off until the user names one, and no body
 * part is hardcoded anywhere in this app.
 */
export const DEFAULT_SETTINGS = {
  kcalTarget: 2300,
  proteinTarget: 150,
  // Day-of-week numbers, 0 = Sunday. Default Mon/Wed/Fri.
  plannedDays: [1, 3, 5],
  // 0 = weeks start Sunday, 1 = weeks start Monday. Affects the calendar and the
  // weekly weight averages.
  weekStart: 0,
  weightUnit: 'lb',
  watchItem: {
    enabled: false,
    label: '', // user-named, e.g. "knee", "shoulder", "sleep quality"
  },
};

/** Where the bundled food dataset lives, relative to index.html. */
export const COMMON_FOODS_URL = 'data/common-foods.json';

/** Cap on how many search results to render before asking the user to type more. */
export const FOOD_SEARCH_LIMIT = 40;
