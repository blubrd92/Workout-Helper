/**
 * Firebase web configuration.
 *
 * REPLACE THE PLACEHOLDER VALUES BELOW with the config from your Firebase project:
 *   Firebase console → Project settings → General → Your apps → Web app → SDK setup
 * SETUP.md walks through creating the project and every setting to pick.
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
  apiKey: 'REPLACE_ME_apiKey',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

/** True while the placeholders are still in place, so the app can say so plainly. */
export const isConfigured = !String(firebaseConfig.projectId).startsWith('REPLACE_ME');
