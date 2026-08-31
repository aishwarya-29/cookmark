import type { Recipe } from '../data/types';
import { termMatches, singularise } from './ingredient-terms';

/**
 * Search and ingredient matching — PRD FR-3.2 and FR-3.4.
 *
 * Everything here runs against the in-memory recipe list, so it works offline
 * (NFR-3.2) and stays well inside the <100ms target at library scale.
 */

export interface IngredientMatch {
  recipe: Recipe;
  /** Query ingredients this recipe uses. */
  have: string[];
  /** Query ingredients it does not. */
  missing: string[];
  /** have / total, for ranking. */
  score: number;
}

/** Split a free-text ingredient query: "chicken, potatoes and cream" → 3 terms. */
export function parseIngredientQuery(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[,\n]|\band\b|\+|&/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .map((s) => s.replace(/^(?:some|a|an|the)\s+/, '').trim())
    .filter(Boolean);
}

/**
 * "What can I cook?" — rank recipes by how much of the query they use.
 *
 * Ranked by proportion matched rather than absolute count, so a 3-ingredient
 * recipe using both your items beats a 20-ingredient one using the same two.
 * Partial matches are included deliberately: knowing you are one item short is
 * more useful than being shown nothing.
 */
export function matchByIngredients(
  recipes: Recipe[],
  query: string[],
): IngredientMatch[] {
  if (!query.length) return [];

  const results: IngredientMatch[] = [];

  for (const r of recipes) {
    const terms = r.searchTerms ?? [];
    if (!terms.length) continue;

    const have: string[] = [];
    const missing: string[] = [];

    for (const q of query) {
      if (terms.some((t) => termMatches(q, t))) have.push(q);
      else missing.push(q);
    }

    if (!have.length) continue;
    results.push({ recipe: r, have, missing, score: have.length / query.length });
  }

  return results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break toward the simpler recipe — fewer ingredients to shop for.
    const ai = a.recipe.ingredients?.length ?? 99;
    const bi = b.recipe.ingredients?.length ?? 99;
    return ai - bi;
  });
}

/**
 * Full-text search across title, ingredients, steps, tags, creator, and notes
 * (FR-3.2). Tolerates misspellings via the shared term matcher.
 */
export function searchRecipes(recipes: Recipe[], query: string): Recipe[] {
  const q = query.trim().toLowerCase();
  if (!q) return recipes;

  const words = q.split(/\s+/).filter(Boolean).map(singularise);

  const scored = recipes
    .map((r) => {
      const haystacks: string[] = [
        r.title,
        r.creatorHandle ?? '',
        r.cuisine ?? '',
        r.mealType ?? '',
        ...(r.tags ?? []),
        ...(r.searchTerms ?? []),
        ...(r.ingredients ?? []).map((i) => i.item),
        ...(r.steps ?? []),
        r.notes ?? '',
      ];
      const blob = haystacks.join(' ').toLowerCase();

      // Fuzzy matching is restricted to a small set of meaningful terms —
      // ingredients, tags, cuisine, title words. Fuzzy-matching every word of
      // every step made any query match everything, because with hundreds of
      // words something always clears the threshold.
      const fuzzyTargets = [
        ...(r.searchTerms ?? []),
        ...(r.tags ?? []),
        r.cuisine ?? '',
        r.mealType ?? '',
        ...r.title.toLowerCase().split(/\s+/),
      ].filter((t) => t.length >= 4);

      // Every query word must be present somewhere — an AND, not an OR, so
      // adding words narrows results the way people expect.
      let score = 0;
      for (const w of words) {
        if (blob.includes(w)) {
          score += 1;
          // Weight a title hit higher, so the obvious match ranks first.
          if (r.title.toLowerCase().includes(w)) score += 2;
        } else if (fuzzyTargets.some((t) => termMatches(w, t))) {
          score += 0.5; // fuzzy hit — a likely typo
        } else {
          return null;
        }
      }
      return { r, score };
    })
    .filter((x): x is { r: Recipe; score: number } => x !== null);

  return scored.sort((a, b) => b.score - a.score).map((x) => x.r);
}

/** Every tag in use, most-used first — for autocomplete (FR-3.6). */
export function allTags(recipes: Recipe[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of recipes) {
    for (const t of r.tags ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Distinct values in use for a categorical field, for filter chips. */
export function distinctValues(
  recipes: Recipe[],
  field: 'cuisine' | 'mealType',
): string[] {
  const set = new Set<string>();
  for (const r of recipes) {
    const v = r[field];
    if (v) set.add(v);
  }
  return [...set].sort();
}
