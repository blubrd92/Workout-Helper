/**
 * Food — the day log, the personal library, and saved meals.
 *
 * Typing is the enemy here too. The day view leads with quick-add buttons ordered
 * by most recent use, so the foods you actually eat are one tap away and never
 * require searching for anything.
 *
 * Totals render neutrally. Over target is a number, not an alarm — the same
 * philosophy as the adherence rules on the History screen.
 */

import {
  el, clear, sectionTitle, field, segmented, sheet, empty, asyncButton,
} from '../components.js';
import * as store from '../store.js';
import { searchLibrary, searchCommon, commonStatus } from '../foods.js';
import {
  todayISO, addDays, formatDate, relativeDate, isValidISO, toast, kcal as roundKcal,
  num, sumBy, debounce, confirmDangerous, startOfWeek,
} from '../util.js';

export const title = 'Food';

let mode = 'day';
let visibleDate = todayISO();

export async function render(root, params, { rerender }) {
  const settings = await store.getSettings();

  root.append(segmented({
    value: mode,
    allowClear: false,
    options: [
      { value: 'day', label: 'Day' },
      { value: 'foods', label: 'My foods' },
      { value: 'meals', label: 'Meals' },
    ],
    onChange: (next) => { mode = next; paint(); },
  }));

  const body = el('div', { style: { marginTop: '.8rem' } });
  root.append(body);

  async function paint() {
    clear(body, empty('Loading…'));
    const target = el('div');
    clear(body, target);
    if (mode === 'day') await renderDay(target, settings, paint);
    else if (mode === 'foods') await renderLibrary(target, paint);
    else await renderMeals(target, paint);
  }

  await paint();
}

// ---------------------------------------------------------------- day

async function renderDay(root, settings, repaint) {
  const [day, foods, meals] = await Promise.all([
    store.getDay(visibleDate),
    store.listFoods(),
    store.listMeals(),
  ]);

  const totalKcal = sumBy(day.entries, 'kcal');
  const totalProtein = sumBy(day.entries, 'protein');

  // --- date navigation
  const dateInput = el('input', {
    type: 'date',
    value: visibleDate,
    'aria-label': 'Date',
    onchange: () => {
      if (isValidISO(dateInput.value)) { visibleDate = dateInput.value; repaint(); }
      else dateInput.value = visibleDate;
    },
  });

  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'row gap' }, [
      el('button', {
        class: 'btn icon', type: 'button', 'aria-label': 'Previous day',
        onclick: () => { visibleDate = addDays(visibleDate, -1); repaint(); },
      }, '‹'),
      el('div', { class: 'grow' }, dateInput),
      el('button', {
        class: 'btn icon', type: 'button', 'aria-label': 'Next day',
        onclick: () => { visibleDate = addDays(visibleDate, 1); repaint(); },
      }, '›'),
    ]),
    visibleDate !== todayISO()
      ? el('button', {
        class: 'btn link', style: { marginTop: '.2rem' },
        onclick: () => { visibleDate = todayISO(); repaint(); },
      }, 'Back to today')
      : null,
  ]));

  // --- totals
  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'totals' }, [
      totalTile('Calories', roundKcal(totalKcal), settings.kcalTarget, 'kcal'),
      totalTile('Protein', Math.round(totalProtein), settings.proteinTarget, 'g'),
    ]),
  ]));

  // --- weight
  root.append(await renderWeightCard(day, settings, repaint));

  // --- quick add, ordered by most recently used
  const quickFoods = foods.slice(0, 8);
  const quickMeals = meals.slice(0, 4);
  if (quickFoods.length || quickMeals.length) {
    root.append(sectionTitle('Quick add'));
    root.append(el('div', { class: 'card' }, [
      quickMeals.length
        ? el('div', { class: 'chips', style: { marginBottom: quickFoods.length ? '.6rem' : '0' } },
          quickMeals.map((meal) => el('button', {
            class: 'chip', type: 'button',
            onclick: async () => {
              await store.addEntries(visibleDate, meal.items.map((i) => ({ ...i, label: i.name })));
              await store.touchMeal(meal.id);
              toast(`${meal.name} logged.`);
              repaint();
            },
          }, [el('span', {}, meal.name), el('span', { class: 'faint small' }, `${meal.items.length}`)])))
        : null,
      quickFoods.length
        ? el('div', { class: 'chips' }, quickFoods.map((food) => el('button', {
          class: 'chip', type: 'button',
          onclick: async () => {
            await store.addEntries(visibleDate, [{ label: food.name, kcal: food.kcal, protein: food.protein, serving: food.serving }]);
            await store.touchFood(food.id);
            repaint();
          },
        }, [
          el('span', {}, food.name),
          el('span', { class: 'faint small' }, `${roundKcal(food.kcal)}`),
        ])))
        : null,
    ]));
  }

  // --- add
  root.append(el('button', {
    class: 'btn primary block',
    style: { marginTop: '.6rem' },
    onclick: () => openAddFoodSheet({ date: visibleDate, foods, onDone: repaint }),
  }, '+ Add food'));

  // --- entries
  root.append(sectionTitle(`Logged ${relativeDate(visibleDate).toLowerCase()}`));
  if (!day.entries.length) {
    root.append(empty('Nothing logged for this day.'));
    return;
  }

  root.append(el('ul', { class: 'list card' }, day.entries.map((entry) => el('li', {}, [
    el('button', {
      class: 'list-row',
      type: 'button',
      onclick: () => openEntrySheet({ date: visibleDate, entry, onDone: repaint }),
    }, [
      el('span', { class: 'title' }, [
        el('b', {}, entry.label),
        entry.serving ? el('span', { class: 'meta' }, entry.serving) : null,
      ]),
      el('span', { class: 'num' }, `${roundKcal(entry.kcal)} kcal · ${Math.round(entry.protein)} g`),
    ]),
  ]))));
}

/**
 * A total against its target.
 * Over target shows as a plain "+120 over" in the same muted grey as everything
 * else. No red, no warning icon, no editorialising.
 */
function totalTile(label, value, target, unit) {
  const remaining = target - value;
  return el('div', { class: 'total' }, [
    el('div', { class: 'k' }, label),
    el('div', { class: 'v' }, `${value}`),
    el('div', { class: 'sub' }, remaining >= 0
      ? `${remaining} ${unit} left of ${target}`
      : `${Math.abs(remaining)} ${unit} over ${target}`),
  ]);
}

async function renderWeightCard(day, settings, repaint) {
  const unit = settings.weightUnit || 'lb';
  const input = el('input', {
    type: 'number',
    inputmode: 'decimal',
    step: '0.1',
    min: '0',
    value: day.weight?.value ?? '',
    placeholder: `Weight (${unit})`,
    'aria-label': `Weight in ${unit}`,
  });

  const save = asyncButton('Save', 'btn', async () => {
    const raw = input.value.trim();
    await store.setWeight(visibleDate, raw === '' ? null : Number(raw), unit);
    toast(raw === '' ? 'Weight cleared.' : 'Weight saved.');
    repaint();
  });

  // The current week's average, shown here because it is the number that matters.
  // The full trend lives on the Progress screen.
  const weekStart = startOfWeek(visibleDate, settings.weekStart ?? 0);
  const week = await store.listDays(weekStart, addDays(weekStart, 6));
  const readings = week.filter((d) => d.weight && typeof d.weight.value === 'number');
  const average = readings.length ? sumBy(readings, (d) => d.weight.value) / readings.length : null;

  return el('div', { class: 'card' }, [
    el('div', { class: 'row gap' }, [el('div', { class: 'grow' }, input), save]),
    el('p', { class: 'small faint', style: { margin: '.5rem 0 0' } },
      average === null
        ? 'The weekly average is the signal; a single day is noise.'
        : `This week: ${num(average, 1)} ${unit} average from ${readings.length} reading${readings.length === 1 ? '' : 's'}.`),
  ]);
}

// ---------------------------------------------------------------- add food sheet

function openAddFoodSheet({ date, foods, onDone }) {
  const body = el('div');
  const status = el('div');
  const results = el('div');

  const search = el('input', {
    type: 'search',
    placeholder: 'Search your foods, then the common list',
    autocomplete: 'off',
    'aria-label': 'Search foods',
  });

  const logAndClose = async (item, { fromLibraryId = null } = {}) => {
    await store.addEntries(date, [{
      label: item.name, kcal: item.kcal, protein: item.protein, serving: item.serving,
    }]);
    if (fromLibraryId) await store.touchFood(fromLibraryId);
    clear(status, el('div', { class: 'notice' }, [
      el('div', { class: 'row gap between' }, [
        el('span', { class: 'grow small' }, `Logged ${item.name}.`),
        // Selecting a bundled result logs it and offers to keep it — one tap, and
        // it copies the values rather than referencing the dataset.
        fromLibraryId ? null : asyncButton('Save to my foods', 'btn small', async () => {
          await store.saveFood({ name: item.name, kcal: item.kcal, protein: item.protein, serving: item.serving });
          toast('Saved to your foods.');
          clear(status);
        }),
      ]),
    ]));
    onDone();
  };

  const resultRow = (item, badge, onPick) => el('li', {}, [
    el('button', { class: 'list-row', type: 'button', onclick: onPick }, [
      el('span', { class: 'title' }, [
        el('b', {}, item.name),
        item.serving ? el('span', { class: 'meta' }, item.serving) : null,
      ]),
      badge ? el('span', { class: 'badge' }, badge) : null,
      el('span', { class: 'num' }, `${roundKcal(item.kcal)} kcal · ${Math.round(item.protein)} g`),
    ]),
  ]);

  const runSearch = debounce(async () => {
    const query = search.value.trim();
    if (query.length < 2) {
      clear(results, el('p', { class: 'small faint' }, 'Type two letters to search.'));
      return;
    }

    // The library is searched synchronously and rendered immediately; the bundled
    // dataset is fetched on this first keystroke and appended when it arrives, so
    // your own foods never wait on it.
    const mine = searchLibrary(query, foods);
    const render = (commonList, note) => {
      clear(results);
      if (mine.length) {
        results.append(el('p', { class: 'small faint' }, 'Your foods'));
        results.append(el('ul', { class: 'list' }, mine.map((f) =>
          resultRow(f, null, () => logAndClose(f, { fromLibraryId: f.id })))));
      }
      if (commonList === null) {
        results.append(el('p', { class: 'small faint' }, note || 'Searching the common list…'));
      } else if (commonList.length) {
        results.append(el('p', { class: 'small faint', style: { marginTop: '.6rem' } }, 'Common foods (USDA)'));
        results.append(el('ul', { class: 'list' }, commonList.map((f) =>
          resultRow(f, null, () => logAndClose(f)))));
      } else if (!mine.length) {
        results.append(empty('No matches. Add it by hand below — it takes one go, then it is in your foods forever.'));
      }
    };

    render(null);
    const common = await searchCommon(query, new Set(mine.map((f) => String(f.name).toLowerCase())));
    const dataset = commonStatus();
    render(common, dataset.available ? null : 'The common food list is not available.');
  }, 180);

  search.addEventListener('input', runSearch);

  // --- manual entry, always available and never behind the search
  const nameInput = el('input', { type: 'text', placeholder: 'e.g. protein shake' });
  const kcalInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: '0' });
  const proteinInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: '0' });
  const servingInput = el('input', { type: 'text', placeholder: 'e.g. 1 bottle (optional)' });

  const readManual = () => ({
    name: nameInput.value.trim(),
    kcal: Number(kcalInput.value) || 0,
    protein: Number(proteinInput.value) || 0,
    serving: servingInput.value.trim(),
  });

  const manual = el('details', {}, [
    el('summary', { class: 'small muted', style: { minHeight: '44px', display: 'flex', alignItems: 'center' } },
      'Add by hand'),
    field('Name', nameInput),
    el('div', { class: 'row gap' }, [
      el('div', { class: 'grow' }, field('Calories', kcalInput)),
      el('div', { class: 'grow' }, field('Protein (g)', proteinInput)),
    ]),
    field('Serving', servingInput),
    el('div', { class: 'row gap' }, [
      asyncButton('Log it', 'btn primary grow', async () => {
        const item = readManual();
        if (!item.name) { toast('Give it a name.'); return; }
        await logAndClose(item);
        nameInput.value = ''; kcalInput.value = ''; proteinInput.value = ''; servingInput.value = '';
      }),
      asyncButton('Log & save', 'btn grow', async () => {
        const item = readManual();
        if (!item.name) { toast('Give it a name.'); return; }
        const saved = await store.saveFood(item);
        await logAndClose(item, { fromLibraryId: saved.id });
        nameInput.value = ''; kcalInput.value = ''; proteinInput.value = ''; servingInput.value = '';
      }),
    ]),
  ]);

  body.append(status, search, results, el('hr', { style: { border: 'none', borderTop: '1px solid var(--line)', margin: '1rem 0' } }), manual);
  clear(results, el('p', { class: 'small faint' }, 'Type two letters to search.'));

  sheet({ title: `Add food — ${formatDate(date)}`, body });
}

function openEntrySheet({ date, entry, onDone }) {
  const labelInput = el('input', { type: 'text', value: entry.label });
  const kcalInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', value: entry.kcal });
  const proteinInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', value: entry.protein });

  const body = el('div', {}, [
    field('Name', labelInput),
    el('div', { class: 'row gap' }, [
      el('div', { class: 'grow' }, field('Calories', kcalInput)),
      el('div', { class: 'grow' }, field('Protein (g)', proteinInput)),
    ]),
  ]);

  const ui = sheet({
    title: 'Edit entry',
    body,
    actions: [
      asyncButton('Save', 'btn primary grow', async () => {
        await store.updateEntry(date, entry.id, {
          label: labelInput.value.trim() || entry.label,
          kcal: Number(kcalInput.value) || 0,
          protein: Number(proteinInput.value) || 0,
        });
        ui.close();
        onDone();
      }),
      asyncButton('Save to my foods', 'btn', async () => {
        await store.saveFood({
          name: labelInput.value.trim() || entry.label,
          kcal: Number(kcalInput.value) || 0,
          protein: Number(proteinInput.value) || 0,
          serving: entry.serving || '',
        });
        toast('Saved to your foods.');
      }),
      asyncButton('Delete', 'btn danger', async () => {
        await store.removeEntry(date, entry.id);
        ui.close();
        onDone();
      }),
    ],
  });
}

// ---------------------------------------------------------------- library

async function renderLibrary(root, repaint) {
  const foods = await store.listFoods();

  root.append(el('button', {
    class: 'btn primary block',
    onclick: () => openFoodEditor({ onDone: repaint }),
  }, '+ New food'));

  root.append(sectionTitle(`${foods.length} saved food${foods.length === 1 ? '' : 's'}`));

  if (!foods.length) {
    root.append(empty('Nothing saved yet. Anything you log can be kept with one tap.'));
    return;
  }

  root.append(el('ul', { class: 'list card' }, foods.map((food) => el('li', {}, [
    el('button', {
      class: 'list-row', type: 'button',
      onclick: () => openFoodEditor({ food, onDone: repaint }),
    }, [
      el('span', { class: 'title' }, [
        el('b', {}, food.name),
        food.serving ? el('span', { class: 'meta' }, food.serving) : null,
      ]),
      el('span', { class: 'num' }, `${roundKcal(food.kcal)} kcal · ${Math.round(food.protein)} g`),
    ]),
  ]))));
}

function openFoodEditor({ food = null, onDone }) {
  const nameInput = el('input', { type: 'text', value: food?.name || '' });
  const kcalInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', value: food?.kcal ?? '' });
  const proteinInput = el('input', { type: 'number', inputmode: 'numeric', min: '0', value: food?.protein ?? '' });
  const servingInput = el('input', { type: 'text', value: food?.serving || '', placeholder: 'e.g. 1 bottle, 6 oz, 1 cup cooked' });

  const body = el('div', {}, [
    field('Name', nameInput),
    el('div', { class: 'row gap' }, [
      el('div', { class: 'grow' }, field('Calories', kcalInput)),
      el('div', { class: 'grow' }, field('Protein (g)', proteinInput)),
    ]),
    field('Serving', servingInput),
    food ? el('p', { class: 'small faint' }, 'Editing this does not change days you have already logged.') : null,
  ]);

  const ui = sheet({
    title: food ? 'Edit food' : 'New food',
    body,
    actions: [
      asyncButton('Save', 'btn primary grow', async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Give it a name.'); return; }
        await store.saveFood({
          id: food?.id,
          name,
          kcal: Number(kcalInput.value) || 0,
          protein: Number(proteinInput.value) || 0,
          serving: servingInput.value.trim(),
          lastUsed: food?.lastUsed,
        });
        ui.close();
        onDone();
      }),
      food
        ? asyncButton('Delete', 'btn danger', async () => {
          if (!await confirmDangerous(`Delete "${food.name}" from your foods?`)) return;
          await store.deleteFood(food.id);
          ui.close();
          onDone();
        })
        : null,
    ].filter(Boolean),
  });
}

// ---------------------------------------------------------------- meals

async function renderMeals(root, repaint) {
  const [meals, foods] = await Promise.all([store.listMeals(), store.listFoods()]);

  root.append(el('button', {
    class: 'btn primary block',
    onclick: () => openMealEditor({ foods, onDone: repaint }),
  }, '+ New meal'));

  root.append(sectionTitle(`${meals.length} saved meal${meals.length === 1 ? '' : 's'}`));

  if (!meals.length) {
    root.append(empty('A meal bundles several of your foods so a repeat combination logs in one tap.'));
    return;
  }

  root.append(el('ul', { class: 'list card' }, meals.map((meal) => {
    const mealKcal = sumBy(meal.items, 'kcal');
    const mealProtein = sumBy(meal.items, 'protein');
    return el('li', {}, [
      el('button', {
        class: 'list-row', type: 'button',
        onclick: () => openMealEditor({ meal, foods, onDone: repaint }),
      }, [
        el('span', { class: 'title' }, [
          el('b', {}, meal.name),
          el('span', { class: 'meta' }, meal.items.map((i) => i.name).join(', ')),
        ]),
        el('span', { class: 'num' }, `${roundKcal(mealKcal)} kcal · ${Math.round(mealProtein)} g`),
      ]),
    ]);
  })));
}

function openMealEditor({ meal = null, foods, onDone }) {
  // Items are copied by value the moment they are added. Editing a food later
  // never rewrites a meal, and editing a meal never rewrites an already-logged day.
  const items = (meal?.items || []).map((i) => ({ ...i }));

  const nameInput = el('input', { type: 'text', value: meal?.name || '', placeholder: 'e.g. usual breakfast' });
  const itemList = el('div');
  const totals = el('p', { class: 'small muted' });

  const paintItems = () => {
    clear(itemList);
    if (!items.length) {
      itemList.append(el('p', { class: 'small faint' }, 'No components yet.'));
    } else {
      itemList.append(el('ul', { class: 'list' }, items.map((item, index) => el('li', {}, [
        el('div', { class: 'list-row' }, [
          el('span', { class: 'title' }, [
            el('b', {}, item.name),
            el('span', { class: 'meta' }, `${roundKcal(item.kcal)} kcal · ${Math.round(item.protein)} g`),
          ]),
          el('button', {
            class: 'btn small', type: 'button', 'aria-label': `Remove ${item.name}`,
            onclick: () => { items.splice(index, 1); paintItems(); },
          }, '✕'),
        ]),
      ]))));
    }
    totals.textContent = `${roundKcal(sumBy(items, 'kcal'))} kcal · ${Math.round(sumBy(items, 'protein'))} g protein`;
  };

  const picker = el('select', { 'aria-label': 'Add a food to this meal' }, [
    el('option', { value: '' }, 'Add one of your foods…'),
    ...foods.map((f) => el('option', { value: f.id }, `${f.name} — ${roundKcal(f.kcal)} kcal`)),
  ]);
  picker.addEventListener('change', () => {
    const food = foods.find((f) => f.id === picker.value);
    if (food) {
      items.push({ name: food.name, kcal: food.kcal, protein: food.protein, serving: food.serving || '' });
      paintItems();
    }
    picker.value = '';
  });

  const body = el('div', {}, [
    field('Meal name', nameInput),
    foods.length
      ? field('Components', picker, 'Values are copied in, so editing a food later never changes this meal.')
      : el('p', { class: 'small faint' }, 'Save some foods first, then bundle them here.'),
    itemList,
    totals,
  ]);
  paintItems();

  const ui = sheet({
    title: meal ? 'Edit meal' : 'New meal',
    body,
    actions: [
      asyncButton('Save', 'btn primary grow', async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Give it a name.'); return; }
        if (!items.length) { toast('Add at least one food.'); return; }
        await store.saveMeal({ id: meal?.id, name, items, lastUsed: meal?.lastUsed });
        ui.close();
        onDone();
      }),
      meal
        ? asyncButton('Delete', 'btn danger', async () => {
          if (!await confirmDangerous(`Delete the "${meal.name}" meal?`)) return;
          await store.deleteMeal(meal.id);
          ui.close();
          onDone();
        })
        : null,
    ].filter(Boolean),
  });
}
