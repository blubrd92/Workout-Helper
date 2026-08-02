/**
 * Today — session logging. The screen this whole app exists to serve.
 *
 * Assume: phone, one thumb, halfway through a set, possibly no signal. So:
 *   - everything is tap-first; the only typing is the load field and the note
 *   - the in-progress session is mirrored to localStorage on every change, so a
 *     locked screen, a browser tab eviction, or a stray reload loses nothing
 *   - nothing is written to Firestore until "Finish session", and that write goes
 *     to the local cache first and syncs whenever the network comes back
 *
 * Routes:  #/today            log a new session (resuming any draft)
 *          #/today/<id>       edit a session already saved to history
 */

import { el, clear, sectionTitle, field, stepper, tankSelector, segmented, asyncButton, empty } from '../components.js';
import * as store from '../store.js';
import { blankEntries, blankEntry, isEntryLogged, countLoggedSets, describeSets, valueStep, valueLabel } from '../sets.js';
import { exerciseKey } from '../plan-parser.js';
import { todayISO, formatDate, toast, isValidISO, confirmDangerous, add } from '../util.js';
import { WATCH_STATUSES } from '../config.js';
import { auth } from '../firebase.js';

export const title = 'Today';

// The draft lives per-account, so a shared device does not leak one person's
// half-finished session into another's app.
const draftKey = () => `ledger:draft:${auth.currentUser?.uid || 'anon'}`;

function loadDraft() {
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDraft(draft) {
  try {
    localStorage.setItem(draftKey(), JSON.stringify(draft));
  } catch {
    // Private mode, quota, or storage disabled. The session is still fully usable;
    // it just will not survive a reload. Not worth interrupting a workout over.
  }
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* see above */ }
}

/**
 * The date new sessions are logged against. null means today.
 *
 * Deliberately a module variable rather than stored state: it survives moving
 * around the app, so catching up a week of paper logs means setting the date once
 * and entering several sessions in a row — but it resets on reload, so a forgotten
 * backfill date cannot quietly swallow next week's training.
 *
 * Three things make the current date impossible to miss while it is not today: the
 * banner on the session picker, the date field on the session itself, and the
 * confirmation toast naming the date it saved to.
 */
let loggingDate = null;

const activeDate = () => loggingDate || todayISO();

export async function render(root, params, { navigate, rerender }) {
  const settings = await store.getSettings();
  const editingId = params[0] || null;

  if (editingId) {
    const saved = await store.getSession(editingId);
    if (!saved) {
      root.append(empty('That session no longer exists.'));
      return;
    }
    await renderLogger(root, { draft: saved, settings, editing: true, navigate });
    return;
  }

  const plan = await store.getActivePlan();
  if (!plan) {
    root.append(
      el('div', { class: 'card' }, [
        el('h2', {}, 'No plan yet'),
        el('p', { class: 'small muted' }, 'Ledger logs against a plan. Load yours, or start from the bundled placeholder.'),
        el('button', { class: 'btn primary block', onclick: () => navigate('#/onboard') }, 'Choose a plan'),
      ]),
    );
    return;
  }

  const draft = loadDraft();
  // A draft for some other day is almost always an abandoned session rather than
  // one still in progress, so it is offered rather than resumed silently. When a
  // backfill date is set, that date is the one being worked on.
  if (draft && draft.date === activeDate() && draft.planId === plan.id) {
    await renderLogger(root, { draft, settings, navigate });
    return;
  }
  if (draft) {
    root.append(
      el('div', { class: 'card' }, [
        el('h3', {}, 'Unfinished session'),
        el('p', { class: 'small muted' },
          `${draft.sessionName} from ${formatDate(draft.date)}, ${countLogged(draft)} sets logged, never finished.`),
        el('div', { class: 'row gap' }, [
          el('button', {
            class: 'btn primary grow',
            onclick: () => { clear(root); renderLogger(root, { draft, settings, navigate }); },
          }, 'Resume it'),
          el('button', {
            class: 'btn grow',
            onclick: async () => {
              if (await confirmDangerous('Discard that unfinished session?')) {
                clearDraft();
                navigate('#/today');
              }
            },
          }, 'Discard'),
        ]),
      ]),
    );
  }

  renderSessionPicker(root, { plan, settings, navigate, rerender });
}

function countLogged(session) {
  return (session.exercises || []).reduce((total, ex) => total + countLoggedSets(ex), 0);
}

// ---------------------------------------------------------------- picker

function renderSessionPicker(root, { plan, settings, navigate, rerender }) {
  add(root,
    renderDateCard(rerender),
    sectionTitle('Pick a session'),
    el('div', { class: 'card' }, [
      el('p', { class: 'small muted' }, `${plan.name} · effective ${plan.effective}`),
      el('div', { class: 'stack' }, plan.sessions.map((session) =>
        el('button', {
          class: 'btn primary block',
          onclick: () => {
            const draft = newDraft(plan, session, settings);
            saveDraft(draft);
            clear(root);
            renderLogger(root, { draft, settings, navigate });
          },
        }, [
          el('span', { class: 'grow', style: { textAlign: 'left' } }, session.name),
          el('span', { class: 'small faint' }, `${session.exercises.length} exercises`),
        ]))),
    ]),
    plan.notes
      ? el('div', { class: 'card' }, [
        el('h3', {}, 'Plan notes'),
        el('p', { class: 'small muted', style: { whiteSpace: 'pre-wrap' } }, plan.notes),
      ])
      : null,
  );
}

/**
 * The date control on the session picker.
 *
 * Collapsed to a single line while the date is today, which is the normal case and
 * should stay out of the way. Once it is any other date it becomes a banner that
 * cannot be mistaken for chrome, with a one-tap way back to today.
 */
function renderDateCard(rerender) {
  const backfilling = activeDate() !== todayISO();

  const input = el('input', {
    type: 'date',
    value: activeDate(),
    'aria-label': 'Date to log against',
    onchange: () => {
      if (!isValidISO(input.value)) { input.value = activeDate(); return; }
      loggingDate = input.value === todayISO() ? null : input.value;
      rerender();
    },
  });

  return el('div', { class: `card${backfilling ? ' backfilling' : ''}` }, [
    el('div', { class: 'row gap between' }, [
      el('span', { class: 'small muted nowrap' }, backfilling ? 'Logging for' : 'Date'),
      el('div', { class: 'grow' }, input),
    ]),
    backfilling
      ? el('div', { style: { marginTop: '.7rem' } }, [
        el('p', { class: 'small', style: { margin: '0 0 .6rem' } },
          `Sessions you finish will be saved to ${formatDate(activeDate())}. The date stays set so you can enter several in a row.`),
        el('button', {
          class: 'btn small',
          type: 'button',
          onclick: () => { loggingDate = null; rerender(); },
        }, 'Back to today'),
      ])
      : null,
  ]);
}

function newDraft(plan, session, settings) {
  return {
    date: activeDate(),
    planId: plan.id,
    planName: plan.name,
    sessionName: session.name,
    fallback: false,
    sleepHours: null,
    watch: settings.watchItem?.enabled
      ? { label: settings.watchItem.label, status: null }
      : null,
    note: '',
    exercises: session.exercises.map((ex) => ({
      // Copy the plan's exercise into the session. History must stay truthful
      // after the plan changes, so a logged session never points at plan data it
      // would then re-read.
      name: ex.name,
      load: ex.load || '',
      sets: ex.sets,
      target: ex.target,
      rest: ex.rest,
      cues: ex.cues || '',
      video: ex.video || '',
      perSide: !!ex.perSide,
      type: ex.type || 'reps',
      done: false,
      entries: blankEntries(ex),
    })),
  };
}

// ---------------------------------------------------------------- logger

async function renderLogger(root, { draft, settings, editing = false, navigate }) {
  // Mutating a local object and re-saving the draft on every change keeps this
  // simple: there is no diffing, no framework, and no way for the screen and the
  // draft to disagree.
  const session = draft;
  const persist = () => { if (!editing) saveDraft(session); };

  // One query for recent history, used to offer "what you used last time" on each
  // load field. Doing this per exercise would be one read per card.
  const recent = editing ? [] : await store.listSessions({ max: 25 });
  const lastLoads = new Map();
  for (const past of recent) {
    for (const ex of past.exercises || []) {
      const key = exerciseKey(ex.name);
      if (ex.load && !lastLoads.has(key)) lastLoads.set(key, ex.load);
    }
  }

  root.append(renderHeaderCard(session, persist, editing));
  root.append(sectionTitle('Exercises'));
  for (const exercise of session.exercises) {
    root.append(renderExerciseCard(exercise, { persist, lastLoads }));
  }
  root.append(renderFooter(session, { persist, editing, navigate }));
}

function renderHeaderCard(session, persist, editing) {
  const dateInput = el('input', {
    type: 'date',
    value: session.date,
    onchange: () => {
      if (isValidISO(dateInput.value)) {
        session.date = dateInput.value;
        persist();
      } else {
        dateInput.value = session.date;
      }
    },
  });

  const fallbackBtn = el('button', {
    type: 'button',
    class: `chip${session.fallback ? ' on' : ''}`,
    'aria-pressed': String(!!session.fallback),
    onclick: () => {
      session.fallback = !session.fallback;
      fallbackBtn.classList.toggle('on', session.fallback);
      fallbackBtn.setAttribute('aria-pressed', String(session.fallback));
      persist();
    },
  }, 'Short day');

  const details = el('details', { class: 'stack' }, [
    el('summary', { class: 'small muted', style: { minHeight: '44px', display: 'flex', alignItems: 'center' } },
      'Sleep, notes' + (session.watch ? ', watch item' : '')),
    field('Hours of sleep', stepper({
      value: session.sleepHours,
      min: 0,
      max: 16,
      step: 1,
      label: 'hours of sleep',
      onChange: (v) => { session.sleepHours = v; persist(); },
    })),
    session.watch ? renderWatchField(session, persist) : null,
    field('Note', el('input', {
      type: 'text',
      value: session.note || '',
      maxlength: '200',
      placeholder: 'One line, optional',
      oninput: (e) => { session.note = e.target.value; persist(); },
    })),
  ]);

  return el('div', { class: 'card' }, [
    el('div', { class: 'row between gap' }, [
      el('h2', { class: 'grow' }, session.sessionName),
      editing ? el('span', { class: 'badge' }, 'editing') : null,
    ]),
    el('p', { class: 'small faint' }, session.planName || ''),
    field('Date', dateInput),
    el('div', { class: 'row gap wrap' }, [
      fallbackBtn,
      el('span', { class: 'small faint' }, 'The 20-minute version. Counts the same.'),
    ]),
    details,
  ]);
}

/**
 * The watch item: a user-named thing they are monitoring across sessions.
 * No body part is hardcoded — the label comes from Settings, and the whole field
 * is absent when the user has not named one.
 */
function renderWatchField(session, persist) {
  const labelText = session.watch.label || 'Watch item';
  return field(labelText, segmented({
    className: 'watch',
    value: session.watch.status,
    options: WATCH_STATUSES.map((status) => ({
      value: status,
      label: status[0].toUpperCase() + status.slice(1),
      data: { status },
    })),
    onChange: (status) => { session.watch.status = status; persist(); },
  }));
}

function renderExerciseCard(exercise, { persist, lastLoads }) {
  const card = el('div', { class: `card exercise${exercise.done ? ' done' : ''}` });

  const check = el('button', {
    class: 'check',
    type: 'button',
    'aria-pressed': String(!!exercise.done),
    'aria-label': `Mark ${exercise.name} complete`,
    onclick: () => {
      exercise.done = !exercise.done;
      check.setAttribute('aria-pressed', String(exercise.done));
      card.classList.toggle('done', exercise.done);
      setCollapsed(exercise.done);
      persist();
    },
  }, '✓');

  const loadInput = el('input', {
    type: 'text',
    value: exercise.load || '',
    placeholder: 'e.g. KB 20, chair height',
    'aria-label': `Load for ${exercise.name}`,
    oninput: () => { exercise.load = loadInput.value; persist(); },
  });

  // Free text, because loads are things like "KB 20 (handle + 6s)" and "chair
  // height" — but typing that mid-workout is exactly what we are trying to avoid,
  // so last session's value is one tap away.
  const previous = lastLoads.get(exerciseKey(exercise.name));
  const lastChip = previous && previous !== exercise.load
    ? el('button', {
      type: 'button',
      class: 'chip',
      onclick: () => { loadInput.value = previous; exercise.load = previous; persist(); toast('Load filled from last session.'); },
    }, `Last: ${previous}`)
    : null;

  const setsWrap = el('div');
  const renderSets = () => {
    clear(setsWrap);
    exercise.entries.forEach((entry, index) => {
      setsWrap.append(renderSetRows(exercise, entry, index, persist));
    });
    setsWrap.append(
      el('div', { class: 'row gap', style: { paddingTop: '.5rem' } }, [
        el('button', {
          class: 'btn small',
          type: 'button',
          onclick: () => { exercise.entries.push(blankEntry(exercise)); persist(); renderSets(); },
        }, '+ set'),
        exercise.entries.length > 1
          ? el('button', {
            class: 'btn small',
            type: 'button',
            onclick: () => {
              const last = exercise.entries[exercise.entries.length - 1];
              // Never silently discard logged work.
              if (isEntryLogged(last) && !window.confirm('That set has values logged. Remove it?')) return;
              exercise.entries.pop();
              persist();
              renderSets();
            },
          }, '− set')
          : null,
      ]),
    );
  };
  renderSets();

  // The card body collapses once the exercise is ticked done, leaving a one-line
  // summary. Seven open exercise cards is about five screens of scrolling; folding
  // them away as you finish them means the session shrinks as you work through it.
  const body = el('div', { class: 'exercise-body' }, [
    field('Load', loadInput),
    lastChip ? el('div', { class: 'chips', style: { marginTop: '-.4rem', marginBottom: '.6rem' } }, [lastChip]) : null,
    el('p', { class: 'sets-caption' },
      `Tank = ${exercise.type === 'seconds' ? 'seconds' : 'reps'} left at the end of the set`),
    setsWrap,
    exercise.cues ? el('p', { class: 'cues' }, exercise.cues) : null,
    exercise.video && /^https?:\/\//i.test(exercise.video)
      ? el('p', { class: 'video' }, [
        el('a', { href: exercise.video, target: '_blank', rel: 'noopener noreferrer' }, 'Video \u2197'),
      ])
      : null,
  ]);

  // Expanding is deliberately separate from un-ticking: you may want to look at
  // what you logged without marking the exercise unfinished again.
  const summary = el('button', {
    class: 'exercise-summary',
    type: 'button',
    onclick: () => setCollapsed(false),
  });

  let collapsed = !!exercise.done;

  function setCollapsed(next) {
    collapsed = next;
    card.classList.toggle('collapsed', collapsed);
    const logged = describeSets(exercise);
    clear(summary, [
      el('span', { class: 'grow' }, logged.length
        ? logged.map((s) => el('span', { class: 'set-pill' }, s.text))
        : el('span', { class: 'faint small' }, 'Nothing logged')),
      el('span', { class: 'faint small nowrap' }, 'Edit'),
    ]);
  }

  add(card,
    el('div', { class: 'exercise-head' }, [
      el('div', { class: 'grow' }, [
        el('h3', {}, exercise.name),
        el('p', { class: 'target' }, [
          exercise.target,
          el('span', { class: 'faint' }, ` \u00b7 ${exercise.sets} sets \u00b7 rest ${exercise.rest}s`),
        ]),
      ]),
      check,
    ]),
    summary,
    body,
  );

  setCollapsed(collapsed);
  return card;
}

/**
 * One set, as a bounded block with its number stated once.
 *
 * A per-side exercise puts left and right inside the same block — they are two
 * sides of one set, not two sets. Previously they were four sibling rows divided
 * by identical rules, so two sets of a per-side exercise read as four sets.
 *
 * Every tank control carries the word "tank" beside it. Five bare numbers under a
 * rep count are ambiguous on their own, and the one caption at the top of the card
 * has scrolled away by the time you are entering set three.
 */
function renderSetRows(exercise, entry, index, persist) {
  const unit = exercise.type === 'seconds' ? 'sec' : 'reps';

  const sideBlock = (side, sideLabel) => {
    const name = sideLabel ? `set ${index + 1} ${sideLabel}` : `set ${index + 1}`;
    return [
      el('div', { class: 'set-row' }, [
        el('span', { class: 'side-label' }, sideLabel || ''),
        stepper({
          value: side.value,
          min: 0,
          max: exercise.type === 'seconds' ? 3600 : 200,
          step: valueStep(exercise),
          label: `${valueLabel(exercise)} for ${name} of ${exercise.name}`,
          onChange: (v) => { side.value = v; persist(); },
        }),
        el('span', { class: 'unit' }, unit),
      ]),
      el('div', { class: 'tank-row' }, [
        el('span', { class: 'tank-label' }, 'tank'),
        tankSelector({
          tank: side.tank,
          plus: side.plus,
          onChange: ({ tank, plus }) => { side.tank = tank; side.plus = plus; persist(); },
        }),
      ]),
    ];
  };

  return el('div', { class: 'set-group' }, [
    el('div', { class: 'set-head' }, `Set ${index + 1}`),
    exercise.perSide
      ? [sideBlock(entry.left, 'L'), sideBlock(entry.right, 'R')]
      : sideBlock(entry, ''),
  ]);
}

function renderFooter(session, { persist, editing, navigate }) {
  const finish = asyncButton(editing ? 'Save changes' : 'Finish session', 'btn primary block', async () => {
    const logged = countLogged(session);
    if (logged === 0 && !window.confirm('Nothing is logged in this session. Save it anyway?')) return;

    const saved = await store.saveSession(session);
    if (!editing) clearDraft();
    // Name the date whenever it is not today, so a session saved into the past is
    // always confirmed as such rather than silently filed away.
    const when = session.date === todayISO() ? '' : ` to ${formatDate(session.date)}`;
    toast(`${editing ? 'Session updated' : 'Session saved'}${when}.`);
    navigate(`#/history/${saved.id}`);
  });

  const discard = el('button', {
    class: 'btn danger block',
    type: 'button',
    onclick: async () => {
      const message = editing
        ? 'Discard your changes to this session?'
        : 'Discard this session? Nothing has been saved to history yet.';
      if (!await confirmDangerous(message)) return;
      if (!editing) clearDraft();
      navigate(editing ? `#/history/${session.id}` : '#/today');
    },
  }, editing ? 'Cancel' : 'Discard session');

  return el('div', { class: 'card stack' }, [
    finish,
    discard,
    el('p', { class: 'small faint center' },
      editing
        ? 'Edits overwrite the saved session.'
        : 'Saved on this device as you go. Finishing writes it to history, syncing when you have signal.'),
  ]);
}
