/**
 * Node test runner:  npm test   (or:  node tests/run.mjs)
 *
 * No test framework, no dependencies. Exits non-zero on failure so it can be
 * wired to CI later if that is ever wanted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSuite } from './suite.js';

const here = dirname(fileURLToPath(import.meta.url));
const starter = readFileSync(join(here, '..', 'plans', 'starter.md'), 'utf8');

const results = runSuite(starter);
let failed = 0;

for (const r of results) {
  if (r.ok) {
    console.log(`  ok   ${r.name}`);
  } else {
    failed++;
    console.log(`  FAIL ${r.name}\n       ${r.message}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
