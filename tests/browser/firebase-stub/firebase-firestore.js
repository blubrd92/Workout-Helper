/**
 * Stand-in for firebase-firestore.js: an in-memory Firestore.
 *
 * It implements exactly the surface js/store.js uses, and only the query operators
 * this app issues (>=, <=, ==, array-contains, orderBy, limit). It is a test
 * double, not an emulator — it does not enforce security rules, and it is not
 * evidence that the real rules work. See tests/rules/ for that.
 */

/**
 * Documents are held in a Map and mirrored to sessionStorage, so a page reload
 * keeps the data. Without that, the "does an in-progress session survive a
 * reload?" check would be testing the stub's amnesia rather than the app.
 */
const STORAGE_KEY = '__ledger_stub_firestore';

const DATA = new Map(load()); // full document path -> plain object
let idCounter = 0;

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...DATA.entries()]));
  } catch { /* nothing to do in a test double */ }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export function initializeFirestore() { return { __db: true }; }
export function getFirestore() { return { __db: true }; }
export function persistentLocalCache() { return { kind: 'persistent' }; }
export function persistentMultipleTabManager() { return { kind: 'multi-tab' }; }
export function serverTimestamp() { return new Date().toISOString(); }
export function documentId() { return '__name__'; }

export function collection(_db, ...segments) {
  const path = segments.join('/');
  return { __col: true, path, id: segments[segments.length - 1] };
}

export function doc(dbOrCollection, ...segments) {
  // doc(collectionRef) — generate an id, the way the real SDK does.
  if (dbOrCollection && dbOrCollection.__col) {
    const id = `auto${++idCounter}`;
    return { __doc: true, path: `${dbOrCollection.path}/${id}`, id };
  }
  const path = segments.join('/');
  return { __doc: true, path, id: segments[segments.length - 1] };
}

export async function getDoc(ref) {
  const data = DATA.get(ref.path);
  return {
    id: ref.id,
    ref,
    exists: () => data !== undefined,
    data: () => clone(data),
  };
}

export async function setDoc(ref, data) { DATA.set(ref.path, clone(data)); persist(); }

export async function updateDoc(ref, changes) {
  const current = DATA.get(ref.path);
  if (current === undefined) {
    // Matches the real SDK, which rejects updates to missing documents.
    throw new Error(`No document to update: ${ref.path}`);
  }
  DATA.set(ref.path, { ...current, ...clone(changes) });
  persist();
}

export async function deleteDoc(ref) { DATA.delete(ref.path); persist(); }

export function query(col, ...constraints) { return { __q: true, col, constraints }; }
export function where(field, op, value) { return { type: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc') { return { type: 'orderBy', field, dir }; }
export function limit(n) { return { type: 'limit', n }; }

export async function getDocs(target) {
  const q = target.__q ? target : { col: target, constraints: [] };
  const prefix = `${q.col.path}/`;

  let rows = [...DATA.entries()]
    // Direct children only — a Firestore query never reaches into subcollections.
    .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(([path, data]) => ({ id: path.slice(prefix.length), path, data }));

  for (const c of q.constraints) {
    if (c.type !== 'where') continue;
    rows = rows.filter(({ data }) => {
      const value = data[c.field];
      switch (c.op) {
        case '>=': return value >= c.value;
        case '<=': return value <= c.value;
        case '==': return value === c.value;
        case 'array-contains': return Array.isArray(value) && value.includes(c.value);
        default: throw new Error(`Stub does not implement the "${c.op}" operator.`);
      }
    });
  }

  const order = q.constraints.find((c) => c.type === 'orderBy');
  if (order) {
    rows.sort((a, b) => {
      const x = a.data[order.field];
      const y = b.data[order.field];
      const result = x < y ? -1 : x > y ? 1 : 0;
      return order.dir === 'desc' ? -result : result;
    });
  }

  const cap = q.constraints.find((c) => c.type === 'limit');
  if (cap) rows = rows.slice(0, cap.n);

  const docs = rows.map((row) => ({
    id: row.id,
    ref: { __doc: true, path: row.path, id: row.id },
    exists: () => true,
    data: () => clone(row.data),
  }));

  return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
}

export function writeBatch() {
  const ops = [];
  return {
    set: (ref, data) => ops.push(() => DATA.set(ref.path, clone(data))),
    delete: (ref) => ops.push(() => DATA.delete(ref.path)),
    update: (ref, changes) => ops.push(() => DATA.set(ref.path, { ...DATA.get(ref.path), ...clone(changes) })),
    commit: async () => { ops.forEach((op) => op()); persist(); },
  };
}
