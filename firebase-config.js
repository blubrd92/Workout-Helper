/**
 * Firebase web configuration.
 *
 * These are the values from Firebase console → Project settings → General →
 * Your apps → Web app → SDK setup. If you ever re-copy them from the console,
 * keep the `export` keywords below — the console's snippet omits them, and
 * js/firebase.js imports both names from this file.
 *
 * These values are public by design. A Firebase web config identifies your project;
 * it is not a secret and is not a credential. Every Firebase web app ships it in the
 * browser. What actually protects your data is Firestore security rules
 * (firestore.rules in this repo), which is why those rules deny everything except a
 * signed-in user reading and writing their own documents.
 *
 * The only key in this project that IS secret is the USDA API key, and it never
 * appears in the browser — it lives as a GitHub repository secret used by the
 * "build food data" workflow. See SETUP.md.
 */

export const firebaseConfig = {
  apiKey: 'AIzaSyA0AWjQf6eLP5PSI2tHy-4SYmjsPb_WHm4',
  authDomain: 'ledger-defa0.firebaseapp.com',
  projectId: 'ledger-defa0',
  storageBucket: 'ledger-defa0.firebasestorage.app',
  messagingSenderId: '639920297299',
  appId: '1:639920297299:web:764a5d594590a05d9efda6',
};

/** True once real values are in place, so the app can say so plainly if not. */
export const isConfigured = !String(firebaseConfig.projectId).startsWith('REPLACE_ME');
