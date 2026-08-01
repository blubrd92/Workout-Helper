/**
 * Plan parser test suite.
 *
 * Dependency-free on purpose: the app has no build step and no package manager,
 * so tests are plain functions that run identically under Node (tests/run.mjs)
 * and in a browser (tests/index.html).
 *
 * The suite takes the starter plan's text as an argument because the two runners
 * load it differently (fs vs fetch).
 */

import { parsePlan, planToMarkdown, exerciseKey } from '../js/plan-parser.js';

export function runSuite(starterMarkdown) {
  const results = [];
  const test = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, message: e.message });
    }
  };
  const eq = (actual, expected, what = '') => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what || 'value'}: expected ${b}, got ${a}`);
  };
  const ok = (cond, what) => { if (!cond) throw new Error(what || 'expected truthy'); };

  // ---------------------------------------------------------------- starter
  // The spec's instruction is explicit: test the parser against the seed plan
  // before building UI on top of it. These are those tests.

  test('starter plan parses without errors', () => {
    const r = parsePlan(starterMarkdown);
    if (!r.ok) throw new Error(r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
    eq(r.warnings, [], 'warnings');
  });

  test('starter plan header', () => {
    const { plan } = parsePlan(starterMarkdown);
    eq(plan.name, 'Starter (Bodyweight)', 'name');
    eq(plan.effective, '2026-07-25', 'effective');
    ok(plan.notes.startsWith('A minimal placeholder'), 'notes text');
  });

  test('starter plan has two sessions with the expected exercise counts', () => {
    const { plan } = parsePlan(starterMarkdown);
    eq(plan.sessions.map((s) => s.name), ['Full Body A', 'Full Body B'], 'session names');
    eq(plan.sessions.map((s) => s.exercises.length), [7, 7], 'exercise counts');
  });

  test('starter plan field typing: numbers are numbers, flags are booleans', () => {
    const { plan } = parsePlan(starterMarkdown);
    const squat = plan.sessions[0].exercises[0];
    eq(squat.name, 'Bodyweight Squat', 'name');
    eq(squat.sets, 2, 'sets');
    eq(squat.rest, 90, 'rest');
    eq(squat.type, 'reps', 'default type');
    eq(squat.perSide, false, 'default per_side');
    eq(squat.load, undefined, 'absent load stays absent');

    const hang = plan.sessions[0].exercises[5];
    eq(hang.name, 'Dead Hang or Doorframe Pull', 'timed exercise name');
    eq(hang.type, 'seconds', 'type: seconds');

    const deadBug = plan.sessions[0].exercises[6];
    eq(deadBug.perSide, true, 'per_side: true');
  });

  test('starter plan handles an exercise that is both per_side and timed', () => {
    const { plan } = parsePlan(starterMarkdown);
    const sidePlank = plan.sessions[1].exercises[6];
    eq(sidePlank.name, 'Side Plank', 'name');
    eq(sidePlank.perSide, true, 'per_side');
    eq(sidePlank.type, 'seconds', 'type');
  });

  test('starter plan round-trips through planToMarkdown', () => {
    const first = parsePlan(starterMarkdown);
    const second = parsePlan(planToMarkdown(first.plan));
    ok(second.ok, 'regenerated markdown should re-parse');
    eq(second.plan, first.plan, 'round-tripped plan');
  });

  // ------------------------------------------------------------ format bits

  test('values may contain colons and commas', () => {
    const r = parsePlan([
      '# Plan: Colons',
      'Effective: 2026-01-01',
      '## Session: A',
      '- name: Goblet Squat',
      '  load: KB 20 (handle + 6s)',
      '  sets: 2',
      '  target: 8-12 reps, 3s down',
      '  rest: 120',
      '  cues: heels down, chest proud',
      '  video: https://www.youtube.com/watch?v=sFvas9RkSlc',
    ].join('\n'));
    ok(r.ok, r.errors.map((e) => e.message).join('; '));
    const ex = r.plan.sessions[0].exercises[0];
    eq(ex.video, 'https://www.youtube.com/watch?v=sFvas9RkSlc', 'url kept whole');
    eq(ex.target, '8-12 reps, 3s down', 'target free text');
    eq(ex.load, 'KB 20 (handle + 6s)', 'load free text');
  });

  test('a pasted ```markdown fence is tolerated', () => {
    const r = parsePlan([
      '```markdown',
      '# Plan: Fenced',
      'Effective: 2026-01-01',
      '## Session: A',
      '- name: Push-Up',
      '  sets: 2',
      '  target: 8 reps',
      '  rest: 90',
      '```',
    ].join('\n'));
    ok(r.ok, r.errors.map((e) => e.message).join('; '));
    eq(r.plan.name, 'Fenced', 'name');
  });

  test('multiple Notes lines join with newlines', () => {
    const r = parsePlan([
      '# Plan: Notes',
      'Effective: 2026-01-01',
      'Notes: first',
      'Notes: second',
      '## Session: A',
      '- name: X',
      '  sets: 1',
      '  target: 5',
      '  rest: 60',
    ].join('\n'));
    eq(r.plan.notes, 'first\nsecond', 'notes');
  });

  // ---------------------------------------------------------------- errors
  // Parse errors are shown to the user with line numbers, so the line numbers
  // are part of the contract and are asserted here.

  const errorCase = (name, lines, expect) => test(name, () => {
    const r = parsePlan(lines.join('\n'));
    ok(!r.ok, 'expected parse to fail');
    expect(r.errors, r);
  });

  errorCase('missing title', [
    'Effective: 2026-01-01',
    '## Session: A',
    '- name: X',
    '  sets: 1',
    '  target: 5',
    '  rest: 60',
  ], (errors) => ok(errors.some((e) => /# Plan:/.test(e.message)), 'should complain about the title'));

  errorCase('missing effective date', [
    '# Plan: X',
    '## Session: A',
    '- name: X',
    '  sets: 1',
    '  target: 5',
    '  rest: 60',
  ], (errors) => ok(errors.some((e) => /Effective/.test(e.message)), 'should complain about Effective'));

  errorCase('bad effective date format', [
    '# Plan: X',
    'Effective: July 20 2026',
    '## Session: A',
    '- name: X',
    '  sets: 1',
    '  target: 5',
    '  rest: 60',
  ], (errors) => {
    ok(errors.some((e) => e.line === 2 && /YYYY-MM-DD/.test(e.message)), 'line 2, format message');
  });

  errorCase('missing required exercise field reports the exercise line', [
    '# Plan: X',
    'Effective: 2026-01-01',
    '## Session: A',
    '- name: Squat',
    '  sets: 2',
    '  rest: 90',
  ], (errors) => {
    const e = errors.find((x) => /missing required field "target"/.test(x.message));
    ok(e, 'target reported missing');
    eq(e.line, 4, 'reported at the "- name:" line');
  });

  errorCase('non-numeric sets', [
    '# Plan: X',
    'Effective: 2026-01-01',
    '## Session: A',
    '- name: Squat',
    '  sets: two',
    '  target: 8',
    '  rest: 90',
  ], (errors) => ok(errors.some((e) => e.line === 5 && /whole number/.test(e.message)), 'line 5'));

  errorCase('unknown field name', [
    '# Plan: X',
    'Effective: 2026-01-01',
    '## Session: A',
    '- name: Squat',
    '  tempo: 3s',
    '  sets: 2',
    '  target: 8',
    '  rest: 90',
  ], (errors) => ok(errors.some((e) => e.line === 5 && /Unknown exercise field/.test(e.message)), 'line 5'));

  errorCase('exercise before any session heading', [
    '# Plan: X',
    'Effective: 2026-01-01',
    '- name: Squat',
    '  sets: 2',
    '  target: 8',
    '  rest: 90',
  ], (errors) => ok(errors.some((e) => /before any "## Session:"/.test(e.message)), 'orphan exercise'));

  errorCase('duplicate session names', [
    '# Plan: X',
    'Effective: 2026-01-01',
    '## Session: A',
    '- name: Squat',
    '  sets: 2',
    '  target: 8',
    '  rest: 90',
    '## Session: A',
    '- name: Row',
    '  sets: 2',
    '  target: 8',
    '  rest: 90',
  ], (errors) => ok(errors.some((e) => /must be unique/.test(e.message)), 'duplicate name'));

  errorCase('empty input', [''], (errors) => ok(errors.length === 1, 'single clear error'));

  errorCase('every problem is reported at once, not one at a time', [
    '# Plan: X',
    'Effective: nope',
    '## Session: A',
    '- name: Squat',
    '  sets: many',
    '  target: 8',
    '  rest: 90',
  ], (errors) => ok(errors.length >= 2, `expected several errors, got ${errors.length}`));

  test('a bad per_side value is an error, not a silent false', () => {
    const r = parsePlan([
      '# Plan: X',
      'Effective: 2026-01-01',
      '## Session: A',
      '- name: Row',
      '  sets: 2',
      '  target: 8',
      '  rest: 90',
      '  per_side: sometimes',
    ].join('\n'));
    ok(!r.ok, 'should fail');
    ok(r.errors.some((e) => /true or false/.test(e.message)), 'message');
  });

  test('a non-URL video is a warning, not an error', () => {
    const r = parsePlan([
      '# Plan: X',
      'Effective: 2026-01-01',
      '## Session: A',
      '- name: Row',
      '  sets: 2',
      '  target: 8',
      '  rest: 90',
      '  video: ask me',
    ].join('\n'));
    ok(r.ok, 'still parses');
    eq(r.warnings.length, 1, 'one warning');
  });

  // ------------------------------------------------------------ exerciseKey

  test('exerciseKey normalises whitespace and case but not punctuation', () => {
    eq(exerciseKey('  Push-Up  '), 'push-up', 'trim + lowercase');
    eq(exerciseKey('Dead  Bug'), 'dead bug', 'collapse spaces');
    ok(exerciseKey('Push-Up') !== exerciseKey('Push Up'), 'hyphen is significant');
  });

  return results;
}
