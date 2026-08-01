/**
 * Set entries: their shape, and how they read as text.
 *
 * One set entry looks like one of:
 *
 *   { value: 10, tank: 2, plus: false }                  a normal set
 *   { value: 45, tank: null, plus: false }               a timed set (value is seconds)
 *   { left: {…}, right: {…} }                            a per-side exercise
 *
 * `value` is reps, or seconds when the exercise is `type: seconds`.
 * `tank` is reps-left-in-the-tank: 0–4, where 4 carries plus:true and reads "4+".
 * Storing 4+ as the number 4 plus a flag keeps the value numerically comparable
 * (so "was I closer to failure this week?" is answerable) while still displaying
 * the honest "4+".
 *
 * null means "not logged", which is different from zero. A set left blank stays
 * blank forever; it is not backfilled or guessed at.
 */

export const blankSide = () => ({ value: null, tank: null, plus: false });

export function blankEntry(exercise) {
  return exercise.perSide
    ? { left: blankSide(), right: blankSide() }
    : blankSide();
}

/** Build the entry array a freshly opened exercise card starts with. */
export function blankEntries(exercise) {
  return Array.from({ length: exercise.sets || 1 }, () => blankEntry(exercise));
}

export function isSideLogged(side) {
  return !!side && side.value !== null && side.value !== undefined && side.value !== '';
}

/** Has anything at all been entered for this set? */
export function isEntryLogged(entry) {
  if (!entry) return false;
  if (entry.left || entry.right) return isSideLogged(entry.left) || isSideLogged(entry.right);
  return isSideLogged(entry);
}

export function countLoggedSets(exercise) {
  return (exercise.entries || []).filter(isEntryLogged).length;
}

/** "10 @2" / "45s @1" / "12" when no tank was recorded. */
export function describeSide(side, exercise) {
  if (!isSideLogged(side)) return '—';
  const unit = exercise?.type === 'seconds' ? 's' : '';
  const reps = `${side.value}${unit}`;
  if (side.tank === null || side.tank === undefined) return reps;
  return `${reps} @${side.tank}${side.plus ? '+' : ''}`;
}

/** One set as text: "10 @2", or "L 10 @2 · R 9 @3" for per-side exercises. */
export function describeSet(entry, exercise) {
  if (!entry) return '—';
  if (exercise?.perSide || entry.left || entry.right) {
    return `L ${describeSide(entry.left, exercise)} · R ${describeSide(entry.right, exercise)}`;
  }
  return describeSide(entry, exercise);
}

/** Every logged set of an exercise, as text. Used by tables, detail views and export. */
export function describeSets(exercise) {
  return (exercise.entries || [])
    .map((entry, i) => ({ set: i + 1, text: describeSet(entry, exercise), logged: isEntryLogged(entry) }))
    .filter((s) => s.logged);
}

/** Sensible step for the value stepper: 5 seconds for timed work, 1 rep otherwise. */
export function valueStep(exercise) {
  return exercise?.type === 'seconds' ? 5 : 1;
}

export function valueLabel(exercise) {
  return exercise?.type === 'seconds' ? 'Seconds' : 'Reps';
}
