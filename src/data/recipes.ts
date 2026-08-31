import type { ReelRecipesDb } from './db';
import { db as defaultDb } from './db';
import type { Recipe } from './types';
import { canonicaliseInstagramUrl, type CanonicalUrl } from '../lib/url';
import { recipeSearchTerms } from '../lib/ingredient-terms';
import { newId } from '../lib/id';
import { purgeRecipe } from './collections';
import { releaseThumbnail } from '../lib/thumbnail';

/**
 * The save path — PRD NFR-3.1, the product's fundamental promise.
 *
 * The row is written and committed BEFORE any extraction is attempted. Nothing
 * in this file may await a network call. If you find yourself adding a fetch
 * here, it belongs in the extraction layer instead.
 */

export type SaveOutcome =
  | { kind: 'saved'; recipe: Recipe }
  /** FR-2.2 — reassuring, not an error. The UI must not phrase this as a mistake. */
  | { kind: 'duplicate'; existing: Recipe };

/** Title placeholder until extraction gives us a real one. PRD §04. */
function provisionalTitle(parsed: CanonicalUrl, savedAt: number): string {
  const date = new Date(savedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  return parsed.creatorHandle ? `@${parsed.creatorHandle} — ${date}` : `Saved reel — ${date}`;
}

/**
 * Canonicalise, check for a duplicate, and durably write the row.
 *
 * Throws {@link InvalidInstagramUrlError} for unusable input — the caller
 * shows the message. Everything else results in a saved row.
 */
export async function saveReelUrl(
  rawUrl: string,
  db: ReelRecipesDb = defaultDb,
  /** A name the user typed. Optional, and protected from re-extraction. */
  userTitle?: string,
): Promise<SaveOutcome> {
  const parsed = canonicaliseInstagramUrl(rawUrl);

  // FR-2.2 — duplicate check before insert, so the UI can show the existing one.
  const existing = await db.recipes.where('sourceUrl').equals(parsed.canonical).first();
  if (existing) return { kind: 'duplicate', existing };

  const now = Date.now();
  const named = userTitle?.trim();
  const recipe: Recipe = {
    id: newId(),
    title: named || provisionalTitle(parsed, now),
    // A name the user typed is theirs: mark it edited so no tier overwrites
    // it, exactly as with a name typed on the edit screen (FR-2.10).
    ...(named ? { manuallyEditedFields: ['title'] } : {}),
    sourceUrl: parsed.canonical,
    shortcode: parsed.shortcode,
    creatorHandle: parsed.creatorHandle,
    unresolvedShareLink: parsed.unresolved || undefined,
    // Nothing attempted yet. Step 2 moves these forward.
    extractionMethod: 'pending',
    status: 'needs_attention',
    extractionState: 'queued',
    attempts: [],
    savedAt: now,
    updatedAt: now,
  };

  try {
    await db.recipes.add(recipe);
  } catch (err) {
    // A racing save of the same URL trips the unique index. Treat it as the
    // duplicate it is rather than surfacing a database error.
    if (err instanceof Error && err.name === 'ConstraintError') {
      const raced = await db.recipes.where('sourceUrl').equals(parsed.canonical).first();
      if (raced) return { kind: 'duplicate', existing: raced };
    }
    throw err;
  }

  return { kind: 'saved', recipe };
}

/**
 * Create a recipe by hand, with no reel attached — the "my grandmother's
 * recipe" case (FR-2.10). Given a synthetic sourceUrl so the unique index
 * still applies and nothing downstream has to special-case a missing URL.
 */
export async function createManualRecipe(
  title: string,
  db: ReelRecipesDb = defaultDb,
): Promise<Recipe> {
  const now = Date.now();
  const recipe: Recipe = {
    id: newId(),
    title: title.trim() || 'Untitled recipe',
    sourceUrl: `manual:${newId()}`,
    extractionMethod: 'manual',
    status: 'complete',
    extractionState: 'settled',
    attempts: [],
    ingredients: [],
    steps: [],
    // Everything here is the user's own work — protect all of it from any
    // future re-extraction.
    manuallyEditedFields: ['title', 'ingredients', 'steps'],
    savedAt: now,
    updatedAt: now,
  };
  await db.recipes.add(recipe);
  return recipe;
}

/** True for recipes with no real reel behind them. */
export function isManual(r: Recipe): boolean {
  return r.sourceUrl.startsWith('manual:');
}

/** Library listing, newest first (FR-3.1). */
export async function listRecipes(db: ReelRecipesDb = defaultDb): Promise<Recipe[]> {
  return db.recipes.orderBy('savedAt').reverse().toArray();
}

export async function getRecipe(
  id: string,
  db: ReelRecipesDb = defaultDb,
): Promise<Recipe | undefined> {
  return db.recipes.get(id);
}

/** FR-5.3 — deletion is immediate and complete. */
export async function deleteRecipe(id: string, db: ReelRecipesDb = defaultDb): Promise<void> {
  await db.recipes.delete(id);
  // Drop it from any collection too, so folders never count or cover-image a
  // recipe that no longer exists.
  await purgeRecipe(id, db);
  // Free the cached thumbnail's object URL along with it.
  releaseThumbnail(id);
}

/**
 * Patch a recipe. Always stamps `updatedAt` so the UI can react to changes
 * without every caller remembering to.
 */
export async function updateRecipe(
  id: string,
  changes: Partial<Recipe>,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  const patch: Partial<Recipe> = { ...changes, updatedAt: Date.now() };

  // Derive search terms here rather than at every call site, so the search
  // index can never drift out of sync with the ingredients (FR-3.4).
  if (changes.ingredients) {
    patch.searchTerms = recipeSearchTerms(changes.ingredients);
  }

  await db.recipes.update(id, patch);
}
