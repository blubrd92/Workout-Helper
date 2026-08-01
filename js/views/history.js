/**
 * History — what happened, listed and on a calendar.
 *
 * The adherence rule governs this screen. A planned day with no session is drawn
 * with exactly the same weight as any other empty day: a dashed outline marking it
 * as planned, and nothing else. No red, no streak count, no "2 days missed", no
 * copy anywhere that comments on a gap. Show what happened; never editorialise
 * about what didn't.
 *
 * Routes:  #/history          calendar + list
 *          #/history/<id>     one session in full
 */

import { el, clear, sectionTitle, segmented, empty, asyncButton } from '../components.js';
import * as store from '../store.js';
import { describeSets, countLoggedSets } from '../sets.js';
import {
  todayISO, formatDate, formatDateLong, relativeDate, monthBounds, shiftMonth, monthLabel,
  weekdayHeaders, dayOfWeek, fromISO, toISO, confirmDangerous, toast, num,
} from '../util.js';

export const title = 'History';

// Remembered across renders so paging months and coming back from a detail view
// does not throw you back to today.
let viewMode = 'calendar';
let visibleMonth = todayISO().slice(0, 7);

export async function render(root, params, { navigate }) {
  const sessionId = params[0];
  if (sessionId) return renderDetail(root, sessionId, navigate);

  const settings = await store.getSettings();

  root.append(segmented({
    value: viewMode,
    allowClear: false,
    options: [{ value: 'calendar', label: 'Calendar' }, { value: 'list', label: 'List' }],
    onChange: (mode) => { viewMode = mode; clear(body); paint(); },
  }));

  const body = el('div', { style: { marginTop: '.8rem' } });
  root.append(body);

  const paint = async () => {
    clear(body, empty('Loading…'));
    if (viewMode === 'calendar') {
      const { start, end } = monthBounds(visibleMonth);
      const sessions = await store.listSessions({ start, end, max: 62 });
      clear(body);
      body.append(renderCalendar(sessions, settings, navigate, paint));
      body.append(sectionTitle(monthLabel(visibleMonth)));
      body.append(renderList(sessions, navigate, `Nothing logged in ${monthLabel(visibleMonth)}.`));
    } else {
      const sessions = await store.listSessions({ max: 100 });
      clear(body);
      body.append(sectionTitle('Most recent'));
      body.append(renderList(sessions, navigate, 'No sessions logged yet.'));
    }
  };

  await paint();
}

// ---------------------------------------------------------------- calendar

function renderCalendar(sessions, settings, navigate, repaint) {
  const weekStart = settings.weekStart ?? 0;
  const planned = new Set(settings.plannedDays || []);
  const byDate = new Map();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }

  const { start, end } = monthBounds(visibleMonth);
  const today = todayISO();

  const head = el('div', { class: 'cal-head' }, [
    el('button', {
      class: 'btn icon', type: 'button', 'aria-label': 'Previous month',
      onclick: () => { visibleMonth = shiftMonth(visibleMonth, -1); repaint(); },
    }, '‹'),
    el('h2', {}, monthLabel(visibleMonth)),
    el('button', {
      class: 'btn icon', type: 'button', 'aria-label': 'Next month',
      onclick: () => { visibleMonth = shiftMonth(visibleMonth, 1); repaint(); },
    }, '›'),
  ]);

  const grid = el('div', { class: 'cal-grid' });
  for (const name of weekdayHeaders(weekStart)) grid.append(el('div', { class: 'dow' }, name));

  // Leading blanks so the 1st lands under the right weekday.
  const lead = (dayOfWeek(start) - weekStart + 7) % 7;
  for (let i = 0; i < lead; i++) grid.append(el('div'));

  const lastDay = fromISO(end).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const iso = toISO(new Date(fromISO(start).getFullYear(), fromISO(start).getMonth(), d, 12));
    const daySessions = byDate.get(iso) || [];
    const isPlanned = planned.has(dayOfWeek(iso));

    const classes = ['cal-cell'];
    if (daySessions.length) classes.push('has-session');
    else if (isPlanned) classes.push('planned'); // dashed outline only — see the note at the top of this file
    if (iso === today) classes.push('today');

    const cell = el(daySessions.length ? 'button' : 'div', {
      class: classes.join(' '),
      type: daySessions.length ? 'button' : null,
      'aria-label': daySessions.length
        ? `${formatDate(iso)}: ${daySessions.map((s) => s.sessionName).join(', ')}`
        : formatDate(iso),
      onclick: daySessions.length ? () => navigate(`#/history/${daySessions[0].id}`) : null,
    }, [
      el('span', {}, String(d)),
      // Every logged session gets the same dot. A short day is a session.
      ...daySessions.slice(0, 3).map(() => el('span', { class: 'cal-dot' })),
    ]);
    grid.append(cell);
  }

  return el('div', { class: 'card' }, [
    head,
    grid,
    el('div', { class: 'cal-legend' }, [
      el('span', {}, [el('span', { class: 'cal-dot', style: { background: 'var(--ink)' } }), 'session logged']),
      el('span', {}, [el('span', { class: 'legend-box' }), 'planned training day']),
    ]),
  ]);
}

// ---------------------------------------------------------------- list

function renderList(sessions, navigate, emptyMessage) {
  if (!sessions.length) return empty(emptyMessage);

  return el('ul', { class: 'list card' }, sessions.map((s) => {
    const sets = (s.exercises || []).reduce((total, ex) => total + countLoggedSets(ex), 0);
    return el('li', {}, [
      el('button', {
        class: 'list-row',
        type: 'button',
        onclick: () => navigate(`#/history/${s.id}`),
      }, [
        el('span', { class: 'title' }, [
          el('b', {}, s.sessionName),
          el('span', { class: 'meta' }, [
            relativeDate(s.date),
            s.watch?.status ? el('span', { class: `dot ${s.watch.status}`, style: { marginLeft: '.4rem' } }) : null,
          ]),
        ]),
        s.fallback ? el('span', { class: 'badge' }, 'short') : null,
        el('span', { class: 'num' }, `${sets} sets`),
      ]),
    ]);
  }));
}

// ---------------------------------------------------------------- detail

async function renderDetail(root, id, navigate) {
  const session = await store.getSession(id);
  if (!session) {
    root.append(empty('That session no longer exists.'));
    root.append(el('button', { class: 'btn block', onclick: () => navigate('#/history') }, 'Back to history'));
    return;
  }

  root.append(
    el('div', { class: 'card' }, [
      el('div', { class: 'row between gap' }, [
        el('h2', { class: 'grow' }, session.sessionName),
        session.fallback ? el('span', { class: 'badge' }, 'short day') : null,
      ]),
      el('p', { class: 'small muted' }, formatDateLong(session.date)),
      el('p', { class: 'small faint' }, session.planName ? `Logged under: ${session.planName}` : ''),
      renderMeta(session),
      session.note ? el('p', { class: 'small', style: { marginTop: '.5rem' } }, session.note) : null,
    ]),
  );

  for (const ex of session.exercises || []) {
    const sets = describeSets(ex);
    root.append(el('div', { class: 'card exercise' }, [
      el('div', { class: 'row between gap' }, [
        el('h3', { class: 'grow' }, ex.name),
        ex.done ? el('span', { class: 'badge' }, 'done') : null,
      ]),
      ex.load ? el('p', { class: 'small muted' }, ex.load) : null,
      el('p', { class: 'target' }, ex.target || ''),
      sets.length
        ? el('div', {}, sets.map((s) => el('span', { class: 'set-pill' }, `${s.set}: ${s.text}`)))
        : el('p', { class: 'small faint' }, 'No sets logged.'),
    ]));
  }

  root.append(el('div', { class: 'card stack' }, [
    el('button', { class: 'btn primary block', onclick: () => navigate(`#/today/${session.id}`) }, 'Edit this session'),
    el('button', { class: 'btn block', onclick: () => navigate('#/history') }, 'Back to history'),
    asyncButton('Delete session', 'btn danger block', async () => {
      if (!await confirmDangerous(
        `Delete the ${session.sessionName} session from ${formatDate(session.date)}?`,
        'This cannot be undone. Delete it?',
      )) return;
      await store.deleteSession(session.id);
      toast('Session deleted.');
      navigate('#/history');
    }),
  ]));
}

function renderMeta(session) {
  const bits = [];
  if (session.sleepHours !== null && session.sleepHours !== undefined) {
    bits.push(el('span', { class: 'badge' }, `sleep ${num(session.sleepHours)}h`));
  }
  if (session.watch?.status) {
    bits.push(el('span', { class: 'badge' }, [
      el('span', { class: `dot ${session.watch.status}`, style: { marginRight: '.3rem' } }),
      session.watch.label || 'watch',
    ]));
  }
  return bits.length ? el('div', { class: 'row gap wrap', style: { marginTop: '.5rem' } }, bits) : null;
}
