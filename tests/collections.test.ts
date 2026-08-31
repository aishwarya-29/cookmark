// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ReelRecipesDb } from '../src/data/db';
import { saveReelUrl, deleteRecipe } from '../src/data/recipes';
import {
  createCollection,
  listCollections,
  addToCollection,
  removeFromCollection,
  toggleInCollection,
  deleteCollection,
  renameCollection,
  recipesIn,
  coverFor,
  collectionsFor,
} from '../src/data/collections';

/**
 * Collections — FR-3.5. The property that matters most: a collection is only
 * a grouping, so removing or deleting one must never touch the recipes.
 */

let db: ReelRecipesDb;
let counter = 0;

async function seedRecipe(code: string) {
  const out = await saveReelUrl(`https://www.instagram.com/reel/${code}/`, db);
  if (out.kind !== 'saved') throw new Error('seed failed');
  return out.recipe;
}

beforeEach(async () => {
  db = new ReelRecipesDb(`collections-db-${counter++}`);
  await db.open();
});

describe('creating and listing', () => {
  it('creates a collection with no members', async () => {
    const c = await createCollection('Weeknight dinners', db);
    expect(c.name).toBe('Weeknight dinners');
    expect(c.recipeIds).toEqual([]);
  });

  it('falls back to a placeholder name rather than an empty one', async () => {
    const c = await createCollection('   ', db);
    expect(c.name).toBe('Untitled collection');
  });

  it('lists most recently updated first', async () => {
    const a = await createCollection('A', db);
    await createCollection('B', db);
    // Touching A should float it to the top.
    await renameCollection(a.id, 'A renamed', db);

    const list = await listCollections(db);
    expect(list[0]!.name).toBe('A renamed');
  });
});

describe('membership', () => {
  it('adds and removes a recipe', async () => {
    const c = await createCollection('Curries', db);
    const r = await seedRecipe('AAAAAAAAAAA');

    await addToCollection(c.id, r.id, db);
    expect((await db.collections.get(c.id))!.recipeIds).toEqual([r.id]);

    await removeFromCollection(c.id, r.id, db);
    expect((await db.collections.get(c.id))!.recipeIds).toEqual([]);
  });

  it('does not add the same recipe twice', async () => {
    const c = await createCollection('Curries', db);
    const r = await seedRecipe('AAAAAAAAAAA');

    await addToCollection(c.id, r.id, db);
    await addToCollection(c.id, r.id, db);

    expect((await db.collections.get(c.id))!.recipeIds).toHaveLength(1);
  });

  it('toggles membership both ways', async () => {
    const c = await createCollection('Curries', db);
    const r = await seedRecipe('AAAAAAAAAAA');

    await toggleInCollection(c.id, r.id, db);
    expect((await db.collections.get(c.id))!.recipeIds).toHaveLength(1);

    await toggleInCollection(c.id, r.id, db);
    expect((await db.collections.get(c.id))!.recipeIds).toHaveLength(0);
  });

  it('lets a recipe belong to several collections', async () => {
    const a = await createCollection('Quick', db);
    const b = await createCollection('Spicy', db);
    const r = await seedRecipe('AAAAAAAAAAA');

    await addToCollection(a.id, r.id, db);
    await addToCollection(b.id, r.id, db);

    const all = await listCollections(db);
    expect(collectionsFor(r.id, all)).toHaveLength(2);
  });
});

describe('a collection is only a grouping', () => {
  it('deleting a collection leaves its recipes in the library', async () => {
    const c = await createCollection('Curries', db);
    const r = await seedRecipe('AAAAAAAAAAA');
    await addToCollection(c.id, r.id, db);

    await deleteCollection(c.id, db);

    expect(await db.recipes.get(r.id)).toBeDefined();
    expect(await listCollections(db)).toHaveLength(0);
  });

  it('deleting a recipe removes it from every collection', async () => {
    const a = await createCollection('Quick', db);
    const b = await createCollection('Spicy', db);
    const r = await seedRecipe('AAAAAAAAAAA');
    await addToCollection(a.id, r.id, db);
    await addToCollection(b.id, r.id, db);

    await deleteRecipe(r.id, db);

    const all = await listCollections(db);
    expect(all.every((c) => c.recipeIds.length === 0)).toBe(true);
  });
});

describe('recipesIn and coverFor', () => {
  it('returns members in the order they were added', async () => {
    const c = await createCollection('Curries', db);
    const r1 = await seedRecipe('AAAAAAAAAAA');
    const r2 = await seedRecipe('BBBBBBBBBBB');
    await addToCollection(c.id, r2.id, db);
    await addToCollection(c.id, r1.id, db);

    const all = await db.recipes.toArray();
    const fresh = (await db.collections.get(c.id))!;
    expect(recipesIn(fresh, all).map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it('ignores members whose recipe has vanished', async () => {
    const c = await createCollection('Curries', db);
    const r = await seedRecipe('AAAAAAAAAAA');
    await addToCollection(c.id, r.id, db);

    const stale = { ...(await db.collections.get(c.id))!, recipeIds: ['gone', r.id] };
    const all = await db.recipes.toArray();
    expect(recipesIn(stale, all)).toHaveLength(1);
  });

  it('uses the newest member with a thumbnail as the cover', async () => {
    const c = await createCollection('Curries', db);
    const r1 = await seedRecipe('AAAAAAAAAAA');
    const r2 = await seedRecipe('BBBBBBBBBBB');
    await db.recipes.update(r1.id, { thumbnailUrl: 'first.jpg' });
    await db.recipes.update(r2.id, { thumbnailUrl: 'second.jpg' });
    await addToCollection(c.id, r1.id, db);
    await addToCollection(c.id, r2.id, db);

    const all = await db.recipes.toArray();
    const fresh = (await db.collections.get(c.id))!;
    expect(coverFor(fresh, all)).toBe('second.jpg');
  });

  it('has no cover when nothing inside has a thumbnail', async () => {
    const c = await createCollection('Curries', db);
    const r = await seedRecipe('AAAAAAAAAAA');
    await addToCollection(c.id, r.id, db);

    const all = await db.recipes.toArray();
    const fresh = (await db.collections.get(c.id))!;
    expect(coverFor(fresh, all)).toBeUndefined();
  });
});
