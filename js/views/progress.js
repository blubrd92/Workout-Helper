/**
 * Progress — the per-exercise progression table, and the weight trend.
 *
 * The progression table is the point of the whole app: pick an exercise, see every
 * time you did it, newest first, with the load and every set's reps and tank. Left
 * and right stay separate. The watch-item status for each session sits in the last
 * column so a pattern between the two is visible without cross-referencing.
 *
 * Weight follows the program rule: the weekly average is the signal and gets the
 * display, individual daily readings are noise and sit behind an expander.
 */

import { el, clear, sectionTitle, empty } from '../components.js';
import * as store from '../store.js';
import { describeSets } from '../sets.js';
import { exerciseKey } from '../plan-parser.js';
import {
  todayISO, addDays, formatDate, startOfWeek, num, sumBy, add,
} from '../util.js';

export const title = 'Progress';

// Remembered between visits: coming back to the screen you were reading is the
// whole reason to keep this in a module variable.
let selectedExercise = null;

export async function render(root) {
  // Both sections are built before either is shown, for the same reason Settings
  // is: appending a section that is still loading means the page grows under the
  // reader's thumb a moment after it appears.
  const settings = await store.getSettings();
  const exerciseSection = el('div');
  const weightSection = el('div');

  await Promise.all([
    renderExerciseSection(exerciseSection),
    renderWeightSection(weightSection, settings),
  ]);

  add(root,
    sectionTitle('Exercise progression'), exerciseSection,
    sectionTitle('Weight'), weightSection);
}

// ---------------------------------------------------------------- exercises

async function renderExerciseSection(root) {
  // The picker offers everything in the active plan plus anything in recent
  // history, so an exercise dropped from the plan is still reachable.
  const [plan, recent] = await Promise.all([
    store.getActivePlan(),
    store.listSessions({ max: 100 }),
  ]);

  const names = new Map(); // key -> display name, first spelling wins
  for (const session of plan?.sessions || []) {
    for (const ex of session.exercises) names.set(exerciseKey(ex.name), ex.name);
  }
  for (const session of recent) {
    for (const ex of session.exercises || []) {
      if (!names.has(exerciseKey(ex.name))) names.set(exerciseKey(ex.name), ex.name);
    }
  }

  if (!names.size) {
    root.append(empty('Log a session and this fills in.'));
    return;
  }

  const options = [...names.values()].sort((a, b) => a.localeCompare(b));
  if (!selectedExercise || !names.has(exerciseKey(selectedExercise))) selectedExercise = options[0];

  const select = el('select', {
    'aria-label': 'Exercise',
    onchange: () => { selectedExercise = select.value; paint(); },
  }, options.map((name) => el('option', { value: name, selected: name === selectedExercise || null }, name)));

  const table = el('div');
  root.append(el('div', { class: 'card' }, [select, table]));

  const paint = async () => {
    clear(table, empty('Loading…'));
    const sessions = await store.listSessionsWithExercise(selectedExercise, 100);
    clear(table, renderProgressionTable(selectedExercise, sessions));
  };

  await paint();
}

function renderProgressionTable(name, sessions) {
  if (!sessions.length) return empty('Nothing logged for this exercise yet.');

  const key = exerciseKey(name);
  const rows = [];

  for (const session of sessions) {
    const ex = (session.exercises || []).find((e) => exerciseKey(e.name) === key);
    if (!ex) continue;
    const sets = describeSets(ex);
    if (!sets.length && !ex.load) continue; // nothing was actually recorded
    rows.push({ session, ex, sets });
  }

  if (!rows.length) return empty('Nothing logged for this exercise yet.');

  const anyWatch = rows.some((r) => r.session.watch?.status);

  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Date'),
        el('th', {}, 'Load'),
        el('th', {}, 'Sets — reps @ tank'),
        anyWatch ? el('th', {}, rows.find((r) => r.session.watch?.label)?.session.watch.label || 'Watch') : null,
      ])),
      el('tbody', {}, rows.map(({ session, ex, sets }) => el('tr', {}, [
        el('td', { class: 'nowrap' }, [
          formatDate(session.date),
          session.fallback ? el('div', { class: 'small faint' }, 'short day') : null,
        ]),
        el('td', {}, ex.load || '—'),
        el('td', { class: 'sets' }, sets.length
          ? sets.map((s) => el('span', { class: 'set-pill' }, s.text))
          : '—'),
        anyWatch
          ? el('td', {}, session.watch?.status
            ? el('span', { class: `dot ${session.watch.status}` })
            : '')
          : null,
      ]))),
    ]),
    el('p', { class: 'small faint', style: { marginTop: '.5rem' } },
      'Tank is reps left in the tank at the end of the set. L and R are logged separately.'),
  ]);
}

// ---------------------------------------------------------------- weight

const WEEKS_SHOWN = 12;

async function renderWeightSection(root, settings) {
  const end = todayISO();
  const start = addDays(end, -7 * WEEKS_SHOWN);
  const days = await store.listDays(start, end);
  const readings = days
    .filter((d) => d.weight && typeof d.weight.value === 'number')
    .map((d) => ({ date: d.date, value: d.weight.value, unit: d.weight.unit || settings.weightUnit }));

  if (!readings.length) {
    root.append(el('div', { class: 'card' }, [
      empty('No weights logged yet. Add one from the Food screen.'),
    ]));
    return;
  }

  const weeks = groupByWeek(readings, settings.weekStart ?? 0);

  root.append(el('div', { class: 'card' }, [
    el('h3', {}, 'Weekly averages'),
    el('p', { class: 'small faint' },
      'The trend is the signal; a single day is noise. Weeks start ' +
      ((settings.weekStart ?? 0) === 1 ? 'Monday' : 'Sunday') + ', changeable in Settings.'),
    el('div', { class: 'table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Week of'),
        el('th', {}, 'Average'),
        el('th', {}, 'Change'),
        el('th', {}, 'Readings'),
      ])),
      el('tbody', {}, weeks.map((week, i) => {
        const previous = weeks[i + 1]; // weeks are newest-first
        const delta = previous ? week.average - previous.average : null;
        return el('tr', {}, [
          el('td', { class: 'nowrap' }, formatDate(week.start)),
          el('td', { class: 'mono' }, `${num(week.average, 1)} ${week.unit}`),
          el('td', { class: 'mono muted' }, delta === null ? '—' : `${delta > 0 ? '+' : ''}${num(delta, 1)}`),
          el('td', { class: 'mono faint' }, String(week.count)),
        ]);
      })),
    ])),
    // Daily readings are available but deliberately out of the way.
    el('details', { style: { marginTop: '.8rem' } }, [
      el('summary', { class: 'small muted', style: { minHeight: '44px', display: 'flex', alignItems: 'center' } },
        'Daily readings'),
      el('div', { class: 'table-wrap' }, el('table', {}, [
        el('tbody', {}, [...readings].reverse().map((r) => el('tr', {}, [
          el('td', { class: 'nowrap faint' }, formatDate(r.date)),
          el('td', { class: 'mono faint' }, `${num(r.value, 1)} ${r.unit}`),
        ]))),
      ])),
    ]),
  ]));
}

/**
 * Bucket daily readings into weeks and average each one.
 * Returns newest week first. Weeks with no readings are skipped rather than shown
 * as zero — a week you did not weigh in is missing data, not a weight of nothing.
 */
export function groupByWeek(readings, weekStart) {
  const buckets = new Map();
  for (const r of readings) {
    const key = startOfWeek(r.date, weekStart);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return [...buckets.entries()]
    .map(([start, list]) => ({
      start,
      count: list.length,
      average: sumBy(list, 'value') / list.length,
      unit: list[0].unit,
    }))
    .sort((a, b) => b.start.localeCompare(a.start));
}
