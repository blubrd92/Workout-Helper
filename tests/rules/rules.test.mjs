/**
 * Firestore security rules tests.
 *
 * The claim these rules make is narrow and absolute: a signed-in user can read and
 * write documents under users/{their own uid}, and nothing else. This file tries to
 * break that claim from every direction — another user's documents, another user's
 * subcollections, listing across accounts, and unauthenticated access.
 *
 * ── How to run ────────────────────────────────────────────────────────────────
 *
 *   npm install --no-save @firebase/rules-unit-testing
 *   npx firebase emulators:exec --only firestore "node tests/rules/rules.test.mjs"
 *
 * Requires the Firebase CLI (npm i -g firebase-tools) and a JDK, which the
 * Firestore emulator needs. Both are one-time installs.
 *
 * ── Honest status ─────────────────────────────────────────────────────────────
 *
 * These tests were written against the rules in firestore.rules but have NOT been
 * executed — the environment this project was built in had no network access to
 * install the emulator or the test package. Run them once before trusting the
 * rules with real data. If any assertion here fails, the rules are wrong and the
 * test is right.
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(join(HERE, '..', '..', 'firestore.rules'), 'utf8');

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let passed = 0;
let failed = 0;

async function it(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: 'ledger-rules-test',
  firestore: { rules: RULES },
});

// Seed one document per user, bypassing the rules, so the read tests have
// something real to fail to read.
await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, 'users', ALICE), { schemaVersion: 1, settings: {} });
  await setDoc(doc(db, 'users', ALICE, 'sessions', 's1'), { date: '2026-08-01', sessionName: 'Full Body A' });
  await setDoc(doc(db, 'users', ALICE, 'nutrition', '2026-08-01'), { date: '2026-08-01', entries: [] });
  await setDoc(doc(db, 'users', BOB), { schemaVersion: 1, settings: {} });
  await setDoc(doc(db, 'users', BOB, 'sessions', 's1'), { date: '2026-08-01', sessionName: 'Home A' });
});

const alice = testEnv.authenticatedContext(ALICE).firestore();
const bob = testEnv.authenticatedContext(BOB).firestore();
const nobody = testEnv.unauthenticatedContext().firestore();

console.log('\nOwn data — must be allowed');

await it('read own root document', () => assertSucceeds(getDoc(doc(alice, 'users', ALICE))));
await it('write own root document', () =>
  assertSucceeds(setDoc(doc(alice, 'users', ALICE), { schemaVersion: 1, settings: { kcalTarget: 2300 } })));
await it('read own session', () => assertSucceeds(getDoc(doc(alice, 'users', ALICE, 'sessions', 's1'))));
await it('create own session', () =>
  assertSucceeds(setDoc(doc(alice, 'users', ALICE, 'sessions', 's2'), { date: '2026-08-03', sessionName: 'Full Body B' })));
await it('delete own session', () => assertSucceeds(deleteDoc(doc(alice, 'users', ALICE, 'sessions', 's2'))));
await it('list own sessions', () => assertSucceeds(getDocs(collection(alice, 'users', ALICE, 'sessions'))));
await it('write own food library entry', () =>
  assertSucceeds(setDoc(doc(alice, 'users', ALICE, 'foods', 'f1'), { name: 'Oats', kcal: 150, protein: 5.3 })));
await it('write own nutrition day', () =>
  assertSucceeds(setDoc(doc(alice, 'users', ALICE, 'nutrition', '2026-08-02'), { date: '2026-08-02', entries: [] })));
await it('write own plan', () =>
  assertSucceeds(setDoc(doc(alice, 'users', ALICE, 'plans', 'p1'), { name: 'Mine', effective: '2026-08-01', sessions: [] })));

console.log("\nAnother account's data — must be denied");

await it("cannot read another user's root document", () =>
  assertFails(getDoc(doc(bob, 'users', ALICE))));
await it("cannot write another user's root document", () =>
  assertFails(setDoc(doc(bob, 'users', ALICE), { schemaVersion: 99 })));
await it("cannot read another user's session", () =>
  assertFails(getDoc(doc(bob, 'users', ALICE, 'sessions', 's1'))));
await it("cannot write into another user's sessions", () =>
  assertFails(setDoc(doc(bob, 'users', ALICE, 'sessions', 'injected'), { date: '2026-08-01' })));
await it("cannot delete another user's session", () =>
  assertFails(deleteDoc(doc(bob, 'users', ALICE, 'sessions', 's1'))));
await it("cannot list another user's sessions", () =>
  assertFails(getDocs(collection(bob, 'users', ALICE, 'sessions'))));
await it("cannot read another user's nutrition day", () =>
  assertFails(getDoc(doc(bob, 'users', ALICE, 'nutrition', '2026-08-01'))));
await it("cannot list another user's food library", () =>
  assertFails(getDocs(collection(bob, 'users', ALICE, 'foods'))));
await it('cannot list the users collection itself', () =>
  assertFails(getDocs(collection(bob, 'users'))));

console.log('\nSigned out — must be denied');

await it('cannot read any user document', () => assertFails(getDoc(doc(nobody, 'users', ALICE))));
await it('cannot write any user document', () =>
  assertFails(setDoc(doc(nobody, 'users', ALICE), { schemaVersion: 1 })));
await it('cannot read a session', () => assertFails(getDoc(doc(nobody, 'users', ALICE, 'sessions', 's1'))));
await it('cannot create a document under a new uid', () =>
  assertFails(setDoc(doc(nobody, 'users', 'made-up-uid'), { schemaVersion: 1 })));

console.log('\nOutside the user tree — must be denied');

await it('cannot read an arbitrary top-level collection', () =>
  assertFails(getDoc(doc(alice, 'anything', 'doc1'))));
await it('cannot write an arbitrary top-level collection', () =>
  assertFails(setDoc(doc(alice, 'anything', 'doc1'), { x: 1 })));

await testEnv.cleanup();

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
