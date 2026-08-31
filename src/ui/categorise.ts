import type { Recipe } from '../data/types';
import { updateRecipe } from '../data/recipes';
import { escapeHtml, onClick } from './dom';

/**
 * Categories and tags — PRD FR-3.6, FR-3.7.
 *
 * The governing rule: suggestions are always dismissible proposals, never
 * silent assignment. "A library that silently reorganises itself is
 * unsettling" (§11 Q4), and a wrong auto-tag erodes trust in the library
 * faster than a missing one (FR-3.7).
 */

export const MEAL_TYPES = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'dessert',
  'drink',
] as const;

/** Chips offering what extraction suggested, with accept / dismiss. */
export function suggestionsHtml(r: Recipe): string {
  const s = r.suggested;
  if (!s || (!s.cuisine && !s.mealType && !s.tags?.length)) return '';

  const chips: string[] = [];
  if (s.cuisine) {
    chips.push(
      `<button class="chip suggest" data-accept="cuisine" data-value="${escapeHtml(
        s.cuisine,
      )}">+ ${escapeHtml(s.cuisine)}</button>`,
    );
  }
  if (s.mealType) {
    chips.push(
      `<button class="chip suggest" data-accept="mealType" data-value="${escapeHtml(
        s.mealType,
      )}">+ ${escapeHtml(s.mealType)}</button>`,
    );
  }
  for (const t of s.tags ?? []) {
    chips.push(
      `<button class="chip suggest" data-accept="tag" data-value="${escapeHtml(
        t,
      )}">+ ${escapeHtml(t)}</button>`,
    );
  }

  return `
    <div class="suggestions">
      <p class="dim small">Suggested — tap to keep, or dismiss them all.</p>
      <div class="chip-row">
        ${chips.join('')}
        <button class="chip dismiss" data-dismiss-all="1">Dismiss</button>
      </div>
    </div>`;
}

/** The categories actually accepted, each removable. */
export function categoriesHtml(r: Recipe): string {
  const chips: string[] = [];
  if (r.cuisine) {
    chips.push(
      `<span class="chip">${escapeHtml(r.cuisine)}
         <button class="chip-x" data-remove="cuisine" aria-label="Remove cuisine">×</button>
       </span>`,
    );
  }
  if (r.mealType) {
    chips.push(
      `<span class="chip">${escapeHtml(r.mealType)}
         <button class="chip-x" data-remove="mealType" aria-label="Remove meal type">×</button>
       </span>`,
    );
  }
  for (const t of r.tags ?? []) {
    chips.push(
      `<span class="chip">${escapeHtml(t)}
         <button class="chip-x" data-remove="tag" data-value="${escapeHtml(
           t,
         )}" aria-label="Remove tag">×</button>
       </span>`,
    );
  }

  return `
    <div class="chip-row">
      ${chips.join('')}
      <button class="chip add" data-action="add-tag">+ tag</button>
    </div>`;
}

/**
 * Wire up accept, dismiss, remove, and add. `onChange` re-renders.
 *
 * `knownTags` powers autocomplete, which exists to prevent near-duplicates
 * like "quick" vs "quick meals" (FR-3.6).
 */
export function bindCategoryActions(
  root: ParentNode,
  r: Recipe,
  knownTags: string[],
  onChange: () => void,
): void {
  const save = async (patch: Partial<Recipe>) => {
    await updateRecipe(r.id, patch);
    onChange();
  };

  onClick(root, '[data-accept]', (el) => {
    const kind = el.dataset['accept'];
    const value = el.dataset['value'] ?? '';
    const rest = { ...(r.suggested ?? {}) };

    if (kind === 'cuisine') {
      delete rest.cuisine;
      void save({ cuisine: value, suggested: rest });
    } else if (kind === 'mealType') {
      delete rest.mealType;
      void save({ mealType: value, suggested: rest });
    } else {
      rest.tags = (rest.tags ?? []).filter((t) => t !== value);
      void save({
        tags: [...new Set([...(r.tags ?? []), value])],
        suggested: rest,
      });
    }
  });

  onClick(root, '[data-dismiss-all]', () => {
    // Dismissed for good — re-suggesting what the user rejected is nagging.
    void save({ suggested: {} });
  });

  onClick(root, '[data-remove]', (el) => {
    const kind = el.dataset['remove'];
    if (kind === 'cuisine') void save({ cuisine: undefined });
    else if (kind === 'mealType') void save({ mealType: undefined });
    else {
      const value = el.dataset['value'];
      void save({ tags: (r.tags ?? []).filter((t) => t !== value) });
    }
  });

  onClick(root, '[data-action="add-tag"]', () => {
    const suggestions = knownTags.length
      ? `\n\nAlready in use: ${knownTags.slice(0, 12).join(', ')}`
      : '';
    const value = prompt(`Add a tag${suggestions}`)?.trim().toLowerCase();
    if (!value) return;
    void save({ tags: [...new Set([...(r.tags ?? []), value])] });
  });
}
