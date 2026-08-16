import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ReelRecipesDb } from '../src/data/db';
import { saveReelUrl, listRecipes, deleteRecipe, updateRecipe } from '../src/data/recipes';
import { InvalidInstagramUrlError } from '../src/lib/url';

let db: ReelRecipesDb;
let dbCounter = 0;

beforeEach(async () => {
  // A fresh database per test — no cross-test state.
  db = new ReelRecipesDb(`test-db-${dbCounter++}`);
  await db.open();
});

describe('saveReelUrl — durability before extraction (NFR-3.1)', () => {
  it('writes a row immediately, with nothing extracted yet', async () => {
    const out = await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    expect(out.kind).toBe('saved');

    const rows = await listRecipes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceUrl).toBe('https://www.instagram.com/reel/Cx1y2Z3aBcD/');
    expect(rows[0]!.extractionState).toBe('queued');
    expect(rows[0]!.extractionMethod).toBe('pending');
  });

  it('stores the canonical URL, not the pasted one', async () => {
    await saveReelUrl('https://instagram.com/reels/Cx1y2Z3aBcD?igsh=AAA', db);
    const rows = await listRecipes(db);
    expect(rows[0]!.sourceUrl).toBe('https://www.instagram.com/reel/Cx1y2Z3aBcD/');
  });

  it('gives every row a title, even with nothing extracted', async () => {
    await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    const rows = await listRecipes(db);
    expect(rows[0]!.title).toBeTruthy();
  });

  it('uses the creator handle in the provisional title when the URL carries one', async () => {
    await saveReelUrl('https://www.instagram.com/nonnas_kitchen/reel/Cx1y2Z3aBcD/', db);
    const rows = await listRecipes(db);
    expect(rows[0]!.title).toContain('nonnas_kitchen');
    expect(rows[0]!.creatorHandle).toBe('nonnas_kitchen');
  });
});

describe('duplicate detection (FR-2.2)', () => {
  it('returns the existing recipe rather than creating a second row', async () => {
    const first = await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    const second = await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);

    expect(second.kind).toBe('duplicate');
    if (second.kind === 'duplicate' && first.kind === 'saved') {
      expect(second.existing.id).toBe(first.recipe.id);
    }
    expect(await listRecipes(db)).toHaveLength(1);
  });

  it('detects a duplicate across different URL forms of the same reel', async () => {
    await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    const dup = await saveReelUrl('https://instagram.com/p/Cx1y2Z3aBcD/?igsh=xyz', db);
    expect(dup.kind).toBe('duplicate');
    expect(await listRecipes(db)).toHaveLength(1);
  });

  it('treats different reels as different rows', async () => {
    await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    await saveReelUrl('https://www.instagram.com/reel/Dy9z8Y7bCdE/', db);
    expect(await listRecipes(db)).toHaveLength(2);
  });
});

describe('invalid input', () => {
  it('throws rather than saving a junk row', async () => {
    await expect(saveReelUrl('chicken curry', db)).rejects.toThrow(InvalidInstagramUrlError);
    expect(await listRecipes(db)).toHaveLength(0);
  });

  it('throws for a non-Instagram link', async () => {
    await expect(saveReelUrl('https://tiktok.com/@a/video/1', db)).rejects.toThrow();
    expect(await listRecipes(db)).toHaveLength(0);
  });
});

describe('/share/ links', () => {
  it('saves an unresolved share link rather than rejecting it', async () => {
    const out = await saveReelUrl('https://www.instagram.com/share/reel/_AbC123xyz/', db);
    expect(out.kind).toBe('saved');
    const rows = await listRecipes(db);
    expect(rows[0]!.unresolvedShareLink).toBe(true);
  });
});

describe('listing and mutation', () => {
  it('lists newest first (FR-3.1)', async () => {
    const a = await saveReelUrl('https://www.instagram.com/reel/AAAAAAAAAAA/', db);
    // Force distinct timestamps — savedAt has millisecond resolution.
    if (a.kind === 'saved') await updateRecipe(a.recipe.id, { savedAt: 1000 }, db);
    const b = await saveReelUrl('https://www.instagram.com/reel/BBBBBBBBBBB/', db);
    if (b.kind === 'saved') await updateRecipe(b.recipe.id, { savedAt: 2000 }, db);

    const rows = await listRecipes(db);
    expect(rows[0]!.sourceUrl).toContain('BBBBBBBBBBB');
  });

  it('deletes completely (FR-5.3)', async () => {
    const out = await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    if (out.kind === 'saved') await deleteRecipe(out.recipe.id, db);
    expect(await listRecipes(db)).toHaveLength(0);
  });

  it('stamps updatedAt on every patch', async () => {
    const out = await saveReelUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/', db);
    if (out.kind !== 'saved') throw new Error('setup failed');
    await updateRecipe(out.recipe.id, { title: 'Chilli oil noodles' }, db);
    const row = await db.recipes.get(out.recipe.id);
    expect(row!.title).toBe('Chilli oil noodles');
    expect(row!.updatedAt).toBeGreaterThanOrEqual(out.recipe.updatedAt);
  });
});
