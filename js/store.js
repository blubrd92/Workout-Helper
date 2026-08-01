/**
 * All Firestore reads and writes live here.
 *
 * Layout (everything under the signed-in user's uid, enforced by firestore.rules):
 *
 *   users/{uid}                     settings, schemaVersion, activePlanId
 *   users/{uid}/plans/{planId}      parsed plan + its raw markdown source
 *   users/{uid}/sessions/{id}       one logged session
 *   users/{uid}/foods/{id}          the user's saved food library
 *   users/{uid}/meals/{id}          named bundles of foods, values copied in
 *   users/{uid}/nutrition/{date}    one doc per day: food entries + that day's weight
 *
 * Reads are kept lean: sessions are fetched by date range or by exercise, nutrition
 * by day or short range. No function here fetches a whole collection except foods
 * and meals, which are small by nature (a personal library, not a database) and are
 * cached in memory after the first read.
 */

import {
  db, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, writeBatch, auth,
} from './firebase.js';
import { SCHEMA_VERSION, DEFAULT_SETTINGS } from './config.js';
import { runMigrations } from './migrations.js';
import { exerciseKey } from './plan-parser.js';
import { todayISO, localId } from './util.js';

// ---------------------------------------------------------------- helpers

function uid() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  return user.uid;
}

const userRef = () => doc(db, 'users', uid());
const subCol = (name) => collection(db, 'users', uid(), name);
const subDoc = (name, id) => doc(db, 'users', uid(), name, id);

/**
 * Firestore rejects `undefined` anywhere in a document, and parsed plans are full
 * of optional fields that are simply absent. Strip them rather than writing nulls,
 * so an absent `load` stays absent instead of becoming a null the UI has to handle.
 */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}

function withId(snap) {
  return { id: snap.id, ...snap.data() };
}

// In-memory caches. Firestore's offline cache already makes repeat reads local, but
// these avoid re-parsing and re-sorting on every render, which matters on a phone.
let cache = { settings: null, foods: null, meals: null, plans: null };

export function clearCache() {
  cache = { settings: null, foods: null, meals: null, plans: null };
}

// ---------------------------------------------------------------- account

/**
 * Make sure the signed-in user has a root document, and bring it up to the current
 * schema version. Called once on every sign-in, before anything else reads data.
 * Returns { created, settings }.
 */
export async function ensureUser() {
  const ref = userRef();
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    const fresh = {
      schemaVersion: SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS },
      activePlanId: null,
      createdAt: todayISO(),
    };
    await setDoc(ref, fresh);
    cache.settings = fresh.settings;
    return { created: true, settings: fresh.settings };
  }

  const data = snap.data();
  const endVersion = await runMigrations({ uid: uid(), userDoc: data, db });
  if (endVersion !== data.schemaVersion) {
    await updateDoc(ref, { schemaVersion: endVersion });
  }

  // Merge over defaults so a setting added in a later build has a sane value on an
  // account created before it existed. This is the cheap half of migration.
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  settings.watchItem = { ...DEFAULT_SETTINGS.watchItem, ...(data.settings?.watchItem || {}) };
  cache.settings = settings;
  return { created: false, settings };
}

export async function getSettings() {
  if (cache.settings) return cache.settings;
  const snap = await getDoc(userRef());
  const settings = { ...DEFAULT_SETTINGS, ...(snap.data()?.settings || {}) };
  settings.watchItem = { ...DEFAULT_SETTINGS.watchItem, ...(snap.data()?.settings?.watchItem || {}) };
  cache.settings = settings;
  return settings;
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await updateDoc(userRef(), { settings: clean(next) });
  cache.settings = next;
  return next;
}

export async function getUserMeta() {
  const snap = await getDoc(userRef());
  return snap.exists() ? snap.data() : null;
}

// ---------------------------------------------------------------- plans

/**
 * Store a parsed plan and make it active.
 * Prior plans are kept — history records which plan it was logged under, and
 * deleting a plan would make old sessions unexplainable.
 */
export async function savePlan(parsed, source) {
  const ref = doc(subCol('plans'));
  const record = clean({
    name: parsed.name,
    effective: parsed.effective,
    notes: parsed.notes || '',
    sessions: parsed.sessions,
    source: source || '',
    createdAt: new Date().toISOString(),
  });
  await setDoc(ref, record);
  await updateDoc(userRef(), { activePlanId: ref.id });
  cache.plans = null;
  return { id: ref.id, ...record };
}

export async function listPlans() {
  if (cache.plans) return cache.plans;
  const snap = await getDocs(query(subCol('plans'), orderBy('effective', 'desc')));
  cache.plans = snap.docs.map(withId);
  return cache.plans;
}

export async function getPlan(planId) {
  if (!planId) return null;
  const cached = cache.plans?.find((p) => p.id === planId);
  if (cached) return cached;
  const snap = await getDoc(subDoc('plans', planId));
  return snap.exists() ? withId(snap) : null;
}

/** The plan new sessions are logged against. Null until the user picks one. */
export async function getActivePlan() {
  const meta = await getUserMeta();
  if (!meta?.activePlanId) return null;
  return getPlan(meta.activePlanId);
}

export async function setActivePlan(planId) {
  await updateDoc(userRef(), { activePlanId: planId });
}

// ---------------------------------------------------------------- sessions

/**
 * Save a logged session (new or edited).
 *
 * `exerciseKeys` is a denormalised array of normalised exercise names, written so
 * the per-exercise progression view can query with array-contains instead of
 * downloading every session and filtering in the browser.
 */
export async function saveSession(session) {
  const id = session.id || doc(subCol('sessions')).id;
  const record = clean({
    date: session.date,
    planId: session.planId || null,
    planName: session.planName || '',
    sessionName: session.sessionName,
    fallback: !!session.fallback,
    sleepHours: session.sleepHours ?? null,
    watch: session.watch || null,
    note: session.note || '',
    exercises: session.exercises || [],
    exerciseKeys: (session.exercises || []).map((ex) => exerciseKey(ex.name)),
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await setDoc(subDoc('sessions', id), record);
  return { id, ...record };
}

export async function getSession(id) {
  const snap = await getDoc(subDoc('sessions', id));
  return snap.exists() ? withId(snap) : null;
}

export async function deleteSession(id) {
  await deleteDoc(subDoc('sessions', id));
}

/** Sessions in a date range (inclusive), newest first. Used by history + calendar. */
export async function listSessions({ start, end, max = 200 } = {}) {
  const clauses = [];
  if (start) clauses.push(where('date', '>=', start));
  if (end) clauses.push(where('date', '<=', end));
  const snap = await getDocs(query(subCol('sessions'), ...clauses, orderBy('date', 'desc'), limit(max)));
  return snap.docs.map(withId);
}

/** Every session containing a given exercise, newest first. Drives the progression view. */
export async function listSessionsWithExercise(name, max = 100) {
  const key = exerciseKey(name);
  const snap = await getDocs(query(
    subCol('sessions'),
    where('exerciseKeys', 'array-contains', key),
    orderBy('date', 'desc'),
    limit(max),
  ));
  return snap.docs.map(withId);
}

/**
 * Most recent logged instance of an exercise, used to prefill loads with what was
 * actually done last time rather than what the plan said months ago.
 */
export async function lastLoadFor(name) {
  const sessions = await listSessionsWithExercise(name, 1);
  if (!sessions.length) return null;
  const key = exerciseKey(name);
  const ex = sessions[0].exercises.find((e) => exerciseKey(e.name) === key);
  return ex?.load || null;
}

// ---------------------------------------------------------------- food library

export async function listFoods() {
  if (cache.foods) return cache.foods;
  const snap = await getDocs(subCol('foods'));
  cache.foods = snap.docs.map(withId).sort(byRecentThenName);
  return cache.foods;
}

function byRecentThenName(a, b) {
  const ta = a.lastUsed || '';
  const tb = b.lastUsed || '';
  if (ta !== tb) return tb.localeCompare(ta);
  return String(a.name).localeCompare(String(b.name));
}

export async function saveFood(food) {
  const id = food.id || doc(subCol('foods')).id;
  const record = clean({
    name: String(food.name).trim(),
    kcal: Number(food.kcal) || 0,
    protein: Number(food.protein) || 0,
    serving: food.serving ? String(food.serving).trim() : '',
    lastUsed: food.lastUsed || new Date().toISOString(),
  });
  await setDoc(subDoc('foods', id), record);
  cache.foods = null;
  return { id, ...record };
}

export async function deleteFood(id) {
  await deleteDoc(subDoc('foods', id));
  cache.foods = null;
}

/** Bump a library item's recency so the quick-add row stays ordered by actual use. */
export async function touchFood(id) {
  await updateDoc(subDoc('foods', id), { lastUsed: new Date().toISOString() });
  cache.foods = null;
}

// ---------------------------------------------------------------- meals

export async function listMeals() {
  if (cache.meals) return cache.meals;
  const snap = await getDocs(subCol('meals'));
  cache.meals = snap.docs.map(withId).sort(byRecentThenName);
  return cache.meals;
}

/**
 * Save a named meal.
 *
 * Components are stored by value, not by reference to library food ids. Editing a
 * food later must not silently change what a meal logs, and logging a meal must not
 * break if a component food is deleted.
 */
export async function saveMeal(meal) {
  const id = meal.id || doc(subCol('meals')).id;
  const record = clean({
    name: String(meal.name).trim(),
    items: (meal.items || []).map((item) => ({
      name: String(item.name).trim(),
      kcal: Number(item.kcal) || 0,
      protein: Number(item.protein) || 0,
      serving: item.serving ? String(item.serving).trim() : '',
    })),
    lastUsed: meal.lastUsed || new Date().toISOString(),
  });
  await setDoc(subDoc('meals', id), record);
  cache.meals = null;
  return { id, ...record };
}

export async function deleteMeal(id) {
  await deleteDoc(subDoc('meals', id));
  cache.meals = null;
}

export async function touchMeal(id) {
  await updateDoc(subDoc('meals', id), { lastUsed: new Date().toISOString() });
  cache.meals = null;
}

// ---------------------------------------------------------------- nutrition
//
// One document per day, keyed by the date itself, so the day view is a single read
// and there is no way to end up with two documents for one day.
//
// Weight lives in this document too rather than in its own collection: weight is
// entered alongside food, on the same screen, on the same day — one doc means one
// read and one write. Documented in README.md under "Data model".

const emptyDay = (date) => ({ date, entries: [], weight: null });

export async function getDay(date) {
  const snap = await getDoc(subDoc('nutrition', date));
  return snap.exists() ? { id: date, ...emptyDay(date), ...snap.data() } : { id: date, ...emptyDay(date) };
}

async function writeDay(day) {
  await setDoc(subDoc('nutrition', day.date), clean({
    date: day.date,
    entries: day.entries || [],
    weight: day.weight ?? null,
  }));
  return day;
}

/**
 * Add food entries to a day.
 *
 * Entries copy their own calories and protein rather than pointing at a library
 * item. That is the whole reason editing a saved food never rewrites history: the
 * numbers on a logged day are a snapshot of what was eaten, not a live lookup.
 */
export async function addEntries(date, entries) {
  const day = await getDay(date);
  const stamped = entries.map((e) => ({
    id: localId(),
    label: String(e.label ?? e.name).trim(),
    kcal: Number(e.kcal) || 0,
    protein: Number(e.protein) || 0,
    serving: e.serving ? String(e.serving).trim() : '',
    at: new Date().toISOString(),
  }));
  day.entries = [...(day.entries || []), ...stamped];
  await writeDay(day);
  return day;
}

export async function updateEntry(date, entryId, changes) {
  const day = await getDay(date);
  day.entries = (day.entries || []).map((e) => (e.id === entryId ? { ...e, ...changes } : e));
  await writeDay(day);
  return day;
}

export async function removeEntry(date, entryId) {
  const day = await getDay(date);
  day.entries = (day.entries || []).filter((e) => e.id !== entryId);
  await writeDay(day);
  return day;
}

export async function setWeight(date, value, unit) {
  const day = await getDay(date);
  day.weight = value === null || value === '' ? null : { value: Number(value), unit };
  await writeDay(day);
  return day;
}

/** Nutrition documents in a date range, oldest first. Used for weekly averages and export. */
export async function listDays(start, end, max = 400) {
  const snap = await getDocs(query(
    subCol('nutrition'),
    where('date', '>=', start),
    where('date', '<=', end),
    orderBy('date', 'asc'),
    limit(max),
  ));
  return snap.docs.map((s) => ({ id: s.id, ...emptyDay(s.id), ...s.data() }));
}

// ---------------------------------------------------------------- bulk ops

const ALL_COLLECTIONS = ['plans', 'sessions', 'foods', 'meals', 'nutrition'];

/** Every document the user owns. Used by export and by delete-account. */
export async function readEverything() {
  const meta = await getUserMeta();
  const out = { meta, collections: {} };
  for (const name of ALL_COLLECTIONS) {
    const snap = await getDocs(subCol(name));
    out.collections[name] = snap.docs.map(withId);
  }
  return out;
}

/**
 * Delete every document under the user, in batches.
 * Firestore has no "delete a collection" call — subcollections are not removed with
 * their parent — so this walks them explicitly. Missing one would leave orphaned
 * data behind after an account deletion, which is exactly what must not happen.
 */
export async function deleteEverything({ includeUserDoc = false } = {}) {
  for (const name of ALL_COLLECTIONS) {
    // Page through so a large history does not exceed the 500-write batch limit.
    for (;;) {
      const snap = await getDocs(query(subCol(name), limit(400)));
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < 400) break;
    }
  }
  if (includeUserDoc) {
    await deleteDoc(userRef());
  } else {
    await updateDoc(userRef(), { activePlanId: null });
  }
  clearCache();
}

/**
 * Restore a JSON backup into the signed-in account.
 * Replaces everything: a restore that merged with existing data would produce a
 * mixture that matches neither the backup nor what was there, which is worse than
 * either. The caller confirms with the user first.
 */
export async function restoreBackup(backup) {
  if (!backup || typeof backup !== 'object' || !backup.collections) {
    throw new Error('That file does not look like a Ledger backup.');
  }
  await deleteEverything({ includeUserDoc: false });

  for (const name of ALL_COLLECTIONS) {
    const docs = backup.collections[name] || [];
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const record of docs.slice(i, i + 400)) {
        const { id, ...rest } = record;
        batch.set(subDoc(name, id || localId()), clean(rest));
      }
      await batch.commit();
    }
  }

  const settings = { ...DEFAULT_SETTINGS, ...(backup.meta?.settings || {}) };
  await setDoc(userRef(), clean({
    schemaVersion: backup.meta?.schemaVersion || SCHEMA_VERSION,
    settings,
    activePlanId: backup.meta?.activePlanId || null,
    createdAt: backup.meta?.createdAt || todayISO(),
  }));
  clearCache();
}
