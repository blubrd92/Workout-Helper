/**
 * Plan markdown parser.
 *
 * Deliberately hand-rolled: the plan format is a tiny, fixed subset of markdown,
 * so a real markdown library would be a dependency (and a CDN request) for no gain.
 * The format is documented in PLAN_FORMAT.md — if you change anything here, change
 * that file too.
 *
 * This module is pure: no DOM, no Firebase, no imports. That is what lets the same
 * code run in the browser and under Node in tests/.
 */

// Fields an exercise may carry, and how each one is converted from its raw string.
// Keeping this as data (rather than a chain of if-statements) means adding a field
// later is a one-line change here plus a line in PLAN_FORMAT.md.
const EXERCISE_FIELDS = {
  name:     { key: 'name',    required: true,  parse: (v) => v },
  load:     { key: 'load',    required: false, parse: (v) => v },
  sets:     { key: 'sets',    required: true,  parse: parseCount },
  target:   { key: 'target',  required: true,  parse: (v) => v },
  rest:     { key: 'rest',    required: true,  parse: parseSeconds },
  cues:     { key: 'cues',    required: false, parse: (v) => v },
  video:    { key: 'video',   required: false, parse: (v) => v },
  per_side: { key: 'perSide', required: false, parse: parseBool },
  type:     { key: 'type',    required: false, parse: parseType },
};

function parseCount(v) {
  if (!/^\d+$/.test(v)) throw new Error(`expected a whole number, got "${v}"`);
  const n = Number(v);
  if (n < 1) throw new Error('must be at least 1');
  if (n > 20) throw new Error('more than 20 sets is almost certainly a typo');
  return n;
}

function parseSeconds(v) {
  if (!/^\d+$/.test(v)) throw new Error(`expected seconds as a whole number, got "${v}"`);
  const n = Number(v);
  if (n > 3600) throw new Error('rest longer than an hour is almost certainly a typo');
  return n;
}

function parseBool(v) {
  const s = v.toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  throw new Error(`expected true or false, got "${v}"`);
}

function parseType(v) {
  const s = v.toLowerCase();
  if (s === 'reps' || s === 'seconds') return s;
  throw new Error(`expected "reps" or "seconds", got "${v}"`);
}

/**
 * Strip a wrapping code fence if the pasted text has one.
 * People copy plans out of a chat window, and chat windows hand back ```markdown
 * fences. Silently tolerating that is worth the six lines.
 */
function stripFence(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  if (start < end && /^```/.test(lines[start].trim()) && lines[end - 1].trim() === '```') {
    // Keep the original line numbering meaningful by blanking the fences in place
    // rather than removing them, so reported line numbers match what the user pasted.
    lines[start] = '';
    lines[end - 1] = '';
  }
  return lines;
}

/**
 * Parse plan markdown.
 *
 * Always returns an object rather than throwing, because the caller (the Settings
 * paste box) wants to show every problem at once, with line numbers, instead of
 * making the user fix one error per attempt.
 *
 * @param {string} text raw markdown
 * @returns {{ok: boolean, plan: object|null, errors: Array<{line: number, message: string}>, warnings: Array<{line: number, message: string}>}}
 */
export function parsePlan(text) {
  const errors = [];
  const warnings = [];
  const err = (line, message) => errors.push({ line, message });
  const warn = (line, message) => warnings.push({ line, message });

  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, plan: null, errors: [{ line: 1, message: 'The plan is empty.' }], warnings };
  }

  const lines = stripFence(text);
  const plan = { name: null, effective: null, notes: '', sessions: [] };

  let session = null;   // session currently being filled
  let exercise = null;  // exercise currently being filled
  let exerciseLine = 0; // line the current exercise started on, for error messages
  let seenHeader = false;

  // Close out the exercise under construction, validating required fields.
  const flushExercise = () => {
    if (!exercise) return;
    for (const [field, spec] of Object.entries(EXERCISE_FIELDS)) {
      if (spec.required && exercise[spec.key] === undefined) {
        err(exerciseLine, `Exercise "${exercise.name || '(unnamed)'}" is missing required field "${field}".`);
      }
    }
    if (exercise.type === undefined) exercise.type = 'reps';
    if (exercise.perSide === undefined) exercise.perSide = false;
    session.exercises.push(exercise);
    exercise = null;
  };

  const flushSession = () => {
    flushExercise();
    if (session) {
      if (session.exercises.length === 0) {
        warn(session.line, `Session "${session.name}" has no exercises.`);
      }
      plan.sessions.push({ name: session.name, exercises: session.exercises });
      session = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (trimmed === '') continue;
    if (trimmed.startsWith('<!--')) continue; // allow html comments as scratch notes

    // --- Plan title -------------------------------------------------------
    const title = /^#\s+Plan:\s*(.+)$/i.exec(trimmed);
    if (title) {
      if (seenHeader) {
        err(lineNo, 'A file may only contain one "# Plan:" line. Split multiple plans into separate files.');
        continue;
      }
      plan.name = title[1].trim();
      seenHeader = true;
      continue;
    }

    // --- Session heading --------------------------------------------------
    const sessionHeading = /^##\s+Session:\s*(.+)$/i.exec(trimmed);
    if (sessionHeading) {
      flushSession();
      const name = sessionHeading[1].trim();
      if (plan.sessions.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        err(lineNo, `Two sessions are both named "${name}". Session names must be unique within a plan.`);
      }
      session = { name, exercises: [], line: lineNo };
      continue;
    }

    // --- Exercise list item: "- name: Something" --------------------------
    const listItem = /^-\s+(.+)$/.exec(trimmed);
    if (listItem) {
      if (!session) {
        err(lineNo, 'Exercise found before any "## Session:" heading.');
        continue;
      }
      flushExercise();
      exerciseLine = lineNo;
      exercise = {};
      const pair = splitPair(listItem[1]);
      if (!pair || pair.key !== 'name') {
        err(lineNo, 'An exercise must start with "- name: <exercise name>".');
        // Keep going with an empty exercise so later field lines still attach somewhere
        // and produce useful messages instead of a cascade of "before any exercise".
        continue;
      }
      if (pair.value === '') err(lineNo, 'Exercise name is empty.');
      exercise.name = pair.value;
      continue;
    }

    // --- key: value line --------------------------------------------------
    const pair = splitPair(trimmed);
    if (!pair) {
      err(lineNo, `Could not understand this line: "${truncate(trimmed)}"`);
      continue;
    }

    // Header fields (before the first session) vs exercise fields (inside one).
    if (!session) {
      const key = pair.key.toLowerCase();
      if (key === 'effective') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pair.value)) {
          err(lineNo, `Effective date must be YYYY-MM-DD, got "${pair.value}".`);
        } else if (Number.isNaN(Date.parse(`${pair.value}T00:00:00`))) {
          err(lineNo, `"${pair.value}" is not a real date.`);
        } else {
          plan.effective = pair.value;
        }
      } else if (key === 'notes') {
        plan.notes = plan.notes ? `${plan.notes}\n${pair.value}` : pair.value;
      } else {
        err(lineNo, `Unknown plan field "${pair.key}". The header supports "Effective" and "Notes".`);
      }
      continue;
    }

    if (!exercise) {
      err(lineNo, `Field "${pair.key}" appears outside any exercise. Exercise fields must follow a "- name:" line.`);
      continue;
    }

    const spec = EXERCISE_FIELDS[pair.key.toLowerCase()];
    if (!spec) {
      err(lineNo, `Unknown exercise field "${pair.key}". Supported: ${Object.keys(EXERCISE_FIELDS).join(', ')}.`);
      continue;
    }
    if (spec.key === 'name') {
      err(lineNo, 'A second "name:" line inside one exercise. Start a new exercise with "- name: ...".');
      continue;
    }
    if (exercise[spec.key] !== undefined) {
      err(lineNo, `Field "${pair.key}" is set twice on exercise "${exercise.name}".`);
      continue;
    }
    if (pair.value === '') {
      err(lineNo, `Field "${pair.key}" has no value.`);
      continue;
    }
    try {
      exercise[spec.key] = spec.parse(pair.value);
    } catch (e) {
      err(lineNo, `Field "${pair.key}" on "${exercise.name}": ${e.message}`);
    }
    if (spec.key === 'video' && !/^https?:\/\//i.test(pair.value)) {
      warn(lineNo, `Video link on "${exercise.name}" does not look like a URL; it will not be shown as a link.`);
    }
  }

  flushSession();

  // --- whole-file requirements -------------------------------------------
  if (!plan.name) err(1, 'Missing the plan title line: "# Plan: <name>".');
  if (!plan.effective) err(1, 'Missing the effective date line: "Effective: YYYY-MM-DD".');
  if (plan.sessions.length === 0) err(1, 'The plan has no sessions. Add at least one "## Session: <name>".');

  errors.sort((a, b) => a.line - b.line);
  return { ok: errors.length === 0, plan: errors.length === 0 ? plan : null, errors, warnings };
}

/**
 * Split "key: value" on the FIRST colon only.
 * Values routinely contain colons (video URLs, "tempo: 3s down"), so a greedy
 * split would mangle them.
 */
function splitPair(s) {
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  const key = s.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: s.slice(idx + 1).trim() };
}

function truncate(s, n = 60) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Render a parsed plan back to markdown.
 * Used by the export/backup path so a plan can always be recovered as a file even
 * if the original raw source is somehow missing. Output must round-trip through
 * parsePlan() unchanged — tests/ checks exactly that.
 */
export function planToMarkdown(plan) {
  const out = [`# Plan: ${plan.name}`, `Effective: ${plan.effective}`];
  if (plan.notes) {
    for (const line of String(plan.notes).split('\n')) out.push(`Notes: ${line}`);
  }
  for (const session of plan.sessions) {
    out.push('', `## Session: ${session.name}`);
    for (const ex of session.exercises) {
      out.push(`- name: ${ex.name}`);
      if (ex.load) out.push(`  load: ${ex.load}`);
      out.push(`  sets: ${ex.sets}`);
      out.push(`  target: ${ex.target}`);
      out.push(`  rest: ${ex.rest}`);
      if (ex.perSide) out.push('  per_side: true');
      if (ex.type === 'seconds') out.push('  type: seconds');
      if (ex.cues) out.push(`  cues: ${ex.cues}`);
      if (ex.video) out.push(`  video: ${ex.video}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * A stable id for an exercise, used to group the same movement across sessions and
 * plans in the progression view. Name-based on purpose: if the coach renames
 * "Push-Up" to "Push Up", that is a different row, and silently merging them would
 * be worse than showing two.
 */
export function exerciseKey(name) {
  return String(name).toLowerCase().replace(/\s+/g, ' ').trim();
}
