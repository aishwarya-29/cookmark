import type { Recipe } from '../data/types';
import { escapeHtml } from './dom';
import {
  matchByIngredients,
  parseIngredientQuery,
  searchRecipes,
  allTags,
  distinctValues,
  type IngredientMatch,
} from '../lib/search';

/**
 * Search, filters, and ingredient match — PRD FR-3.2, FR-3.3, FR-3.4.
 *
 * Filters are visible chips rather than a modal, so what is filtered is
 * obvious at a glance and clearable in one tap (FR-3.3).
 */

export interface SearchState {
  /** Free-text query. */
  text: string;
  /** "What can I cook?" ingredient list. */
  cookWith: string;
  cuisine?: string;
  mealType?: string;
  tag?: string;
}

export const emptySearch: SearchState = { text: '', cookWith: '' };

export function isSearchActive(s: SearchState): boolean {
  return Boolean(s.text.trim() || s.cookWith.trim() || s.cuisine || s.mealType || s.tag);
}

/** Apply text search and categorical filters. Ingredient match is separate. */
export function applyFilters(recipes: Recipe[], s: SearchState): Recipe[] {
  let out = recipes;
  if (s.cuisine) out = out.filter((r) => r.cuisine === s.cuisine);
  if (s.mealType) out = out.filter((r) => r.mealType === s.mealType);
  if (s.tag) out = out.filter((r) => (r.tags ?? []).includes(s.tag!));
  if (s.text.trim()) out = searchRecipes(out, s.text);
  return out;
}

export function ingredientMatches(recipes: Recipe[], s: SearchState): IngredientMatch[] {
  const q = parseIngredientQuery(s.cookWith);
  if (!q.length) return [];
  return matchByIngredients(applyFilters(recipes, { ...s, cookWith: '' }), q);
}

function chip(label: string, attr: string, active: boolean, count?: number): string {
  return `<button class="chip filter ${active ? 'active' : ''}" ${attr}>
            ${escapeHtml(label)}${count !== undefined ? ` <span class="dim">${count}</span>` : ''}
          </button>`;
}

export function searchPanelHtml(recipes: Recipe[], s: SearchState): string {
  // Hidden ONLY when the library is genuinely empty, so first run teaches the
  // paste flow (PRD §11 Q5). Hiding it at one recipe was wrong: the controls
  // disappearing after a first save reads as broken, not tidy.
  if (recipes.length === 0) return '';

  const cuisines = distinctValues(recipes, 'cuisine');
  const meals = distinctValues(recipes, 'mealType');
  const tags = allTags(recipes);

  const activeCount = [s.cuisine, s.mealType, s.tag].filter(Boolean).length;

  // All filters live in one scrollable row rather than three stacked rows.
  // Three rows of chips pushed the library below the fold, which inverts the
  // priority: the recipes are the point, the filters are a tool.
  const allChips = [
    ...cuisines.map((c) =>
      chip(c, `data-filter="cuisine" data-value="${escapeHtml(c)}"`, s.cuisine === c),
    ),
    ...meals.map((m) =>
      chip(m, `data-filter="mealType" data-value="${escapeHtml(m)}"`, s.mealType === m),
    ),
    ...tags
      .slice(0, 10)
      .map((t) =>
        chip(t.tag, `data-filter="tag" data-value="${escapeHtml(t.tag)}"`, s.tag === t.tag, t.count),
      ),
  ];

  // Anything selected stays visible; the rest hide behind a disclosure so the
  // resting state is calm.
  const filterRows = allChips.length
    ? `<details class="filters" ${activeCount ? 'open' : ''}>
         <summary>
           Filter${activeCount ? ` · ${activeCount} on` : ''}
         </summary>
         <div class="chip-scroll">${allChips.join('')}</div>
       </details>`
    : '';

  return `
    <div class="search-panel">
      <input id="search-text" type="search" placeholder="Search recipes…"
             value="${escapeHtml(s.text)}" aria-label="Search recipes" />

      <details class="cook-with" ${s.cookWith ? 'open' : ''}>
        <summary>What can I cook?</summary>
        <p class="dim small">List what you have. Partial matches are shown too.</p>
        <input id="cook-with" type="text" placeholder="chicken, potatoes"
               value="${escapeHtml(s.cookWith)}" aria-label="Ingredients you have" />
      </details>

      ${filterRows}
      ${
        activeCount || s.text || s.cookWith
          ? `<button class="subtle" data-action="clear-filters">Clear${
              activeCount ? ` (${activeCount})` : ''
            }</button>`
          : ''
      }
    </div>`;
}

/** Results for "what can I cook?", showing what is missing (FR-3.4). */
export function matchResultsHtml(matches: IngredientMatch[]): string {
  if (!matches.length) {
    return `<div class="empty">
              <p>Nothing uses those ingredients yet.</p>
              <p class="dim small">Try fewer of them, or check the spelling.</p>
            </div>`;
  }

  return `<ul class="card-list">
    ${matches
      .map(({ recipe: r, have, missing }) => {
        const total = have.length + missing.length;
        return `
        <li class="card">
          <a class="card-link" href="#/recipe/${r.id}">
            <p class="card-title">${escapeHtml(r.title)}</p>
          </a>
          <p class="match-line">
            <strong>${have.length} of ${total}</strong>
            ${
              missing.length
                ? `· missing ${escapeHtml(missing.join(', '))}`
                : '· you have everything'
            }
          </p>
          <div class="card-meta">
            ${
              r.creatorHandle
                ? `<a href="https://www.instagram.com/${encodeURIComponent(
                    r.creatorHandle,
                  )}/" target="_blank" rel="noopener noreferrer">@${escapeHtml(
                    r.creatorHandle,
                  )}</a>`
                : '<span class="dim">your own recipe</span>'
            }
            ${r.cuisine ? `<span class="chip small-chip">${escapeHtml(r.cuisine)}</span>` : ''}
          </div>
        </li>`;
      })
      .join('')}
  </ul>`;
}
