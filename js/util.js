/**
 * Small helpers: DOM building, dates, formatting.
 * No framework, so this file is the closest thing to one. It stays small on purpose.
 */

import { DAY_NAMES, MONTH_NAMES } from './config.js';

// ---------------------------------------------------------------- DOM

/**
 * Build an element.
 *
 *   el('button', { class: 'primary', onclick: save }, 'Save')
 *   el('div', { class: 'row' }, [labelEl, inputEl])
 *
 * Text is always set via textContent, never innerHTML. That is deliberate: food
 * names, plan names, and session notes are user text, and this app never has to
 * think about escaping because it never builds HTML from strings.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v; // only ever used with literals in this codebase
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace an element's contents. */
export function clear(node, children = []) {
  node.replaceChildren();
  appendChildren(node, children);
  return node;
}

/**
 * Append children, skipping null / undefined / false.
 *
 * Use this instead of node.append(...) whenever a child is conditional:
 * the DOM's own append() stringifies null into the literal text "null", which
 * renders as visible junk rather than failing loudly.
 */
export function add(node, ...children) {
  appendChildren(node, children);
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** Brief message at the bottom of the screen. Never used to nag, only to confirm. */
let toastTimer = null;
export function toast(message) {
  let node = $('#toast');
  if (!node) {
    node = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

/**
 * A confirmation dialog that requires reading.
 * `times: 2` runs it twice with different wording — used for destructive actions
 * the spec requires be double-confirmed (wipe, delete account, import).
 */
export async function confirmDangerous(message, secondMessage) {
  if (!window.confirm(message)) return false;
  if (secondMessage && !window.confirm(secondMessage)) return false;
  return true;
}

/** Download a string as a file, no server involved. */
export function downloadFile(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke on the next tick; revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Clipboard with a fallback, because clipboard access is blocked in some contexts. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let okResult = false;
    try { okResult = document.execCommand('copy'); } catch { okResult = false; }
    ta.remove();
    return okResult;
  }
}

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------- dates
//
// Every date in this app is a local-timezone 'YYYY-MM-DD' string, never a
// timestamp. A session logged at 11pm belongs to that day, not to tomorrow in UTC,
// and a stored day key must mean the same thing in any timezone the user travels
// to. Date objects appear only inside these helpers.

/** Today as YYYY-MM-DD, in the device's timezone. */
export function todayISO() {
  return toISO(new Date());
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse YYYY-MM-DD into a local-noon Date. Noon avoids DST edges shifting the day. */
export function fromISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

export function isValidISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
  const d = fromISO(iso);
  return toISO(d) === iso;
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function dayOfWeek(iso) {
  return fromISO(iso).getDay(); // 0 = Sunday
}

/** First day of the week containing `iso`, honouring the user's week-start setting. */
export function startOfWeek(iso, weekStart = 0) {
  const dow = dayOfWeek(iso);
  const back = (dow - weekStart + 7) % 7;
  return addDays(iso, -back);
}

/** "Mon 4 Aug" — compact enough for a phone list row. */
export function formatDate(iso) {
  const d = fromISO(iso);
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}

/** "Monday, 4 August 2026" — for detail headers. */
export function formatDateLong(iso) {
  const d = fromISO(iso);
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${full[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Today", "Yesterday", or a formatted date. Used in lists where recency matters. */
export function relativeDate(iso) {
  const today = todayISO();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return formatDate(iso);
}

/** First and last ISO dates of a month, given a 'YYYY-MM' string. */
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const last = new Date(y, m, 0, 12);
  return { start: toISO(first), end: toISO(last) };
}

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Day names rotated to the user's week start, for calendar column headers. */
export function weekdayHeaders(weekStart = 0) {
  return Array.from({ length: 7 }, (_, i) => DAY_NAMES[(i + weekStart) % 7]);
}

// ---------------------------------------------------------------- numbers

/** Round to at most `places` decimals and drop trailing zeros: 152.0 -> "152". */
export function num(value, places = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return String(Number(n.toFixed(places)));
}

/** Whole number for calories; nobody wants 1847.3 kcal. */
export function kcal(value) {
  return Math.round(Number(value) || 0);
}

/** Format a tank value: 4 is stored with plus:true and reads as "4+". */
export function tankLabel(entry) {
  if (entry === null || entry === undefined) return '—';
  if (typeof entry === 'object') {
    if (entry.tank === null || entry.tank === undefined) return '—';
    return `${entry.tank}${entry.plus ? '+' : ''}`;
  }
  return String(entry);
}

/** mm:ss for a rest duration. */
export function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Sum a list by a key or accessor. */
export function sumBy(list, key) {
  const get = typeof key === 'function' ? key : (item) => item[key];
  return list.reduce((total, item) => total + (Number(get(item)) || 0), 0);
}

/** Stable-ish id for locally created records. Firestore generates its own doc ids; */
/** this is for array items inside a document, which Firestore does not id for us. */
export function localId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
