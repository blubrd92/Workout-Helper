/**
 * End-to-end smoke test.
 *
 * Serves the repo, opens it in Chromium at a 390px-wide viewport (the primary
 * target from the spec), swaps Firebase's CDN modules for the in-memory stubs in
 * firebase-stub/, and walks the app the way a person would: choose a plan, log a
 * session, read it back in history and on the progression table, log food, check
 * settings.
 *
 * It fails on any uncaught page error or console error, so a typo in a rarely
 * visited branch does not sit undiscovered.
 *
 *   node tests/browser/smoke.mjs            headless
 *   node tests/browser/smoke.mjs --shots    also write screenshots to screens/
 *
 * Playwright is not a project dependency — the app has none. The runner picks it
 * up from a global install and skips politely if it is not there.
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const STUBS = join(HERE, 'firebase-stub');
const SHOTS = join(HERE, 'screens');
const PORT = 8123;
const WRITE_SHOTS = process.argv.includes('--shots');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------- harness

const failures = [];
let currentStep = '(startup)';

function step(name) { currentStep = name; console.log(`\n▸ ${name}`); }
function pass(what) { console.log(`  ok   ${what}`); }
function fail(what, detail) {
  failures.push(`${currentStep}: ${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`);
}

async function check(what, fn) {
  try {
    const result = await fn();
    if (result === false) fail(what);
    else pass(what);
  } catch (err) {
    fail(what, err.message);
  }
}

// ---------------------------------------------------------------- static server

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      let path = join(ROOT, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname.endsWith('/')) path = join(path, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

// ---------------------------------------------------------------- main

async function loadPlaywright() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const entry = join(globalRoot, 'playwright', 'index.js');
    if (!existsSync(entry)) return null;
    // Playwright is CommonJS; imported from ESM its exports may land on .default.
    const mod = await import(pathToFileURL(entry).href);
    return mod.chromium ? mod : mod.default;
  } catch {
    return null;
  }
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.log('Playwright is not installed; skipping the browser smoke test.');
    console.log('Install it globally (npm i -g playwright) to run this.');
    process.exit(0);
  }

  const server = await startServer();
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // the primary target from the spec
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`));
  // Every confirm() in the app is a deliberate guard; accept them so the flow runs.
  page.on('dialog', (dialog) => dialog.accept('test'));

  // Swap the Firebase CDN modules for the local stubs.
  await page.route('https://www.gstatic.com/firebasejs/**', async (route) => {
    const name = route.request().url().split('/').pop();
    const body = await readFile(join(STUBS, name), 'utf8');
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body,
    });
  });

  const shot = async (name) => {
    if (!WRITE_SHOTS) return;
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };

  try {
    await run(page, shot);
  } finally {
    if (consoleErrors.length) {
      currentStep = 'console';
      for (const message of consoleErrors) fail('console error', message);
    } else {
      console.log('\n  ok   no console errors or uncaught exceptions');
    }
    await browser.close();
    server.close();
  }

  console.log(failures.length ? `\n${failures.length} failure(s):` : '\nAll checks passed.');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------- the walkthrough

async function run(page, shot) {
  // ---- boot into the plan chooser
  step('New account lands on the plan chooser');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Pick a starting point', { timeout: 10000 });
  await check('onboarding is shown', async () => page.isVisible('text=Pick a starting point'));
  await check('the starter plan is labelled a placeholder', async () =>
    (await page.textContent('body')).includes('not a recommendation'));
  await shot('01-onboard');

  // ---- adopt the bundled starter plan
  step('Adopting the bundled starter plan');
  await page.click('text=Use the starter plan');
  await page.waitForSelector('text=Full Body A', { timeout: 10000 });
  await check('both starter sessions are offered', async () =>
    (await page.isVisible('text=Full Body A')) && (await page.isVisible('text=Full Body B')));
  await shot('02-session-picker');

  // ---- log a session
  step('Logging a session');
  await page.click('button:has-text("Full Body A")');
  await page.waitForSelector('text=Bodyweight Squat');
  await check('exercise cards render', async () =>
    (await page.locator('.exercise').count()) === 7);
  await check('per-side exercise shows L and R', async () =>
    (await page.locator('.side-label', { hasText: 'L' }).count()) > 0);
  await check('timed exercise asks for seconds', async () =>
    (await page.locator('.set-row', { hasText: 'sec' }).count()) > 0);
  await check('each set is one bounded block, numbered once', async () => {
    // The starter plan's first exercise is 2 sets, so exactly 2 blocks and 2 heads.
    const card = page.locator('.exercise').first();
    return (await card.locator('.set-group').count()) === 2
      && (await card.locator('.set-head').count()) === 2;
  });
  await check('a per-side set keeps both sides in one block', async () => {
    // Dead Bug: 2 sets, per side -> 2 blocks, each holding an L and an R.
    const card = page.locator('.exercise').last();
    return (await card.locator('.set-group').count()) === 2
      && (await card.locator('.set-group').first().locator('.side-label').count()) === 2;
  });
  await check('every tank control is labelled where it is used', async () => {
    const tanks = await page.locator('.tank-row .segmented').count();
    const labels = await page.locator('.tank-row .tank-label').count();
    if (tanks !== labels) throw new Error(`${tanks} tank controls, ${labels} labels`);
    return tanks > 0;
  });

  await page.fill('input[type="text"][aria-label="Load for Bodyweight Squat"]', 'bodyweight');

  // First exercise, first set: 10 reps via the stepper, tank 2.
  const firstCard = page.locator('.exercise').first();
  const plus = firstCard.locator('.stepper button', { hasText: '+' }).first();
  for (let i = 0; i < 10; i++) await plus.click();
  await firstCard.locator('.tank-row .segmented button', { hasText: '2' }).first().click();
  await check('stepper reached 10', async () =>
    (await firstCard.locator('.stepper input').first().inputValue()) === '10');
  await check('stepper fields do not clip their value', async () => {
    // A three-digit value has to fit: a timed hold is entered in seconds.
    const clipped = await page.evaluate(() => {
      const input = document.querySelector('.stepper input');
      input.value = '120';
      const bad = input.scrollWidth > input.clientWidth + 1;
      input.value = '';
      return bad;
    });
    if (clipped) throw new Error('three digits overflow the stepper field');
    return true;
  });

  // Second set on the same exercise, typed rather than tapped.
  await firstCard.locator('.stepper input').nth(1).fill('9');
  await firstCard.locator('.tank-row .segmented button', { hasText: '1' }).nth(1).click();
  await shot('03-logging');

  // Ticking an exercise folds it to a summary; expanding is separate from
  // un-ticking it.
  await firstCard.locator('.check').click();
  await check('the completion check toggles', async () =>
    (await firstCard.locator('.check').getAttribute('aria-pressed')) === 'true');
  await check('a ticked exercise folds away', async () =>
    firstCard.locator('.exercise-body').isHidden());
  await check('the fold shows what was logged', async () =>
    (await firstCard.locator('.exercise-summary').textContent()).includes('10 @2'));

  await firstCard.locator('.exercise-summary').click();
  await check('tapping the summary expands it again', async () =>
    firstCard.locator('.exercise-body').isVisible());
  await check('expanding does not un-tick the exercise', async () =>
    (await firstCard.locator('.check').getAttribute('aria-pressed')) === 'true');

  // ---- the draft survives a reload
  step('The in-progress session survives a reload');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.exercise', { timeout: 10000 });
  await check('reps are still there after reload', async () =>
    (await page.locator('.exercise').first().locator('.stepper input')
      .first().inputValue()) === '10');

  step('Finishing the session');
  await page.click('button:has-text("Finish session")');
  await page.waitForSelector('text=Logged under', { timeout: 10000 });
  await check('lands on the session detail', async () =>
    (await page.textContent('body')).includes('Full Body A'));
  await check('sets read back as reps @ tank', async () =>
    (await page.textContent('.set-pill')).includes('10 @2'));
  await shot('04-session-detail');

  // ---- backfilling a past session
  step('Backfilling a session to a past date');
  await page.click('a[data-tab="today"]');
  await page.waitForSelector('input[aria-label="Date to log against"]', { timeout: 10000 });

  // Ten days back, computed the same way the app computes local dates.
  const pastDate = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

  await page.fill('input[aria-label="Date to log against"]', pastDate);
  await page.waitForSelector('.card.backfilling', { timeout: 5000 });
  await check('the banner names the date being logged to', async () =>
    (await page.textContent('.card.backfilling')).includes('will be saved to'));
  await shot('03b-backfill');

  await page.click('button:has-text("Full Body B")');
  await page.waitForSelector('.exercise');
  await check('the session carries the backfill date, not today', async () =>
    (await page.locator('input[type="date"]').first().inputValue()) === pastDate);

  const backfillCard = page.locator('.exercise').first();
  await backfillCard.locator('.stepper input').first().fill('8');
  await page.click('button:has-text("Finish session")');
  await page.waitForSelector('text=Logged under', { timeout: 10000 });
  await check('it saved to the past date', async () =>
    (await page.textContent('body')).includes(new Date(`${pastDate}T12:00:00`).getFullYear().toString()));

  await page.click('a[data-tab="today"]');
  await page.waitForSelector('input[aria-label="Date to log against"]', { timeout: 10000 });
  await check('the date stays set for the next session in the run', async () =>
    (await page.locator('input[aria-label="Date to log against"]').inputValue()) === pastDate);

  await page.click('button:has-text("Back to today")');
  await page.waitForTimeout(300);
  await check('"Back to today" clears the backfill mode', async () =>
    (await page.locator('.card.backfilling').count()) === 0);

  // ---- history
  step('History');
  await page.click('a[data-tab="history"]');
  await page.waitForSelector('.cal-grid', { timeout: 10000 });
  await check('the calendar renders', async () => (await page.locator('.cal-cell').count()) >= 28);
  await check('the logged day has a dot', async () => (await page.locator('.cal-dot').count()) >= 1);
  await check('planned days are dashed, not red', async () => {
    const planned = page.locator('.cal-cell.planned').first();
    if (await planned.count() === 0) return true; // no planned day without a session this month
    const color = await planned.evaluate((node) => getComputedStyle(node).borderTopColor);
    // Anything reddish would mean the adherence rule got broken in CSS.
    const [r, g, b] = color.match(/\d+/g).map(Number);
    return !(r > g + 40 && r > b + 40);
  });
  await shot('05-history');

  // ---- progression
  step('Progression table');
  await page.click('a[data-tab="progress"]');
  await page.waitForSelector('select', { timeout: 10000 });
  await check('a progression row exists', async () =>
    (await page.locator('table tbody tr').count()) >= 1);
  await check('the load column shows what was logged', async () =>
    (await page.textContent('table tbody')).includes('bodyweight'));
  await shot('06-progress');

  // ---- nutrition
  step('Food: manual entry, library, and search');
  await page.click('a[data-tab="food"]');
  await page.waitForSelector('button:has-text("+ Add food")', { timeout: 10000 });
  await page.click('button:has-text("+ Add food")');
  await page.waitForSelector('.sheet');

  await page.click('.sheet summary:has-text("Add by hand")');
  await page.fill('.sheet input[placeholder="e.g. protein shake"]', 'Test shake');
  await page.locator('.sheet input[type="number"]').first().fill('200');
  await page.locator('.sheet input[type="number"]').nth(1).fill('40');
  await page.click('.sheet button:has-text("Log & save")');
  await page.waitForSelector('text=Logged Test shake', { timeout: 5000 });
  await check('the manual entry was logged', async () =>
    (await page.textContent('body')).includes('Test shake'));

  // The bundled dataset should not have been fetched before a search needed it.
  await check('the common dataset is fetched lazily, not on boot', async () => {
    const fetched = await page.evaluate(() => performance.getEntriesByType('resource')
      .some((r) => r.name.includes('common-foods.json')));
    return fetched === false;
  });

  await page.fill('.sheet input[type="search"]', 'chicken');
  await page.waitForSelector('text=Common foods (USDA)', { timeout: 5000 });
  // Asserts the lazy load and search path work, NOT ranking quality — that is the
  // benchmark's job (tests/food-data.test.mjs and the search benchmark), which can
  // measure it across 27 queries instead of one string in a DOM node.
  await check('the bundled dataset returns matches', async () =>
    (await page.locator('.sheet .list-row').count()) > 1
    && /chicken/i.test(await page.textContent('.sheet')));
  await check('the dataset loaded only once the search asked for it', async () => {
    const fetched = await page.evaluate(() => performance.getEntriesByType('resource')
      .some((r) => r.name.includes('common-foods.json')));
    return fetched === true;
  });

  await page.click('.sheet button[aria-label="Close"]');
  await page.waitForSelector('.totals');
  await check('the day total reflects the entry', async () =>
    (await page.textContent('.totals')).includes('200'));
  await check('remaining is shown against the target', async () =>
    (await page.textContent('.totals')).includes('left of 2300'));
  await shot('07-food');

  // ---- weight
  step('Weight');
  await page.fill('input[placeholder^="Weight"]', '181.5');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('text=This week:', { timeout: 5000 });
  await check('the weekly average appears', async () =>
    (await page.textContent('body')).includes('181.5'));

  // ---- settings and export
  step('Settings and export');
  await page.click('a[data-tab="settings"]');
  await page.waitForSelector('text=Daily targets', { timeout: 10000 });
  await check('the active plan is listed', async () =>
    (await page.textContent('body')).includes('Starter (Bodyweight)'));
  await shot('08-settings');

  await page.click('button:has-text("Preview")');
  await page.waitForSelector('.sheet textarea', { timeout: 10000 });
  const report = await page.locator('.sheet textarea').inputValue();
  await check('the coach report contains the session', () => report.includes('Full Body A'));
  await check('the coach report contains sets with tank values', () => report.includes('10 @2'));
  await check('the coach report contains nutrition totals', () => report.includes('## Nutrition'));
  await check('the coach report contains weekly weight averages', () => report.includes('## Weight'));
  await check('the coach report does not editorialise about missed days', () =>
    !/missed|streak|adherence|failed/i.test(report));
  await page.click('.sheet button[aria-label="Close"]');
  await shot('09-report');

  // ---- stray placeholder text
  //
  // node.append(null) renders the literal string "null" rather than throwing, so a
  // conditional child that should have been skipped shows up as visible junk.
  // Sweep every screen for it.
  step('No stray null/undefined text on any screen');
  for (const tab of ['today', 'food', 'history', 'progress', 'settings']) {
    await page.click(`a[data-tab="${tab}"]`);
    await page.waitForTimeout(400);
    await check(`${tab} renders no placeholder text`, async () => {
      const text = await page.evaluate(() => document.querySelector('#view').innerText);
      const hit = /(^|\s)(null|undefined|NaN)(\s|$)/.exec(text);
      if (hit) throw new Error(`found "${hit[2]}"`);
      return true;
    });
  }

  // ---- the bottom bar must not move between tabs
  //
  // The complaint this guards against: the row appeared to shift when switching
  // tabs, because the active label changed font-weight and so changed width.
  step('The bottom bar holds still across tabs');
  const barGeometry = {};
  for (const tab of ['today', 'food', 'history', 'progress', 'settings']) {
    await page.click(`a[data-tab="${tab}"]`);
    await page.waitForTimeout(350);
    barGeometry[tab] = await page.evaluate(() => [...document.querySelectorAll('.tabbar a')].map((a) => {
      const box = a.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(a.querySelector('span'));
      const text = range.getBoundingClientRect();
      const icon = a.querySelector('svg').getBoundingClientRect();
      return {
        y: +box.y.toFixed(1), h: +box.height.toFixed(1),
        textX: +text.x.toFixed(1), iconX: +icon.x.toFixed(1),
        weight: getComputedStyle(a).fontWeight,
      };
    }));
  }
  await check('label font-weight is identical on every tab', () => {
    const weights = new Set(Object.values(barGeometry).flat().map((t) => t.weight));
    if (weights.size !== 1) throw new Error(`weights seen: ${[...weights].join(', ')}`);
    return true;
  });
  await check('icons and labels never move between tabs', () => {
    const tabs = Object.values(barGeometry);
    for (let i = 0; i < tabs[0].length; i++) {
      for (const key of ['textX', 'iconX', 'y', 'h']) {
        const values = tabs.map((t) => t[i][key]);
        const drift = Math.max(...values) - Math.min(...values);
        if (drift > 0.5) throw new Error(`tab ${i} ${key} drifts ${drift.toFixed(1)}px`);
      }
    }
    return true;
  });
  await check('the bar is opaque, so page content cannot show through', async () => {
    const style = await page.evaluate(() => {
      const bar = getComputedStyle(document.querySelector('.tabbar'));
      return { bg: bar.backgroundColor, filter: bar.backdropFilter };
    });
    if (/rgba\([^)]*,\s*0?\.\d+\)/.test(style.bg)) throw new Error(`translucent: ${style.bg}`);
    if (style.filter && style.filter !== 'none') throw new Error(`backdrop-filter: ${style.filter}`);
    return true;
  });
  await check('short screens still fill the viewport', async () => {
    // Page height swinging between screens is what makes a phone's URL bar
    // expand and collapse, moving the fixed bar with it.
    const heights = [];
    for (const tab of ['progress', 'history', 'settings']) {
      await page.click(`a[data-tab="${tab}"]`);
      await page.waitForTimeout(300);
      heights.push(await page.evaluate(() => document.documentElement.scrollHeight));
    }
    if (heights.some((h) => h < 844)) throw new Error(`heights: ${heights.join(', ')}`);
    return true;
  });
  await check('screens appear in one piece, not in stages', async () => {
    // Settings and Progress both read from Firestore. They used to append each
    // card as its own await resolved, so the page built itself in visible stages
    // and shoved content down after it was already on screen.
    // Wait on something unique to the destination — waiting on any .card matches
    // the screen you are leaving, which are still on the page for a moment.
    const marker = { settings: 'text=Daily targets', progress: 'text=Exercise progression' };
    for (const tab of ['settings', 'progress']) {
      await page.click('a[data-tab="today"]');
      await page.waitForTimeout(250);
      await page.click(`a[data-tab="${tab}"]`);
      await page.waitForSelector(marker[tab], { timeout: 5000 });
      const samples = [];
      for (let i = 0; i < 8; i++) {
        samples.push(await page.evaluate(() => document.querySelector('#view').scrollHeight));
        await page.waitForTimeout(80);
      }
      // Once the first card is on screen the page must be complete: no second
      // wave of content arriving and pushing everything down.
      const settled = samples[samples.length - 1];
      if (samples.some((h) => h !== settled)) {
        throw new Error(`${tab} height changed after first paint: ${samples.join(' -> ')}`);
      }
    }
    return true;
  });
  await shot('10-tabbar');

  // ---- layout
  step('Layout at 390px');
  await check('no horizontal overflow', async () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await check('every visible control is at least 44px tall', async () => {
    const small = await page.evaluate(() => {
      const bad = [];
      for (const node of document.querySelectorAll('button, a[data-tab], input, select')) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue; // hidden
        // A checkbox's real tap target is the label wrapping it: clicking anywhere
        // on that row toggles the box. Measure the label instead.
        const target = node.type === 'checkbox' && node.closest('label')
          ? node.closest('label').getBoundingClientRect()
          : box;
        if (target.height < 43.5) bad.push(`${node.tagName}.${node.className} ${target.height.toFixed(1)}px`);
      }
      return bad;
    });
    if (small.length) throw new Error(small.slice(0, 6).join('; '));
    return true;
  });
  if (WRITE_SHOTS) await writeFile(join(SHOTS, 'report.md'), report, 'utf8');
}

main();
