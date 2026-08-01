/**
 * Stand-in for firebase-auth.js.
 *
 * Reports a signed-in test user immediately, so the smoke test exercises the app
 * rather than the sign-in screen. See tests/browser/README.md.
 */

const listeners = [];
let currentUser = {
  uid: 'test-user',
  email: 'test@example.com',
  displayName: 'Test User',
  providerData: [{ providerId: 'password' }],
};

const auth = {
  get currentUser() { return currentUser; },
};

export function getAuth() { return auth; }

export function onAuthStateChanged(_auth, callback) {
  listeners.push(callback);
  // Async, like the real SDK, so boot ordering is exercised honestly.
  setTimeout(() => callback(currentUser), 0);
  return () => {};
}

export function setPersistence() { return Promise.resolve(); }
export const browserLocalPersistence = { type: 'LOCAL' };
export function getRedirectResult() { return Promise.resolve(null); }

export class GoogleAuthProvider {}
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };

export function signInWithPopup() { return Promise.resolve({ user: currentUser }); }
export function signInWithRedirect() { return Promise.resolve(); }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: currentUser }); }
export function createUserWithEmailAndPassword() { return Promise.resolve({ user: currentUser }); }
export function sendPasswordResetEmail() { return Promise.resolve(); }

export function signOut() {
  currentUser = null;
  listeners.forEach((l) => l(null));
  return Promise.resolve();
}

export function deleteUser() { return signOut(); }
export function reauthenticateWithPopup() { return Promise.resolve(); }
export function reauthenticateWithCredential() { return Promise.resolve(); }
