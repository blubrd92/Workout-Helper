/** Stand-in for firebase-app.js. See tests/browser/README.md. */
export function initializeApp(config) {
  return { name: '[DEFAULT]', options: config };
}
