/**
 * Reusable UI pieces.
 *
 * Every control here is built for a thumb: 44px minimum, generous spacing, and
 * tap-in-preference-to-type wherever a value can be guessed or repeated.
 */

import { el, clear } from './util.js';
import { TANK_VALUES } from './config.js';

/**
 * Stepper: [−] [value] [+].
 *
 * The middle is a real number input (with inputmode="numeric", so phones raise the
 * number pad) for the rare case where tapping thirty times would be silly. The
 * buttons are what get used mid-set.
 *
 * `onChange` receives null when the field is cleared — "not logged" is a real value
 * and must survive.
 */
export function stepper({ value = null, min = 0, max = 999, step = 1, label = '', onChange }) {
  const input = el('input', {
    type: 'number',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    value: value === null || value === undefined ? '' : value,
    min,
    max,
    step,
    'aria-label': label || 'value',
  });

  const commit = (next) => {
    if (next === null) {
      input.value = '';
    } else {
      const clamped = Math.min(max, Math.max(min, next));
      input.value = String(clamped);
    }
    onChange?.(input.value === '' ? null : Number(input.value));
  };

  const bump = (delta) => {
    const current = input.value === '' ? null : Number(input.value);
    // From empty, a "+" starts at the step value rather than at min, which is what
    // you want when the first thing you do after a set is tap +.
    commit(current === null ? (delta > 0 ? step : min) : current + delta);
  };

  input.addEventListener('input', () => {
    onChange?.(input.value === '' ? null : Number(input.value));
  });
  input.addEventListener('blur', () => {
    if (input.value !== '') commit(Number(input.value));
  });

  return el('div', { class: 'stepper' }, [
    el('button', { type: 'button', 'aria-label': `decrease ${label}`, onclick: () => bump(-step) }, '−'),
    input,
    el('button', { type: 'button', 'aria-label': `increase ${label}`, onclick: () => bump(step) }, '+'),
  ]);
}

/**
 * Segmented control. `options` is [{ value, label, data }].
 * Tapping the selected option again clears it — mis-taps happen mid-set, and
 * requiring a trip to a "clear" button to fix one would be worse.
 */
export function segmented({ options, value = null, onChange, className = '', allowClear = true }) {
  const wrap = el('div', { class: `segmented ${className}`.trim(), role: 'group' });
  const buttons = new Map();

  const paint = (selected) => {
    for (const [val, btn] of buttons) btn.setAttribute('aria-pressed', String(val === selected));
  };

  for (const option of options) {
    const btn = el('button', {
      type: 'button',
      'aria-pressed': 'false',
      dataset: option.data || {},
      onclick: () => {
        const next = allowClear && current === option.value ? null : option.value;
        current = next;
        paint(current);
        onChange?.(next);
      },
    }, option.label);
    buttons.set(option.value, btn);
    wrap.append(btn);
  }

  let current = value;
  paint(current);
  return wrap;
}

/** The tank selector: 0 1 2 3 4+. */
export function tankSelector({ tank = null, plus = false, onChange }) {
  return segmented({
    className: 'tank-seg',
    value: tank,
    options: TANK_VALUES.map((v) => ({ value: v, label: v === 4 ? '4+' : String(v) })),
    onChange: (v) => onChange?.(v === null ? { tank: null, plus: false } : { tank: v, plus: v === 4 }),
  });
}

/**
 * Labelled field wrapper.
 *
 * Uses a real <label> for plain inputs, so tapping the caption focuses the field —
 * but a <div> when the control is a group of buttons (segmented, chips, stepper),
 * because a label wrapping buttons has no single control to point at and browsers
 * differ on what tapping the caption then does.
 */
export function field(labelText, control, hint) {
  const isButtonGroup = !!control?.querySelector?.('button');
  const tag = isButtonGroup ? 'div' : 'label';
  return el(tag, { class: 'field' }, [
    el('span', {}, labelText),
    control,
    hint ? el('span', { class: 'small faint' }, hint) : null,
  ]);
}

/**
 * Bottom sheet. Returns { close }.
 * Used instead of navigating away for anything quick — adding a food, editing a
 * library item — so the underlying screen keeps its scroll position.
 */
export function sheet({ title, body, actions = [], onClose }) {
  const backdrop = el('div', { class: 'sheet-backdrop' });
  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  panel.append(
    el('div', { class: 'sheet-head' }, [
      el('h2', {}, title),
      el('button', { class: 'btn icon', 'aria-label': 'Close', onclick: close }, '✕'),
    ]),
  );
  panel.append(body);
  if (actions.length) panel.append(el('div', { class: 'row gap', style: { marginTop: '1rem' } }, actions));

  backdrop.append(panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);

  // Focus the first control so a keyboard user is not stranded behind the sheet.
  panel.querySelector('input, textarea, button:not([aria-label="Close"])')?.focus();

  return { close, panel };
}

/** A row of tappable chips. `options` is [{ value, label }]. */
export function chips({ options, value = null, multiple = false, onChange }) {
  const selected = new Set(multiple ? (value || []) : (value === null ? [] : [value]));
  const wrap = el('div', { class: 'chips' });

  for (const option of options) {
    const btn = el('button', {
      type: 'button',
      class: `chip${selected.has(option.value) ? ' on' : ''}`,
      onclick: () => {
        if (multiple) {
          if (selected.has(option.value)) selected.delete(option.value);
          else selected.add(option.value);
        } else {
          selected.clear();
          selected.add(option.value);
        }
        for (const [val, node] of nodes) node.classList.toggle('on', selected.has(val));
        onChange?.(multiple ? [...selected] : [...selected][0] ?? null);
      },
    }, option.label);
    wrap.append(btn);
  }

  const nodes = new Map([...wrap.children].map((node, i) => [options[i].value, node]));
  return wrap;
}

/** Empty-state text. Neutral by design: it states a fact, it does not prod. */
export function empty(message) {
  return el('p', { class: 'empty' }, message);
}

/** Section heading used between cards. */
export function sectionTitle(text) {
  return el('h2', { class: 'section-title' }, text);
}

/**
 * Wrap an async handler so a button disables itself while it runs.
 * Double-tapping "Finish session" on a slow connection should not save twice.
 */
export function once(button, handler) {
  return async (event) => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await handler(event);
    } finally {
      button.disabled = false;
    }
  };
}

/** A button whose click handler is async and self-disabling. */
export function asyncButton(label, className, handler) {
  const btn = el('button', { class: className, type: 'button' }, label);
  btn.addEventListener('click', once(btn, handler));
  return btn;
}

export { el, clear };
