/**
 * Export: a full JSON backup, and the coach report.
 *
 * The coach report is markdown built to be pasted straight into a chat. It is the
 * only place in this app where data leaves in a form meant for something other than
 * this app, so it is written to be read: dates spelled out, every set present, tank
 * values kept, left and right never merged.
 *
 * It reports what happened. It does not comment on what didn't — no adherence
 * percentage, no "missed" days, no streaks. If a planned day has no session, the
 * report simply has no line for it, and the coach can see that for themselves.
 */

import * as store from './store.js';
import { describeSets } from './sets.js';
import {
  formatDate, formatDateLong, todayISO, num, sumBy, startOfWeek,
} from './util.js';
import { SCHEMA_VERSION } from './config.js';

// ---------------------------------------------------------------- JSON backup

/**
 * Everything the account contains, as a JSON string.
 * The shape mirrors Firestore exactly (meta + one array per collection) so restore
 * is a straight write-back, and so a human can read it in a text editor.
 */
export async function buildBackup() {
  const data = await store.readEverything();
  return JSON.stringify({
    app: 'ledger',
    schemaVersion: data.meta?.schemaVersion ?? SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meta: data.meta,
    collections: data.collections,
  }, null, 2);
}

export function backupFilename() {
  return `ledger-backup-${todayISO()}.json`;
}

// ---------------------------------------------------------------- coach report

/**
 * @param {string} start ISO date, inclusive
 * @param {string} end   ISO date, inclusive
 */
export async function buildCoachReport(start, end) {
  const [settings, sessions, days] = await Promise.all([
    store.getSettings(),
    store.listSessions({ start, end, max: 300 }),
    store.listDays(start, end),
  ]);

  const lines = [];
  lines.push(`# Training and nutrition log: ${formatDate(start)} – ${formatDate(end)}`);
  lines.push('');
  lines.push(`Exported ${formatDateLong(todayISO())}.`);
  lines.push('');

  lines.push(...trainingSection(sessions));
  lines.push(...nutritionSection(days, settings));
  lines.push(...weightSection(days, settings));

  return `${lines.join('\n').trimEnd()}\n`;
}

function trainingSection(sessions) {
  const lines = ['## Training', ''];

  if (!sessions.length) {
    lines.push('No sessions logged in this range.', '');
    return lines;
  }

  // listSessions returns newest first; a report reads better oldest first.
  const ordered = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  lines.push(`${ordered.length} session${ordered.length === 1 ? '' : 's'} logged.`, '');

  for (const session of ordered) {
    lines.push(`### ${formatDateLong(session.date)} — ${session.sessionName}${session.fallback ? ' (short day)' : ''}`);

    const meta = [];
    if (session.planName) meta.push(`Plan: ${session.planName}`);
    if (session.sleepHours !== null && session.sleepHours !== undefined) meta.push(`Sleep: ${num(session.sleepHours)}h`);
    if (session.watch?.status) meta.push(`${session.watch.label || 'Watch item'}: ${session.watch.status}`);
    if (meta.length) lines.push(meta.join(' · '));
    if (session.note) lines.push(`Note: ${session.note}`);
    lines.push('');

    lines.push('| Exercise | Load | Sets (reps @ reps-left-in-tank) |');
    lines.push('|---|---|---|');
    for (const ex of session.exercises || []) {
      const sets = describeSets(ex);
      const setText = sets.length ? sets.map((s) => s.text).join(' · ') : '—';
      const unit = ex.type === 'seconds' ? ' (seconds)' : '';
      lines.push(`| ${escapeCell(ex.name)}${unit} | ${escapeCell(ex.load || '—')} | ${escapeCell(setText)} |`);
    }
    lines.push('');
  }

  return lines;
}

function nutritionSection(days, settings) {
  const lines = ['## Nutrition', ''];
  const logged = days.filter((d) => (d.entries || []).length > 0);

  lines.push(`Targets: ${settings.kcalTarget} kcal, ${settings.proteinTarget} g protein.`);
  lines.push('');

  if (!logged.length) {
    lines.push('No food logged in this range.', '');
    return lines;
  }

  lines.push('| Date | kcal | Protein (g) |');
  lines.push('|---|---|---|');
  for (const day of logged) {
    lines.push(`| ${formatDate(day.date)} | ${Math.round(sumBy(day.entries, 'kcal'))} | ${Math.round(sumBy(day.entries, 'protein'))} |`);
  }
  lines.push('');

  const avgKcal = sumBy(logged, (d) => sumBy(d.entries, 'kcal')) / logged.length;
  const avgProtein = sumBy(logged, (d) => sumBy(d.entries, 'protein')) / logged.length;
  lines.push(`Average over the ${logged.length} logged day${logged.length === 1 ? '' : 's'}: ${Math.round(avgKcal)} kcal, ${Math.round(avgProtein)} g protein.`);
  lines.push('');

  return lines;
}

function weightSection(days, settings) {
  const lines = ['## Weight', ''];
  const readings = days
    .filter((d) => d.weight && typeof d.weight.value === 'number')
    .map((d) => ({ date: d.date, value: d.weight.value, unit: d.weight.unit || settings.weightUnit }));

  if (!readings.length) {
    lines.push('No weights logged in this range.', '');
    return lines;
  }

  const buckets = new Map();
  for (const r of readings) {
    const key = startOfWeek(r.date, settings.weekStart ?? 0);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }

  const weeks = [...buckets.entries()]
    .map(([weekStartDate, list]) => ({
      start: weekStartDate,
      average: sumBy(list, 'value') / list.length,
      count: list.length,
      unit: list[0].unit,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  lines.push('Weekly averages (the trend is the signal; daily readings are noise).');
  lines.push('');
  lines.push('| Week of | Average | Change | Readings |');
  lines.push('|---|---|---|---|');
  weeks.forEach((week, i) => {
    const previous = weeks[i - 1];
    const delta = previous ? week.average - previous.average : null;
    const change = delta === null ? '—' : `${delta > 0 ? '+' : ''}${num(delta, 1)}`;
    lines.push(`| ${formatDate(week.start)} | ${num(week.average, 1)} ${week.unit} | ${change} | ${week.count} |`);
  });
  lines.push('');

  return lines;
}

/** Pipes would break a markdown table row. */
function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function reportFilename(start, end) {
  return `ledger-report-${start}-to-${end}.md`;
}
