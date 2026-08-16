import type { ReelRecipesDb } from './db';
import { db as defaultDb } from './db';
import type { Recipe } from './types';
import { canonicaliseInstagramUrl, type CanonicalUrl } from '../lib/url';

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

function newId(): string {
  // crypto.randomUUID is available in all PWA-capable browsers and in Node 19+.
  return crypto.randomUUID();
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
): Promise<SaveOutcome> {
  const parsed = canonicaliseInstagramUrl(rawUrl);

  // FR-2.2 — duplicate check before insert, so the UI can show the existing one.
  const existing = await db.recipes.where('sourceUrl').equals(parsed.canonical).first();
  if (existing) return { kind: 'duplicate', existing };

  const now = Date.now();
  const recipe: Recipe = {
    id: newId(),
    title: provisionalTitle(parsed, now),
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
  await db.recipes.update(id, { ...changes, updatedAt: Date.now() });
}
