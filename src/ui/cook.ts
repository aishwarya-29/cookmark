import type { Recipe } from '../data/types';
import { formatIngredient } from '../lib/quantity';
import { updateRecipe } from '../data/recipes';
import { escapeHtml, onClick } from './dom';
import { navigateReplacing } from './router';
import { requestWakeLock, releaseWakeLock, wakeLockStatus } from '../lib/wakelock';

/**
 * Cook mode — PRD FR-4.2.
 *
 * Kitchen constraints drive every decision here:
 *   - Larger type, readable at arm's length on a propped-up phone
 *   - 48px minimum touch targets, forgiving of wet or imprecise taps
 *   - No swipe-only interactions (NFR-5.2) — everything has a button
 *   - Progress survives an accidental app switch, so it is written to the
 *     database on every tap rather than held in memory
 *   - Screen must not sleep
 */

export async function enterCookMode(): Promise<void> {
  document.body.classList.add('cooking');
  await requestWakeLock();
}

export async function exitCookMode(): Promise<void> {
  document.body.classList.remove('cooking');
  await releaseWakeLock();
}

export function renderCook(root: HTMLElement, r: Recipe, onChange: () => void): void {
  const steps = r.steps ?? [];
  const ingredients = r.ingredients ?? [];
  const checkedIng = new Set(r.checkedIngredients ?? []);
  const checkedSteps = new Set(r.checkedSteps ?? []);
  const current = Math.min(r.currentStep ?? 0, Math.max(steps.length - 1, 0));

  const lockNote =
    wakeLockStatus() === 'unsupported'
      ? '<p class="dim small">This browser may let the screen sleep.</p>'
      : '';

  root.innerHTML = `
    <div class="cook-header">
      <button class="subtle" data-action="exit">Done</button>
      <span class="cook-title">${escapeHtml(r.title)}</span>
    </div>
    ${lockNote}

    <details class="cook-ingredients" ${ingredients.length ? 'open' : ''}>
      <summary>Ingredients (${checkedIng.size}/${ingredients.length})</summary>
      <ul class="check-list">
        ${ingredients
          .map(
            (ing, i) => `
          <li>
            <button class="check ${checkedIng.has(i) ? 'checked' : ''}"
                    data-ing="${i}"
                    aria-pressed="${checkedIng.has(i)}">
              <span class="tick">${checkedIng.has(i) ? '✓' : ''}</span>
              <span>${escapeHtml(formatIngredient(ing))}</span>
            </button>
          </li>`,
          )
          .join('')}
      </ul>
    </details>

    ${
      steps.length
        ? `
      <p class="step-counter">Step ${current + 1} of ${steps.length}</p>
      <div class="cook-step ${checkedSteps.has(current) ? 'done' : ''}">
        ${escapeHtml(steps[current] ?? '')}
      </div>

      <div class="cook-nav">
        <button class="subtle" data-action="prev" ${current === 0 ? 'disabled' : ''}>
          ← Back
        </button>
        <button data-action="toggle-step">
          ${checkedSteps.has(current) ? 'Undo' : 'Done'}
        </button>
        <button class="subtle" data-action="next"
                ${current >= steps.length - 1 ? 'disabled' : ''}>
          Next →
        </button>
      </div>`
        : `<p class="dim">This recipe has no method steps yet.</p>`
    }
  `;

  // Every tap writes through to the database so progress survives an app
  // switch, a phone lock, or a crash (FR-4.2).
  const persist = async (patch: Partial<Recipe>) => {
    await updateRecipe(r.id, patch);
    onChange();
  };

  onClick(root, '[data-action="exit"]', () => {
    // Finishing a cook returns to the recipe; Back should not re-enter it.
    void exitCookMode().then(() => navigateReplacing(`#/recipe/${r.id}`));
  });

  onClick(root, '[data-ing]', (el) => {
    const i = Number(el.dataset['ing']);
    const next = new Set(checkedIng);
    next.has(i) ? next.delete(i) : next.add(i);
    void persist({ checkedIngredients: [...next] });
  });

  onClick(root, '[data-action="toggle-step"]', () => {
    const next = new Set(checkedSteps);
    next.has(current) ? next.delete(current) : next.add(current);
    // Ticking a step advances automatically — one tap, not two, with hands full.
    const advance = !checkedSteps.has(current) && current < steps.length - 1;
    void persist({
      checkedSteps: [...next],
      currentStep: advance ? current + 1 : current,
    });
  });

  onClick(root, '[data-action="prev"]', () => {
    void persist({ currentStep: Math.max(0, current - 1) });
  });

  onClick(root, '[data-action="next"]', () => {
    void persist({ currentStep: Math.min(steps.length - 1, current + 1) });
  });
}
