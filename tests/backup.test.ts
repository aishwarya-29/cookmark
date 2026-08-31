// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ReelRecipesDb } from '../src/data/db';
import { saveReelUrl, updateRecipe } from '../src/data/recipes';
import { createCollection, addToCollection } from '../src/data/collections';
import {
  exportJson,
  exportMarkdown,
  importJson,
  wipeEverything,
  InvalidBackupError,
} from '../src/data/backup';

/**
 * Export and import — FR-5.1, FR-5.2, FR-5.4.
 *
 * This is the disaster-recovery path, so the properties that matter are:
 * a round trip loses nothing, and an import never destroys what is already
 * there.
 */

let db: ReelRecipesDb;
let counter = 0;

async function seed(code: string) {
  const out = await saveReelUrl(`https://www.instagram.com/reel/${code}/`, db);
  if (out.kind !== 'saved') throw new Error('seed failed');
  return out.recipe;
}

beforeEach(async () => {
  db = new ReelRecipesDb(`backup-db-${counter++}`);
  await db.open();
});

describe('exportJson', () => {
  it('includes every recipe and collection', async () => {
    const r = await seed('AAAAAAAAAAA');
    const c = await createCollection('Curries', db);
    await addToCollection(c.id, r.id, db);

    const backup = await exportJson(db);
    expect(backup.recipes).toHaveLength(1);
    expect(backup.collections).toHaveLength(1);
    expect(backup.format).toBe('reel-recipes-backup');
  });

  it('drops the cached thumbnail blob, which cannot survive JSON', async () => {
    const r = await seed('AAAAAAAAAAA');
    await db.recipes.update(r.id, {
      thumbnailUrl: 'https://example.com/t.jpg',
      thumbnailBlob: new Blob(['x']),
    });

    const backup = await exportJson(db);
    expect(backup.recipes[0]!.thumbnailBlob).toBeUndefined();
    // The URL is kept, so the image is re-fetchable.
    expect(backup.recipes[0]!.thumbnailUrl).toBe('https://example.com/t.jpg');
  });

  it('serialises to valid JSON', async () => {
    await seed('AAAAAAAAAAA');
    const backup = await exportJson(db);
    expect(() => JSON.parse(JSON.stringify(backup))).not.toThrow();
  });
});

describe('round trip', () => {
  it('restores recipes and collections into an empty library', async () => {
    const r = await seed('AAAAAAAAAAA');
    await updateRecipe(
      r.id,
      { title: 'Chilli oil noodles', notes: 'Used half the chilli' },
      db,
    );
    const c = await createCollection('Weeknight', db);
    await addToCollection(c.id, r.id, db);

    const json = JSON.stringify(await exportJson(db));
    await wipeEverything(db);
    expect(await db.recipes.count()).toBe(0);

    const result = await importJson(json, db);

    expect(result.added).toBe(1);
    expect(result.collectionsAdded).toBe(1);
    const restored = await db.recipes.toArray();
    expect(restored[0]!.title).toBe('Chilli oil noodles');
    expect(restored[0]!.notes).toBe('Used half the chilli');
  });

  it('preserves collection membership across the round trip', async () => {
    const r = await seed('AAAAAAAAAAA');
    const c = await createCollection('Weeknight', db);
    await addToCollection(c.id, r.id, db);

    const json = JSON.stringify(await exportJson(db));
    await wipeEverything(db);
    await importJson(json, db);

    const restored = await db.collections.toArray();
    expect(restored[0]!.recipeIds).toEqual([r.id]);
  });
});

describe('import is additive and never destructive (FR-5.2)', () => {
  it('skips a recipe already in the library rather than overwriting it', async () => {
    const r = await seed('AAAAAAAAAAA');
    const json = JSON.stringify(await exportJson(db));

    // The user has since edited it. A restore must not revert that.
    await updateRecipe(r.id, { title: 'My edited title' }, db);

    const result = await importJson(json, db);

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await db.recipes.get(r.id))!.title).toBe('My edited title');
  });

  it('keeps existing recipes when importing a different backup', async () => {
    await seed('AAAAAAAAAAA');
    const other = new ReelRecipesDb(`backup-other-${counter++}`);
    await other.open();
    await saveReelUrl('https://www.instagram.com/reel/BBBBBBBBBBB/', other);
    const json = JSON.stringify(await exportJson(other));

    await importJson(json, db);

    expect(await db.recipes.count()).toBe(2);
  });

  it('imports what it can and skips malformed rows', async () => {
    const good = await seed('AAAAAAAAAAA');
    const json = JSON.stringify(await exportJson(db));
    await wipeEverything(db);

    const parsed = JSON.parse(json);
    parsed.recipes.push({ id: 'broken' }); // no sourceUrl, no title
    parsed.recipes.push(null);

    const result = await importJson(JSON.stringify(parsed), db);

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
    expect((await db.recipes.get(good.id))!.id).toBe(good.id);
  });
});

describe('rejecting bad input', () => {
  it('rejects non-JSON', async () => {
    await expect(importJson('not json at all', db)).rejects.toBeInstanceOf(
      InvalidBackupError,
    );
  });

  it('rejects JSON that is not a backup', async () => {
    await expect(importJson('{"hello":"world"}', db)).rejects.toBeInstanceOf(
      InvalidBackupError,
    );
  });

  it('leaves the library untouched when an import is rejected', async () => {
    await seed('AAAAAAAAAAA');
    await expect(importJson('garbage', db)).rejects.toThrow();
    expect(await db.recipes.count()).toBe(1);
  });
});

describe('exportMarkdown', () => {
  it('renders a readable recipe with attribution (NFR-4.2)', async () => {
    const r = await seed('AAAAAAAAAAA');
    await updateRecipe(
      r.id,
      {
        title: 'Chilli oil noodles',
        creatorHandle: 'nonnas_kitchen',
        ingredients: [{ quantity: 300, unit: 'g', item: 'noodles' }],
        steps: ['Boil the noodles.'],
      },
      db,
    );

    const md = await exportMarkdown(db);
    expect(md).toContain('# Chilli oil noodles');
    expect(md).toContain('@nonnas_kitchen');
    expect(md).toContain('300 g noodles');
    expect(md).toContain('1. Boil the noodles.');
    expect(md).toContain('https://www.instagram.com/reel/AAAAAAAAAAA/');
  });

  it('says so plainly for a link-only entry rather than leaving a gap', async () => {
    await seed('AAAAAAAAAAA');
    const md = await exportMarkdown(db);
    expect(md).toContain('No recipe details yet');
  });

  it('formats quantities the way a cook reads them', async () => {
    const r = await seed('AAAAAAAAAAA');
    await updateRecipe(r.id, { ingredients: [{ quantity: 0.5, unit: 'tsp', item: 'salt' }] }, db);
    const md = await exportMarkdown(db);
    expect(md).toContain('½ tsp salt');
  });
});
