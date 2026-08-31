import type { ReelRecipesDb } from './db';
import { db as defaultDb } from './db';
import type { Recipe, Collection } from './types';
import { formatIngredient } from '../lib/quantity';

/**
 * Export and import — PRD FR-5.1, FR-5.2, FR-5.4.
 *
 * "The user's data is theirs. Export must never be degraded, delayed, or used
 * as leverage." One action, no account, no gating. JSON is the complete
 * record; Markdown is the human-readable one.
 *
 * Import is the disaster-recovery path, so it must be forgiving of files that
 * are slightly wrong and must never destroy what is already there.
 */

/** DO NOT RENAME — backups exported before the rename must still import. */
const FORMAT = 'reel-recipes-backup';
const FORMAT_VERSION = 1;

export interface Backup {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  recipes: Recipe[];
  collections: Collection[];
}

/** Complete-fidelity export (FR-5.1). */
export async function exportJson(db: ReelRecipesDb = defaultDb): Promise<Backup> {
  const [recipes, collections] = await Promise.all([
    db.recipes.toArray(),
    db.collections.toArray(),
  ]);

  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    // Blobs cannot survive JSON. Thumbnails are re-fetchable and the URL is
    // kept, so dropping the cached bytes loses nothing that matters.
    recipes: recipes.map(({ thumbnailBlob: _drop, ...rest }) => rest),
    collections,
  };
}

function ingredientLines(r: Recipe): string {
  if (!r.ingredients?.length) return '';
  return `\n## Ingredients\n\n${r.ingredients.map((i) => `- ${formatIngredient(i)}`).join('\n')}\n`;
}

function stepLines(r: Recipe): string {
  if (!r.steps?.length) return '';
  return `\n## Method\n\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`;
}

/** Human-readable export (FR-5.1). Attribution is preserved (NFR-4.2). */
export async function exportMarkdown(db: ReelRecipesDb = defaultDb): Promise<string> {
  const [recipes, collections] = await Promise.all([
    db.recipes.toArray(),
    db.collections.toArray(),
  ]);
  recipes.sort((a, b) => b.savedAt - a.savedAt);

  const collectionsByRecipe = new Map<string, string[]>();
  for (const c of collections) {
    for (const id of c.recipeIds) {
      collectionsByRecipe.set(id, [...(collectionsByRecipe.get(id) ?? []), c.name]);
    }
  }

  const parts = [
    `# Cookmark`,
    ``,
    `${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'}, exported ${new Date().toLocaleDateString()}.`,
    ``,
  ];

  for (const r of recipes) {
    parts.push(`---`, ``, `# ${r.title}`, ``);

    const meta: string[] = [];
    if (r.creatorHandle) meta.push(`By @${r.creatorHandle}`);
    if (r.cuisine) meta.push(r.cuisine);
    if (r.mealType) meta.push(r.mealType);
    if (meta.length) parts.push(meta.join(' · '), ``);

    if (!r.sourceUrl.startsWith('manual:')) parts.push(`Source: ${r.sourceUrl}`, ``);
    if (r.sourceLanguage) parts.push(`_Translated from ${r.sourceLanguage}._`, ``);

    const inCollections = collectionsByRecipe.get(r.id);
    if (inCollections?.length) parts.push(`Collections: ${inCollections.join(', ')}`, ``);
    if (r.tags?.length) parts.push(`Tags: ${r.tags.join(', ')}`, ``);

    const body = `${ingredientLines(r)}${stepLines(r)}`;
    if (body.trim()) parts.push(body);
    else parts.push(`_No recipe details yet._`, ``);

    if (r.notes) parts.push(`## Notes`, ``, r.notes, ``);
  }

  return parts.join('\n');
}

export interface ImportResult {
  added: number;
  skipped: number;
  collectionsAdded: number;
}

export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBackupError';
  }
}

/**
 * Restore from a previous export (FR-5.2).
 *
 * Additive by design: an existing recipe with the same canonical URL is
 * skipped, never overwritten. Import is a recovery path, and silently
 * replacing edited recipes with older copies would be data loss.
 */
export async function importJson(
  raw: string,
  db: ReelRecipesDb = defaultDb,
): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidBackupError('That file is not valid JSON.');
  }

  const backup = parsed as Partial<Backup>;
  if (!backup || typeof backup !== 'object' || !Array.isArray(backup.recipes)) {
    throw new InvalidBackupError('That does not look like a Cookmark export.');
  }

  const existing = await db.recipes.toArray();
  const seenUrls = new Set(existing.map((r) => r.sourceUrl));
  const seenIds = new Set(existing.map((r) => r.id));

  let added = 0;
  let skipped = 0;

  for (const candidate of backup.recipes) {
    const r = candidate as Partial<Recipe>;
    // Minimum viable row: without these it cannot be displayed or deduped.
    if (!r?.id || !r.sourceUrl || !r.title) {
      skipped++;
      continue;
    }
    if (seenUrls.has(r.sourceUrl) || seenIds.has(r.id)) {
      skipped++;
      continue;
    }

    try {
      await db.recipes.add({
        ...(r as Recipe),
        attempts: r.attempts ?? [],
        extractionMethod: r.extractionMethod ?? 'link_only',
        status: r.status ?? 'needs_attention',
        extractionState: r.extractionState ?? 'settled',
        savedAt: r.savedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      seenUrls.add(r.sourceUrl);
      seenIds.add(r.id);
      added++;
    } catch {
      // One malformed row must not abort the whole restore.
      skipped++;
    }
  }

  let collectionsAdded = 0;
  if (Array.isArray(backup.collections)) {
    const existingIds = new Set((await db.collections.toArray()).map((c) => c.id));
    for (const candidate of backup.collections) {
      const c = candidate as Partial<Collection>;
      if (!c?.id || !c.name || existingIds.has(c.id)) continue;
      try {
        await db.collections.add({
          id: c.id,
          name: c.name,
          recipeIds: Array.isArray(c.recipeIds) ? c.recipeIds : [],
          ...(c.coverRecipeId ? { coverRecipeId: c.coverRecipeId } : {}),
          createdAt: c.createdAt ?? Date.now(),
          updatedAt: c.updatedAt ?? Date.now(),
        });
        collectionsAdded++;
      } catch {
        /* skip a malformed collection rather than failing the import */
      }
    }
  }

  return { added, skipped, collectionsAdded };
}

/** FR-5.3 — wipe everything. Immediate and complete. */
export async function wipeEverything(db: ReelRecipesDb = defaultDb): Promise<void> {
  await db.recipes.clear();
  await db.collections.clear();
}
