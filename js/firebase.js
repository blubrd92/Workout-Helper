/**
 * Firebase bootstrap.
 *
 * The one exception to this project's "no external dependencies" rule is the
 * official Firebase JS SDK, loaded as ES modules from Google's CDN.
 *
 * Why dynamic import() rather than a normal static import: it lets the SDK version
 * live in exactly one place (the constant below) instead of being repeated in a
 * dozen import URLs across the codebase. To upgrade, change SDK_VERSION and test.
 * Release notes: https://firebase.google.com/support/release-notes/js
 *
 * This module re-exports the handful of SDK functions the app actually uses, so
 * the rest of the code imports from './firebase.js' and never touches a CDN URL.
 */

import { firebaseConfig, isConfigured } from '../firebase-config.js';

const SDK_VERSION = '10.12.2';
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

// Top-level await: this module resolves only once the SDK is loaded, so anything
// importing it can assume `db` and `auth` are ready.
const appMod = await import(`${CDN}/firebase-app.js`);
const authMod = await import(`${CDN}/firebase-auth.js`);
const dbMod = await import(`${CDN}/firebase-firestore.js`);

const app = appMod.initializeApp(firebaseConfig);

/**
 * Firestore with offline persistence turned on.
 *
 * This is the setting that makes mid-workout logging work in a gym basement:
 * reads are served from a local IndexedDB cache and writes are queued locally and
 * flushed when a connection returns. Nothing in the logging path waits on the
 * network.
 *
 * persistentMultipleTabManager keeps that cache coherent if the app is open in
 * more than one tab, which otherwise throws and silently disables persistence.
 * Some browsers (private windows, ancient versions, blocked storage) refuse
 * IndexedDB entirely — hence the fallback to a memory cache, where the app still
 * works for the session but loses its offline superpower.
 */
let db;
try {
  db = dbMod.initializeFirestore(app, {
    localCache: dbMod.persistentLocalCache({
      tabManager: dbMod.persistentMultipleTabManager(),
    }),
  });
} catch (err) {
  console.warn('Offline persistence unavailable, falling back to in-memory cache.', err);
  db = dbMod.getFirestore(app);
}

const auth = authMod.getAuth(app);
// Keep the user signed in across visits; this is a personal log, not a bank.
await authMod.setPersistence(auth, authMod.browserLocalPersistence).catch(() => {});

export { app, db, auth, isConfigured, SDK_VERSION };

// --- Auth API ---------------------------------------------------------------
export const {
  GoogleAuthProvider,
  EmailAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  deleteUser,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
} = authMod;

// --- Firestore API ----------------------------------------------------------
export const {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  serverTimestamp,
  documentId,
} = dbMod;
