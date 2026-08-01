/**
 * First-run plan chooser.
 *
 * A new account has to pick a starting point before the Today screen means
 * anything. Two options, no third: bring your own plan, or start from the bundled
 * bodyweight placeholder.
 *
 * The starter plan is offered as a placeholder and labelled as one. The app ships
 * no assumptions about anyone's equipment, training history, or body, and this
 * screen is where that would be easiest to get wrong.
 */

import { el, sectionTitle, asyncButton } from '../components.js';
import { planImportForm, loadStarterPlan } from '../plan-import.js';
import * as store from '../store.js';
import { toast, add } from '../util.js';

export const title = 'Get started';

export async function render(root, params, { navigate }) {
  const existingPlan = await store.getActivePlan();

  add(
    root,
    el('div', { class: 'card' }, [
      el('h2', {}, 'Pick a starting point'),
      el('p', { class: 'small muted' },
        'Ledger logs against a plan. Load your own, or start from the bundled placeholder and replace it whenever you like — old plans are kept, and every session records which plan it was logged under.'),
    ]),

    sectionTitle('Your own plan'),
    el('div', { class: 'card' }, [
      planImportForm({
        saveLabel: 'Save and start',
        onSaved: () => navigate('#/today'),
      }),
    ]),

    sectionTitle('Or start from the placeholder'),
    el('div', { class: 'card' }, [
      el('h3', {}, 'Starter (Bodyweight)'),
      el('p', { class: 'small muted' },
        'Two sessions, seven exercises each, no equipment required. This is a placeholder so a new account has something valid to log against on day one — it is not a recommendation, and it is meant to be replaced.'),
      asyncButton('Use the starter plan', 'btn primary block', async () => {
        const { parsed, source } = await loadStarterPlan();
        const saved = await store.savePlan(parsed, source);
        toast(`"${saved.name}" is now your active plan.`);
        navigate('#/today');
      }),
    ]),

    existingPlan
      ? el('div', { class: 'card' }, [
        el('p', { class: 'small muted' }, `Currently active: ${existingPlan.name}.`),
        el('button', {
          class: 'btn block',
          onclick: () => navigate('#/today'),
        }, 'Back to Today'),
      ])
      : null,
  );
}
