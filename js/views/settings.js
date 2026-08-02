/**
 * Settings — targets, plan management, export/import, and account.
 *
 * Everything destructive here is double-confirmed and says plainly what it will do.
 */

import {
  el, sectionTitle, field, chips, segmented, asyncButton, empty, sheet,
} from '../components.js';
import * as store from '../store.js';
import { planImportForm } from '../plan-import.js';
import { buildBackup, backupFilename, buildCoachReport, reportFilename } from '../export.js';
import {
  add, toast, downloadFile, copyToClipboard, confirmDangerous, todayISO, addDays,
  formatDate, isValidISO,
} from '../util.js';
import { DAY_NAMES } from '../config.js';
import {
  auth, signOut, deleteUser, reauthenticateWithPopup, reauthenticateWithCredential,
  GoogleAuthProvider, EmailAuthProvider,
} from '../firebase.js';

export const title = 'Settings';

export async function render(root, params, { navigate, rerender }) {
  /*
    Every read happens before anything is put on screen, and the whole page is
    appended in one go.

    This used to append each card as its own await resolved, so the screen built
    itself in two visible stages — the first three cards painted, then the plan
    list arrived and shoved everything below it down. That is what made Settings
    jump when the other tabs did not: it is the only screen that fetches after it
    has already drawn something.
  */
  const [settings, plans, activePlan] = await Promise.all([
    store.getSettings(),
    store.listPlans(),
    store.getActivePlan(),
  ]);

  add(
    root,
    renderTargets(settings),
    renderTraining(settings),
    renderWatchItem(settings),
    renderPlans({ plans, activePlan, rerender }),
    renderExport(),
    renderImport(rerender),
    renderAccount(navigate),
  );
}

// ---------------------------------------------------------------- targets

function renderTargets(settings) {
  const kcalInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', value: settings.kcalTarget });
  const proteinInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', value: settings.proteinTarget });

  const unit = segmented({
    value: settings.weightUnit,
    allowClear: false,
    options: [{ value: 'lb', label: 'lb' }, { value: 'kg', label: 'kg' }],
    onChange: async (value) => {
      // Only the display unit changes. Stored weights keep the unit they were
      // recorded in, so switching never silently rescales history.
      await store.saveSettings({ weightUnit: value });
      toast(`New weights will be recorded in ${value}.`);
    },
  });

  return el('div', {}, [
    sectionTitle('Daily targets'),
    el('div', { class: 'card' }, [
      el('div', { class: 'row gap' }, [
        el('div', { class: 'grow' }, field('Calories', kcalInput)),
        el('div', { class: 'grow' }, field('Protein (g)', proteinInput)),
      ]),
      asyncButton('Save targets', 'btn primary block', async () => {
        await store.saveSettings({
          kcalTarget: Number(kcalInput.value) || 0,
          proteinTarget: Number(proteinInput.value) || 0,
        });
        toast('Targets saved.');
      }),
      field('Weight unit', unit, 'Weights already logged keep the unit they were recorded in.'),
    ]),
  ]);
}

// ---------------------------------------------------------------- training days

function renderTraining(settings) {
  let plannedDays = [...(settings.plannedDays || [])];
  let weekStart = settings.weekStart ?? 0;

  return el('div', {}, [
    sectionTitle('Training days'),
    el('div', { class: 'card' }, [
      field('Planned days', chips({
        multiple: true,
        value: plannedDays,
        options: DAY_NAMES.map((name, index) => ({ value: index, label: name })),
        onChange: (values) => { plannedDays = values; },
      }), 'Shown on the calendar. A planned day with no session is never marked as a failure.'),

      field('Weeks start on', segmented({
        value: weekStart,
        allowClear: false,
        options: [{ value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }],
        onChange: (value) => { weekStart = value; },
      }), 'Used by the calendar and the weekly weight averages.'),

      asyncButton('Save', 'btn primary block', async () => {
        await store.saveSettings({ plannedDays: [...plannedDays].sort(), weekStart });
        toast('Saved.');
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------- watch item

/**
 * The watch item is whatever the user says it is. No body part is hardcoded
 * anywhere in this app, and the field does not exist until they name one.
 */
function renderWatchItem(settings) {
  const labelInput = el('input', {
    type: 'text',
    value: settings.watchItem?.label || '',
    maxlength: '40',
    placeholder: 'e.g. knee, shoulder, sleep quality',
  });

  const toggle = el('input', {
    type: 'checkbox',
    checked: settings.watchItem?.enabled || null,
  });

  return el('div', {}, [
    sectionTitle('Watch item'),
    el('div', { class: 'card' }, [
      el('p', { class: 'small muted' },
        'One thing you are keeping an eye on, logged green / yellow / red each session and shown next to your training history.'),
      el('label', { class: 'row gap', style: { minHeight: '44px' } }, [toggle, el('span', {}, 'Log it each session')]),
      field('What are you watching?', labelInput),
      asyncButton('Save', 'btn primary block', async () => {
        const label = labelInput.value.trim();
        if (toggle.checked && !label) { toast('Give it a name first.'); return; }
        await store.saveSettings({ watchItem: { enabled: toggle.checked, label } });
        toast('Saved.');
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------- plans

function renderPlans({ plans, activePlan: active, rerender }) {
  const list = plans.length
    ? el('ul', { class: 'list' }, plans.map((plan) => el('li', {}, [
      el('div', { class: 'list-row' }, [
        el('span', { class: 'title' }, [
          el('b', {}, plan.name),
          el('span', { class: 'meta' }, `effective ${plan.effective} · ${plan.sessions.length} sessions`),
        ]),
        plan.id === active?.id
          ? el('span', { class: 'badge' }, 'active')
          : asyncButton('Use', 'btn small', async () => {
            await store.setActivePlan(plan.id);
            toast(`"${plan.name}" is now active.`);
            rerender();
          }),
        el('button', {
          class: 'btn small', type: 'button',
          onclick: () => viewPlanSource(plan),
        }, 'View'),
      ]),
    ])))
    : empty('No plans yet.');

  return el('div', {}, [
    sectionTitle('Plan'),
    el('div', { class: 'card' }, [
      active
        ? el('p', { class: 'small muted' }, `Active: ${active.name} (effective ${active.effective}).`)
        : el('p', { class: 'small muted' }, 'No active plan.'),
      list,
      el('p', { class: 'small faint' }, 'Old plans are kept. Each logged session records the plan it was logged under.'),
    ]),
    el('div', { class: 'card' }, [
      el('h3', {}, 'New plan'),
      planImportForm({ onSaved: () => rerender() }),
    ]),
  ]);
}

function viewPlanSource(plan) {
  const body = el('div', {}, [
    el('textarea', { readonly: true, style: { minHeight: '16rem' } }, plan.source || '(no source stored)'),
  ]);
  const ui = sheet({
    title: plan.name,
    body,
    actions: [
      asyncButton('Copy', 'btn grow', async () => {
        const okCopy = await copyToClipboard(plan.source || '');
        toast(okCopy ? 'Copied.' : 'Could not copy — select the text instead.');
      }),
      el('button', {
        class: 'btn', onclick: () => downloadFile(`${plan.name.replace(/[^\w-]+/g, '-').toLowerCase()}.md`, plan.source || '', 'text/markdown'),
      }, 'Download'),
    ],
  });
  return ui;
}

// ---------------------------------------------------------------- export

function renderExport() {
  // Default range: the last 28 days, which is the usual "since we last talked"
  // window for a coach check-in.
  const startInput = el('input', { type: 'date', value: addDays(todayISO(), -27) });
  const endInput = el('input', { type: 'date', value: todayISO() });

  const range = () => {
    const start = isValidISO(startInput.value) ? startInput.value : addDays(todayISO(), -27);
    const end = isValidISO(endInput.value) ? endInput.value : todayISO();
    return start <= end ? { start, end } : { start: end, end: start };
  };

  return el('div', {}, [
    sectionTitle('Export'),

    el('div', { class: 'card' }, [
      el('h3', {}, 'Coach report'),
      el('p', { class: 'small muted' },
        'A markdown summary of a date range — every session with loads, sets and tank values, nutrition daily totals, and weekly weight averages. Built to paste into a chat.'),
      el('div', { class: 'row gap' }, [
        el('div', { class: 'grow' }, field('From', startInput)),
        el('div', { class: 'grow' }, field('To', endInput)),
      ]),
      el('div', { class: 'row gap' }, [
        asyncButton('Copy report', 'btn primary grow', async () => {
          const { start, end } = range();
          const report = await buildCoachReport(start, end);
          const okCopy = await copyToClipboard(report);
          toast(okCopy ? 'Report copied.' : 'Could not copy — download it instead.');
        }),
        asyncButton('Download', 'btn', async () => {
          const { start, end } = range();
          downloadFile(reportFilename(start, end), await buildCoachReport(start, end), 'text/markdown');
        }),
      ]),
      asyncButton('Preview', 'btn link', async () => {
        const { start, end } = range();
        const report = await buildCoachReport(start, end);
        sheet({
          title: `${formatDate(start)} – ${formatDate(end)}`,
          body: el('textarea', { readonly: true, style: { minHeight: '20rem' } }, report),
        });
      }),
    ]),

    el('div', { class: 'card' }, [
      el('h3', {}, 'Full backup'),
      el('p', { class: 'small muted' },
        'Every plan, session, food, meal, and logged day as JSON. Keep one somewhere that is not your phone.'),
      el('div', { class: 'row gap' }, [
        asyncButton('Download backup', 'btn primary grow', async () => {
          downloadFile(backupFilename(), await buildBackup(), 'application/json');
        }),
        asyncButton('Copy', 'btn', async () => {
          const okCopy = await copyToClipboard(await buildBackup());
          toast(okCopy ? 'Backup copied.' : 'Could not copy — download it instead.');
        }),
      ]),
    ]),
  ]);
}

// ---------------------------------------------------------------- import

function renderImport(rerender) {
  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });

  return el('div', {}, [
    sectionTitle('Import'),
    el('div', { class: 'card' }, [
      el('p', { class: 'small muted' },
        'Restore a JSON backup into this account. This replaces everything currently here — it does not merge.'),
      field('Backup file', fileInput),
      asyncButton('Restore backup', 'btn block', async () => {
        const file = fileInput.files?.[0];
        if (!file) { toast('Choose a backup file first.'); return; }

        let backup;
        try {
          backup = JSON.parse(await file.text());
        } catch {
          toast('That file is not valid JSON.');
          return;
        }
        if (backup.app && backup.app !== 'ledger') {
          toast('That does not look like a Ledger backup.');
          return;
        }

        const counts = Object.entries(backup.collections || {})
          .map(([name, list]) => `${list.length} ${name}`)
          .join(', ');

        if (!await confirmDangerous(
          `Restore this backup? It contains ${counts || 'no records'}.`,
          'Everything currently in this account will be deleted first. This cannot be undone. Restore?',
        )) return;

        await store.restoreBackup(backup);
        toast('Backup restored.');
        rerender();
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------- account

function renderAccount(navigate) {
  const user = auth.currentUser;

  return el('div', {}, [
    sectionTitle('Account'),
    el('div', { class: 'card stack' }, [
      el('p', { class: 'small muted' }, user?.email || user?.displayName || 'Signed in'),
      el('p', { class: 'small faint' },
        'Your data is visible only to this account. Nothing is shared with anyone, and there is nothing to opt out of.'),
      asyncButton('Sign out', 'btn block', async () => {
        await signOut(auth);
      }),
    ]),

    el('div', { class: 'card stack' }, [
      el('h3', {}, 'Danger zone'),

      asyncButton('Wipe all data', 'btn danger block', async () => {
        if (!await confirmDangerous(
          'Delete every plan, session, food, meal, and logged day in this account?',
          'This cannot be undone, and there is no copy unless you exported one. Wipe everything?',
        )) return;
        await store.deleteEverything({ includeUserDoc: false });
        toast('All data deleted.');
        navigate('#/onboard');
      }),

      asyncButton('Delete my account', 'btn danger block', async () => {
        if (!await confirmDangerous(
          'Delete your account and all of its data?',
          'This removes your sign-in and everything you have logged, permanently. Delete the account?',
        )) return;
        await deleteAccount();
      }),

      el('p', { class: 'small faint' },
        'Deleting the account removes the sign-in itself along with every document. Export a backup first if you might want the history.'),
    ]),
  ]);
}

/**
 * Delete all data, then the auth user.
 *
 * Data goes first on purpose: deleting the auth user revokes the credential the
 * security rules check, so a Firestore delete afterwards would be denied and would
 * leave orphaned documents nobody can ever reach or remove.
 *
 * Firebase requires a recent sign-in before deleting an account. When the session
 * is older than that, re-authenticate and try once more.
 */
async function deleteAccount() {
  const user = auth.currentUser;
  if (!user) return;

  await store.deleteEverything({ includeUserDoc: true });

  try {
    await deleteUser(user);
  } catch (err) {
    if (err.code !== 'auth/requires-recent-login') throw err;

    const usedGoogle = user.providerData.some((p) => p.providerId === 'google.com');
    if (usedGoogle) {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
    } else {
      const password = window.prompt('For security, confirm your password to finish deleting the account.');
      if (!password) {
        toast('Account not deleted. Your data has already been removed.');
        return;
      }
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    }
    await deleteUser(user);
  }

  toast('Account deleted.');
}
