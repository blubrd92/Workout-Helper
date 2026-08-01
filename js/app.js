/**
 * Boot, authentication, and routing.
 *
 * Deliberately the only file that touches the page shell in index.html. Views own
 * everything inside <main>, and know nothing about each other.
 *
 * Note the dynamic imports: this module imports nothing from Firebase at the top
 * level, so if the SDK fails to load (offline first visit, blocked CDN) the page can
 * say so plainly instead of showing a permanently blank screen. Views are imported
 * on first navigation for the same reason — the Today screen should not wait on the
 * code for Settings.
 */

import { $, el, clear, toast } from './util.js';
import { HOUSE } from './config.js';

/**
 * The house color is defined once, in js/config.js, and pushed into CSS here so
 * there is exactly one place to change it. styles.css derives its border and wash
 * shades from this value's intent, not its literal text, so those two stay
 * hand-tuned alongside it.
 */
document.documentElement.style.setProperty('--house', HOUSE);
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', HOUSE);

const boot = $('#boot');
const signedOut = $('#signed-out');
const signedIn = $('#signed-in');
const viewRoot = $('#view');
const viewTitle = $('#view-title');

// Route name -> loader. Adding a screen means adding a line here and a tab in
// index.html; nothing else in this file needs to change.
const ROUTES = {
  today: () => import('./views/today.js'),
  food: () => import('./views/food.js'),
  history: () => import('./views/history.js'),
  progress: () => import('./views/progress.js'),
  settings: () => import('./views/settings.js'),
  onboard: () => import('./views/onboard.js'),
};
const DEFAULT_ROUTE = 'today';

let fb = null;     // the firebase module, once loaded
let store = null;  // the store module, once loaded
let booted = false;

// ---------------------------------------------------------------- boot

async function start() {
  try {
    fb = await import('./firebase.js');
  } catch (err) {
    console.error(err);
    showBootError(
      'Could not load Firebase.',
      'This is the one part of Ledger that needs the network on first load. Check your connection and reload.',
    );
    return;
  }

  if (!fb.isConfigured) {
    $('#auth-config-warning').hidden = false;
    $('#google-signin').disabled = true;
  }

  store = await import('./store.js');

  wireAuthScreen();
  wireConnectionFlag();

  // A redirect sign-in (the fallback when popups are blocked) lands back here.
  fb.getRedirectResult(fb.auth).catch((err) => showAuthError(friendlyAuthError(err)));

  fb.onAuthStateChanged(fb.auth, onAuthChange);
}

function showBootError(headline, detail) {
  clear(boot, [
    el('div', { class: 'auth-card' }, [
      el('h1', { class: 'wordmark' }, 'Ledger'),
      el('p', { class: 'error' }, headline),
      el('p', { class: 'small muted' }, detail),
      el('button', { class: 'btn primary block', onclick: () => location.reload() }, 'Reload'),
    ]),
  ]);
  boot.hidden = false;
}

async function onAuthChange(user) {
  boot.hidden = true;

  if (!user) {
    signedIn.hidden = true;
    signedOut.hidden = false;
    store.clearCache();
    booted = false;
    return;
  }

  signedOut.hidden = true;
  signedIn.hidden = false;

  if (!booted) {
    booted = true;
    try {
      const { created } = await store.ensureUser();
      const plan = await store.getActivePlan();
      // A new account, or one whose plan was wiped, starts at the plan chooser
      // rather than at an empty Today screen with nothing to log against.
      if ((created || !plan) && currentRoute().name !== 'onboard') {
        location.hash = '#/onboard';
      }
    } catch (err) {
      console.error(err);
      // A migration failure must not be papered over — see js/migrations.js.
      clear(viewRoot, [
        el('div', { class: 'card' }, [
          el('p', { class: 'error' }, err.message),
        ]),
      ]);
      return;
    }
  }

  render();
}

// ---------------------------------------------------------------- routing

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  const name = parts[0] || DEFAULT_ROUTE;
  return { name: ROUTES[name] ? name : DEFAULT_ROUTE, params: parts.slice(1) };
}

let renderToken = 0;

async function render() {
  if (!fb?.auth?.currentUser) return;

  const { name, params } = currentRoute();
  const token = ++renderToken;

  markActiveTab(name);
  clear(viewRoot, el('p', { class: 'empty' }, 'Loading…'));

  try {
    const view = await ROUTES[name]();
    if (token !== renderToken) return; // a newer navigation won the race

    viewTitle.textContent = view.title || 'Ledger';
    clear(viewRoot);
    await view.render(viewRoot, params, { navigate, rerender: render });
    if (token === renderToken) viewRoot.scrollTop = 0;
  } catch (err) {
    console.error(err);
    if (token !== renderToken) return;
    clear(viewRoot, [
      el('div', { class: 'card' }, [
        el('p', { class: 'error' }, err.message || 'Something went wrong loading this screen.'),
        el('button', { class: 'btn', onclick: render }, 'Try again'),
      ]),
    ]);
  }
}

function markActiveTab(name) {
  for (const a of document.querySelectorAll('.tabbar a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/** Navigate. Views call this rather than touching location directly. */
function navigate(path) {
  const next = path.startsWith('#') ? path : `#${path}`;
  if (location.hash === next) render();
  else location.hash = next;
}

window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- connection flag

/**
 * The offline badge is informational, never a blocker. Firestore's local cache
 * means logging works the same either way; this only tells the user why their
 * phone is quiet.
 */
function wireConnectionFlag() {
  const flag = $('#offline-flag');
  const update = () => { flag.hidden = navigator.onLine; };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ---------------------------------------------------------------- auth screen

function wireAuthScreen() {
  const googleBtn = $('#google-signin');
  const form = $('#email-form');
  const emailInput = $('#email');
  const passwordInput = $('#password');

  googleBtn.addEventListener('click', async () => {
    showAuthError(null);
    googleBtn.disabled = true;
    const provider = new fb.GoogleAuthProvider();
    try {
      await fb.signInWithPopup(fb.auth, provider);
    } catch (err) {
      // Popups are routinely blocked in mobile browsers and in-app webviews.
      // Redirect is the fallback, not the default, because it loses page state.
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request']
        .includes(err.code)) {
        try {
          await fb.signInWithRedirect(fb.auth, provider);
          return;
        } catch (redirectErr) {
          showAuthError(friendlyAuthError(redirectErr));
        }
      } else if (err.code !== 'auth/popup-closed-by-user') {
        showAuthError(friendlyAuthError(err));
      }
    } finally {
      googleBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showAuthError(null);
    try {
      await fb.signInWithEmailAndPassword(fb.auth, emailInput.value.trim(), passwordInput.value);
    } catch (err) {
      showAuthError(friendlyAuthError(err));
    }
  });

  $('#email-signup').addEventListener('click', async () => {
    showAuthError(null);
    try {
      await fb.createUserWithEmailAndPassword(fb.auth, emailInput.value.trim(), passwordInput.value);
    } catch (err) {
      showAuthError(friendlyAuthError(err));
    }
  });

  $('#forgot').addEventListener('click', async () => {
    const address = emailInput.value.trim();
    if (!address) {
      showAuthError('Enter your email address first, then tap "Forgot password".');
      return;
    }
    try {
      await fb.sendPasswordResetEmail(fb.auth, address);
      showAuthError(null);
      toast('Password reset email sent.');
    } catch (err) {
      showAuthError(friendlyAuthError(err));
    }
  });
}

function showAuthError(message) {
  const node = $('#auth-error');
  node.textContent = message || '';
  node.hidden = !message;
}

/** Firebase error codes are precise and unreadable. Translate the common ones. */
function friendlyAuthError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'auth/invalid-email': return 'That email address does not look right.';
    case 'auth/missing-password': return 'Enter a password.';
    case 'auth/weak-password': return 'Passwords need to be at least 6 characters.';
    case 'auth/email-already-in-use': return 'That email already has an account. Sign in instead.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Email or password is wrong.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed': return 'No connection. Signing in is the one thing that needs the network.';
    case 'auth/unauthorized-domain': return 'This domain is not in the Firebase Auth authorized list. See SETUP.md.';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
      return 'The Firebase config in firebase-config.js is not valid. See SETUP.md.';
    case 'auth/operation-not-allowed': return 'That sign-in method is not enabled in the Firebase console. See SETUP.md.';
    default: return err?.message || 'Sign-in failed.';
  }
}

// Exposed for the Settings screen, which owns sign-out and account deletion but
// should not import the auth plumbing itself.
export function getAuthModule() { return fb; }

start();
