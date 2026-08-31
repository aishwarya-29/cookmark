import type { ReelRecipesDb } from './db';
import { db as defaultDb } from './db';
import type { Collection, Recipe } from './types';
import { newId } from '../lib/id';

/**
 * Collections — PRD FR-3.5. User-defined groupings, manual, no auto-curation.
 *
 * Membership lives on the collection rather than the recipe, so adding to a
 * collection never rewrites a recipe row — which matters because recipe rows
 * carry the user's own edits and cook-mode progress.
 */

export async function listCollections(db: ReelRecipesDb = defaultDb): Promise<Collection[]> {
  const all = await db.collections.toArray();
  // Most recently touched first: the collection you are filling is the one
  // you want to see.
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCollection(
  id: string,
  db: ReelRecipesDb = defaultDb,
): Promise<Collection | undefined> {
  return db.collections.get(id);
}

export async function createCollection(
  name: string,
  db: ReelRecipesDb = defaultDb,
): Promise<Collection> {
  const now = Date.now();
  const collection: Collection = {
    id: newId(),
    name: name.trim() || 'Untitled collection',
    recipeIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await db.collections.add(collection);
  return collection;
}

export async function renameCollection(
  id: string,
  name: string,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await db.collections.update(id, { name: trimmed, updatedAt: Date.now() });
}

/** Deletes the grouping only — the recipes inside are never touched. */
export async function deleteCollection(
  id: string,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  await db.collections.delete(id);
}

export async function addToCollection(
  collectionId: string,
  recipeId: string,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  const c = await db.collections.get(collectionId);
  if (!c || c.recipeIds.includes(recipeId)) return;
  await db.collections.update(collectionId, {
    recipeIds: [...c.recipeIds, recipeId],
    updatedAt: Date.now(),
  });
}

export async function removeFromCollection(
  collectionId: string,
  recipeId: string,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  const c = await db.collections.get(collectionId);
  if (!c) return;
  await db.collections.update(collectionId, {
    recipeIds: c.recipeIds.filter((id) => id !== recipeId),
    updatedAt: Date.now(),
  });
}

/** Toggle membership — what a checkbox in the "add to collection" sheet does. */
export async function toggleInCollection(
  collectionId: string,
  recipeId: string,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  const c = await db.collections.get(collectionId);
  if (!c) return;
  if (c.recipeIds.includes(recipeId)) {
    await removeFromCollection(collectionId, recipeId, db);
  } else {
    await addToCollection(collectionId, recipeId, db);
  }
}

/**
 * Drop a deleted recipe from every collection it belonged to, so folders
 * never count or cover-image a row that no longer exists.
 */
export async function purgeRecipe(
  recipeId: string,
  db: ReelRecipesDb = defaultDb,
): Promise<void> {
  const affected = (await db.collections.toArray()).filter((c) =>
    c.recipeIds.includes(recipeId),
  );
  for (const c of affected) {
    await db.collections.update(c.id, {
      recipeIds: c.recipeIds.filter((id) => id !== recipeId),
      ...(c.coverRecipeId === recipeId ? { coverRecipeId: undefined } : {}),
      updatedAt: Date.now(),
    });
  }
}

/** The recipes in a collection, in the order they were added. */
export function recipesIn(collection: Collection, all: Recipe[]): Recipe[] {
  const byId = new Map(all.map((r) => [r.id, r]));
  return collection.recipeIds
    .map((id) => byId.get(id))
    .filter((r): r is Recipe => r !== undefined);
}

/**
 * The image for a folder tile: the user's chosen cover, else the most recent
 * member with a thumbnail. A collection should look right without the user
 * having to pick one.
 */
export function coverFor(collection: Collection, all: Recipe[]): string | undefined {
  const members = recipesIn(collection, all);
  if (collection.coverRecipeId) {
    const chosen = members.find((r) => r.id === collection.coverRecipeId);
    if (chosen?.thumbnailUrl) return chosen.thumbnailUrl;
  }
  return [...members].reverse().find((r) => r.thumbnailUrl)?.thumbnailUrl;
}

/** Which collections a recipe belongs to — for the detail view. */
export function collectionsFor(recipeId: string, collections: Collection[]): Collection[] {
  return collections.filter((c) => c.recipeIds.includes(recipeId));
}
