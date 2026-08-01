/**
 * The plan paste / upload control, shared by the new-account chooser and Settings.
 *
 * Nothing is saved until the markdown parses cleanly. On failure every problem is
 * listed with its line number, because fixing a plan one error per attempt on a
 * phone is miserable.
 */

import { el, field, asyncButton, empty } from './components.js';
import { parsePlan } from './plan-parser.js';
import * as store from './store.js';
import { toast, clear } from './util.js';

export const STARTER_PLAN_URL = 'plans/starter.md';

/** Fetch and parse the bundled starter plan. */
export async function loadStarterPlan() {
  const res = await fetch(STARTER_PLAN_URL);
  if (!res.ok) throw new Error(`Could not load the starter plan (${res.status}).`);
  const source = await res.text();
  const parsed = parsePlan(source);
  if (!parsed.ok) {
    // This would mean the shipped file itself is broken — a bug, not user error.
    throw new Error(`The bundled starter plan failed to parse: ${parsed.errors[0].message}`);
  }
  return { parsed: parsed.plan, source };
}

/**
 * @param {object} options
 * @param {(plan) => void} options.onSaved called with the saved plan record
 * @param {string} [options.saveLabel]
 */
export function planImportForm({ onSaved, saveLabel = 'Save plan' }) {
  const wrap = el('div', { class: 'stack' });
  const messages = el('div');

  const textarea = el('textarea', {
    placeholder: '# Plan: My Plan\nEffective: 2026-08-01\n\n## Session: Full Body A\n- name: Squat\n  sets: 3\n  target: 5-8 reps\n  rest: 120',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
  });

  const fileInput = el('input', {
    type: 'file',
    accept: '.md,text/markdown,text/plain',
    onchange: async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      textarea.value = await file.text();
      showResult(parsePlan(textarea.value), { previewOnly: true });
    },
  });

  function showResult(result, { previewOnly = false } = {}) {
    clear(messages);

    if (!result.ok) {
      messages.append(el('div', { class: 'error' }, [
        el('b', {}, `${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} in this plan:`),
        el('ul', { style: { margin: '.4rem 0 0', paddingLeft: '1.1rem' } },
          result.errors.slice(0, 12).map((e) => el('li', {}, `Line ${e.line}: ${e.message}`))),
        result.errors.length > 12 ? el('p', { class: 'small' }, `…and ${result.errors.length - 12} more.`) : null,
      ]));
      return;
    }

    const plan = result.plan;
    const sessionSummary = plan.sessions
      .map((s) => `${s.name} (${s.exercises.length} exercise${s.exercises.length === 1 ? '' : 's'})`)
      .join(', ');

    messages.append(el('div', { class: 'notice' }, [
      el('b', {}, previewOnly ? 'Parsed cleanly.' : 'Ready to save.'),
      el('p', { class: 'small', style: { margin: '.3rem 0 0' } },
        `${plan.name} — effective ${plan.effective}. ${sessionSummary}.`),
    ]));

    for (const w of result.warnings) {
      messages.append(el('p', { class: 'small faint' }, `Line ${w.line}: ${w.message}`));
    }
  }

  const checkBtn = el('button', { class: 'btn', type: 'button' }, 'Check format');
  checkBtn.addEventListener('click', () => {
    if (!textarea.value.trim()) {
      clear(messages, empty('Paste a plan first, or choose a .md file.'));
      return;
    }
    showResult(parsePlan(textarea.value), { previewOnly: true });
  });

  const saveBtn = asyncButton(saveLabel, 'btn primary grow', async () => {
    const source = textarea.value;
    if (!source.trim()) {
      clear(messages, empty('Paste a plan first, or choose a .md file.'));
      return;
    }
    const result = parsePlan(source);
    showResult(result);
    if (!result.ok) return;

    const saved = await store.savePlan(result.plan, source);
    toast(`"${saved.name}" is now your active plan.`);
    textarea.value = '';
    clear(messages);
    onSaved?.(saved);
  });

  wrap.append(
    field('Paste plan markdown', textarea, 'The format is documented in PLAN_FORMAT.md.'),
    field('…or choose a .md file', fileInput),
    messages,
    el('div', { class: 'row gap' }, [checkBtn, saveBtn]),
  );

  return wrap;
}
