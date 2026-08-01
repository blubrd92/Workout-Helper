# Proposals

Things v1 does not do. **Nothing here is built.** Each entry is a one-line
tradeoff so you can say yes or no without re-deriving the reasoning.

The first six came from the original spec. The rest are things that surfaced while
building, listed with the same rule applied: if it was not asked for, it was not
built.

---

## From the spec

**1. Rest timer buttons on exercise cards** (90s / 120s presets, visible countdown)
Genuinely useful mid-session and the plan already carries a `rest` value per
exercise, so there is nothing to configure — but a countdown that keeps running
needs the screen awake or a notification, and both pull in scope the app currently
avoids entirely.

**2. PWA manifest + service worker** (add-to-home-screen, full offline)
Would make Ledger open like an app and work on a first visit with no signal.
Firestore already handles offline *data*; this covers the app *shell*. The cost is
a cache-invalidation story: a stale service worker serving an old build is the
classic way to ship a bug that nobody can clear.

**3. Hand-rolled inline SVG sparklines** (progression view, weight trend)
No library, just a `<polyline>` — perhaps forty lines. The weight trend is the
obvious candidate since it is one number per week. Tables stay the source of truth
either way; this would be decoration on top, which is exactly why it can wait.

**4. Dark mode via `prefers-color-scheme`**
Mostly a matter of moving the current palette into two sets of custom properties.
The catch is the house color: `#d4d9e4` is a pale fill designed for dark text on
light, and it needs a deliberate dark-mode treatment rather than an inversion.

**5. Plan sharing** (export a plan as a link or short code, importable as a template)
Plans are already exportable as markdown files from Settings, so this is a
convenience layer, not a capability. Worth noting it is the first feature that
would put one account's data in front of another person — even voluntarily — so it
deserves a deliberate yes rather than a drifted-into one.

**6. Live USDA search via a Firebase Cloud Function proxy** (branded and packaged items)
Covers exactly what the bundled dataset deliberately omits, with the USDA key held
in the function's environment so it never reaches the browser. Two costs, stated
plainly: Cloud Functions require the **Blaze pay-as-you-go plan and a linked
billing account**, though a substantial no-cost tier sits underneath it; and live
lookup introduces a network dependency nothing else in this app has, so it would
have to degrade gracefully to the offline path rather than blocking food entry.

---

## Surfaced while building

**7. A quantity multiplier on food entries** (log "2 ×" a saved food in one tap)
The most obvious typing you still have to do: logging two eggs currently means
either logging the entry twice or editing the calories by hand. A stepper next to
each search result would fix it. Left out because the spec defines a food entry as
label, calories, and protein, and adding a quantity changes that shape.

**8. Search inside your own foods and meals lists**
Fine at thirty saved foods, tedious at three hundred. The search code already
exists in `js/foods.js`; this is wiring it into the library and meals tabs.

**9. Editing a plan in the app** (rather than re-pasting the whole markdown)
Fixing one typo in a load currently means re-pasting the file. A per-exercise edit
form is the obvious fix, but it splits the source of truth: the app would then hold
a plan that no longer matches the markdown your coach generated. Re-pasting keeps
one authority.

**10. A "duplicate last session" button on the session picker**
For sessions where the loads and reps are the same as last time, pre-filling from
the last instance and adjusting would be faster than entering from blank. It edges
toward pre-filling data you did not actually do, which is worth a deliberate
decision rather than an assumption.

**11. Per-exercise notes**
Sessions have one note. Attaching a note to a specific exercise ("left shoulder
clicked on set 2") is a different and arguably more useful record — and it is the
kind of thing the watch item cannot capture because the watch item is one thing,
named in advance.

**12. Session templates independent of a plan**
Logging something not in the plan — a pickup basketball game, a long walk — has no
home today. It would either need a free-form session type or an accepted "this app
tracks the program, not everything you do".

**13. Automatic backup reminders or scheduled exports**
Data lives in one Firebase project with no automated copy. A monthly nudge to
download a JSON backup would reduce that risk — but "no notifications, reminders,
or streaks" is a stated non-goal, and a reminder is a reminder even when it is
about backups. The honest alternative is a line in the README, which is where it
is now.

**14. Running the parser tests in CI**
`npm test` is dependency-free and takes under a second. A tiny GitHub Actions
workflow on push would keep the plan parser honest for free. Not added because the
only workflow in the repo today is the manually-triggered dataset build, and
adding CI is a decision about how you want to work rather than a feature.
