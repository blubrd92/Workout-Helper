# Ledger plan format

This is the file format Ledger reads when you paste or upload a training plan
(Settings → Plan). It is plain markdown, written to be readable by a person and
parseable by about 200 lines of vanilla JavaScript (`js/plan-parser.js`).

**If you are an AI coach generating a plan for this app: this document is the
whole specification. A file that follows it will import cleanly.**

---

## Complete example

```markdown
# Plan: Example Plan
Effective: 2026-07-20
Notes: Weeks 1-2 are deliberately easy: 2 sets per exercise, stop with 3-4 reps in the tank.

## Session: Home A
- name: Goblet Squat
  load: KB 20 (handle + 6s)
  sets: 2
  target: 8-12 reps
  rest: 120
  cues: heels down, chest proud, sit between hips, knees over toes
  video: https://www.youtube.com/watch?v=sFvas9RkSlc
- name: Kettlebell RDL
  load: KB 31 (handle + 6s + 5.5s)
  sets: 2
  target: 5-8 reps, knees-only depth, 3s down
  rest: 120
  cues: hips back, bell grazes thighs, back long, hamstrings end the rep
  video: https://www.youtube.com/watch?v=Uc5rP5xs7qQ

## Session: Home B
- name: One-Arm Row
  load: KB 20
  sets: 3
  target: 8-10 reps
  rest: 90
  per_side: true
  cues: pull to the hip, ribs down
- name: Dead Hang
  load: bodyweight
  sets: 2
  target: max hold
  rest: 90
  type: seconds
  cues: grip hard, shoulders set
```

---

## Structure

A plan file has three parts, in this order.

### 1. Title line (required, exactly one)

```
# Plan: Starter (Bodyweight)
```

Everything after `# Plan:` is the plan's name, shown in the app. One plan per
file — a second `# Plan:` line is an error.

### 2. Header fields (before the first session)

| Field       | Required | Format                                          |
|-------------|----------|-------------------------------------------------|
| `Effective` | yes      | `YYYY-MM-DD`. The date the plan starts applying. |
| `Notes`     | no       | Free text. Repeat the line for multiple paragraphs; they are joined with newlines. |

```
Effective: 2026-07-25
Notes: Two sets per exercise, stopping a few reps short of failure.
Notes: Deload week 5.
```

No other header fields are recognised; an unknown one is a parse error rather
than being ignored, so a typo surfaces immediately instead of silently dropping
information.

### 3. Sessions

```
## Session: Full Body A
```

One heading per session, then the exercises for it. Session names must be
unique within a plan — they are how you pick a workout on the Today screen.
Name them however you actually think of them (`Gym`, `Home A`, `Push`,
`Full Body A`); the app makes no assumptions.

### 4. Exercises

Each exercise starts with a `- name:` list item, followed by indented
`key: value` lines:

```
- name: Push-Up
  load: floor or elevated (counter, chair, stairs)
  sets: 2
  target: 8-12 reps
  rest: 90
  cues: body in one line, elbows about 45 degrees, chest leads
```

| Field      | Required | Type                | Notes |
|------------|----------|---------------------|-------|
| `name`     | **yes**  | text                | Must be the first line of the exercise, on the `-` bullet. |
| `sets`     | **yes**  | whole number 1–20   | How many sets the app renders entry rows for. |
| `target`   | **yes**  | free text           | Rep ranges, depth notes, tempo notes all live here. Never parsed, only displayed. |
| `rest`     | **yes**  | whole number, seconds | 0–3600. |
| `load`     | no       | free text           | Prefills the load field, editable per session. Free text on purpose: `KB 20 (handle + 6s)`, `chair height`, `bodyweight`. |
| `cues`     | no       | free text           | Shown small under the exercise. |
| `video`    | no       | URL                 | Opens in a new tab. A value that isn't `http(s)://` produces a warning and is not linked. |
| `per_side` | no       | `true` / `false`    | Marks a unilateral exercise. Left and right are then logged separately, every set. Defaults to `false`. |
| `type`     | no       | `reps` / `seconds`  | `seconds` marks a timed exercise (dead hangs, planks) so entry asks for a duration. Defaults to `reps`. |

`per_side` and `type: seconds` combine — a side plank is both, and the app will
ask for a left duration and a right duration per set.

---

## Rules and gotchas

- **Indentation is cosmetic.** The parser trims every line. Two spaces is the
  convention because it reads well, but it is not required.
- **Only the first colon splits a line.** So values may contain colons freely —
  URLs and `target: 8 reps, tempo 3:1` both work.
- **Field order within an exercise does not matter.** The table above is just
  the conventional order.
- **A field may only appear once per exercise.** Setting `sets` twice is an
  error, not a last-one-wins.
- **Blank lines are ignored** anywhere, and `<!-- html comments -->` are skipped,
  so you can leave yourself notes that the app will not display.
- **A wrapping ` ```markdown ` code fence is tolerated**, because plans usually
  arrive pasted out of a chat window.
- **Errors are reported all at once, with line numbers.** The Settings screen
  lists every problem in the file rather than making you fix them one per
  attempt. Nothing is imported until the file parses cleanly.

## What the app does with a plan

- The active plan's session names populate the Today screen's session picker.
- `load` prefills, `target` and `cues` display, `video` links.
- Every logged session records the id of the plan it was logged under, so
  history stays truthful after you switch plans. Old plans are kept, never
  deleted.
- Changing a plan never rewrites already-logged sessions.
