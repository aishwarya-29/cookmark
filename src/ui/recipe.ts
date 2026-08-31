import type { Recipe, Ingredient } from '../data/types';
import { formatIngredient } from '../lib/quantity';
import { getRecipe, updateRecipe, deleteRecipe, isManual } from '../data/recipes';
import { escapeHtml, formatDate, onClick } from './dom';
import { navigate } from './router';

/**
 * Recipe detail (FR-4.1) and editing (FR-2.10).
 *
 * Attribution is permanent and always visible (NFR-4.2) — including on
 * link-only entries, which is exactly where it matters most, because the link
 * back to the reel is the only content there is.
 */

/** Ingredients as editable text — one per line, the format people paste. */
function ingredientsToText(list: Ingredient[] | undefined): string {
  return (list ?? []).map(formatIngredient).join('\n');
}

/**
 * Parse the ingredient textarea back into structured rows.
 *
 * Intentionally shallow: it stores the whole line as `item`. Real quantity and
 * unit parsing arrives with the caption parser in Step 4, and will be shared
 * with this path rather than duplicated.
 */
function textToIngredients(text: string): Ingredient[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({ item: line }));
}

function attributionHtml(r: Recipe): string {
  if (isManual(r)) {
    return '<p class="attribution">Your own recipe</p>';
  }
  const handle = r.creatorHandle
    ? `<a href="https://www.instagram.com/${encodeURIComponent(r.creatorHandle)}/"
         target="_blank" rel="noopener noreferrer">@${escapeHtml(r.creatorHandle)}</a>`
    : '<span class="dim">creator unknown</span>';
  return `
    <p class="attribution">
      ${handle} ·
      <a href="${escapeHtml(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">
        watch the original reel
      </a>
    </p>`;
}

/** A link-only entry is a valid outcome — this must not read as a failure. */
function emptyRecipeInvitation(): string {
  return `
    <div class="invitation">
      <p>No recipe details yet.</p>
      <p class="dim">
        Add them whenever you like — or open the reel and jot down what you see.
      </p>
      <button data-action="edit">Add recipe details</button>
    </div>`;
}

export function renderRecipe(root: HTMLElement, r: Recipe, onChange: () => void): void {
  const hasIngredients = (r.ingredients?.length ?? 0) > 0;
  const hasSteps = (r.steps?.length ?? 0) > 0;
  const hasContent = hasIngredients || hasSteps;

  // Partial — ingredients but no method. A gentle affordance, not an error.
  const partialNote =
    hasIngredients && !hasSteps
      ? `<p class="note-partial">
           The method didn't come through. You can add the steps, or watch the reel.
         </p>`
      : '';

  root.innerHTML = `
    <p><a href="#/" class="back">← Library</a></p>

    <h1>${escapeHtml(r.title)}</h1>
    ${attributionHtml(r)}
    <p class="dim small">Saved ${formatDate(r.savedAt)}</p>

    ${
      hasContent
        ? `
      ${partialNote}
      ${
        hasIngredients
          ? `<h2>Ingredients</h2>
             <ul class="plain-list">
               ${r.ingredients!.map((i) => `<li>${escapeHtml(formatIngredient(i))}</li>`).join('')}
             </ul>`
          : ''
      }
      ${
        hasSteps
          ? `<h2>Method</h2>
             <ol class="step-list">
               ${r.steps!.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
             </ol>`
          : ''
      }
      <div class="action-row">
        <button data-action="cook">Cook this</button>
        <button class="subtle" data-action="edit">Edit</button>
      </div>`
        : emptyRecipeInvitation()
    }

    ${
      r.rawCaption
        ? `<details class="raw-caption">
             <summary>Original caption</summary>
             <pre>${escapeHtml(r.rawCaption)}</pre>
           </details>`
        : ''
    }

    <h2>Your notes</h2>
    <textarea id="notes" rows="3"
      placeholder="Used half the chilli. Needs 10 more minutes.">${escapeHtml(r.notes ?? '')}</textarea>

    <div class="action-row">
      <button class="subtle danger" data-action="delete">Delete recipe</button>
    </div>
  `;

  onClick(root, '[data-action="cook"]', () => navigate(`#/cook/${r.id}`));
  onClick(root, '[data-action="edit"]', () => navigate(`#/edit/${r.id}`));
  onClick(root, '[data-action="delete"]', async () => {
    if (!confirm('Delete this recipe? This cannot be undone.')) return;
    await deleteRecipe(r.id);
    navigate('#/');
  });

  // Notes are the user's own content and must never be lost (FR-4.6).
  const notes = root.querySelector<HTMLTextAreaElement>('#notes')!;
  notes.addEventListener('blur', async () => {
    if (notes.value === (r.notes ?? '')) return;
    await updateRecipe(r.id, {
      notes: notes.value,
      manuallyEditedFields: [...new Set([...(r.manuallyEditedFields ?? []), 'notes'])],
    });
    onChange();
  });
}

export function renderEdit(root: HTMLElement, r: Recipe, onChange: () => void): void {
  root.innerHTML = `
    <p><a href="#/recipe/${r.id}" class="back">← Cancel</a></p>
    <h1>Edit recipe</h1>

    <label for="e-title">Title</label>
    <input id="e-title" type="text" value="${escapeHtml(r.title)}" />

    <label for="e-ing">Ingredients <span class="dim small">one per line</span></label>
    <textarea id="e-ing" rows="8"
      placeholder="2 tbsp chilli oil&#10;300g noodles">${escapeHtml(ingredientsToText(r.ingredients))}</textarea>

    <label for="e-steps">Method <span class="dim small">one step per line</span></label>
    <textarea id="e-steps" rows="8"
      placeholder="Boil the noodles.&#10;Fry the garlic until golden.">${escapeHtml(
        (r.steps ?? []).join('\n'),
      )}</textarea>

    <div class="action-row">
      <button data-action="save">Save changes</button>
    </div>
  `;

  onClick(root, '[data-action="save"]', async () => {
    const title = root.querySelector<HTMLInputElement>('#e-title')!.value.trim();
    const ingredients = textToIngredients(root.querySelector<HTMLTextAreaElement>('#e-ing')!.value);
    const steps = root
      .querySelector<HTMLTextAreaElement>('#e-steps')!
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    // Anything the user touched here is theirs, and re-extraction must not
    // overwrite it (FR-2.10).
    const edited = new Set([...(r.manuallyEditedFields ?? []), 'title', 'ingredients', 'steps']);

    await updateRecipe(r.id, {
      title: title || r.title,
      ingredients,
      steps,
      // Having both means it's complete; ingredients alone is still partial.
      status: ingredients.length && steps.length ? 'complete' : r.status,
      manuallyEditedFields: [...edited],
    });
    onChange();
    navigate(`#/recipe/${r.id}`);
  });
}

export async function loadRecipe(id: string): Promise<Recipe | undefined> {
  return getRecipe(id);
}
