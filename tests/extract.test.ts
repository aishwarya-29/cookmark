// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ReelRecipesDb } from '../src/data/db';
import { saveReelUrl } from '../src/data/recipes';
import { extractRecipe, processQueue, reExtract } from '../src/lib/extract';

/**
 * Tier 3 is the floor the whole product stands on. These tests exist to prove
 * the one guarantee that matters: a save survives anything.
 */

let db: ReelRecipesDb;
let counter = 0;

async function seed(url = 'https://www.instagram.com/reel/Cx1y2Z3aBcD/') {
  const out = await saveReelUrl(url, db);
  if (out.kind !== 'saved') throw new Error('seed failed');
  return out.recipe;
}

beforeEach(async () => {
  db = new ReelRecipesDb(`extract-db-${counter++}`);
  await db.open();
  localStorage.clear();
  // Never let the suite hit the real network: it makes tests slow, flaky, and
  // dependent on Instagram being reachable. Individual tests override this.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tier 3 always succeeds (FR-2.6)', () => {
  it('settles a queued row with no Worker configured', async () => {
    const r = await seed();
    await extractRecipe(r.id, db);

    const row = await db.recipes.get(r.id);
    expect(row!.extractionState).toBe('settled');
    expect(row!.extractionMethod).toBe('link_only');
    expect(row!.activeTier).toBeUndefined();
  });

  it('survives a total network failure and still keeps the reel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const r = await seed();

    await extractRecipe(r.id, db);

    const row = await db.recipes.get(r.id);
    expect(row).toBeDefined();
    expect(row!.sourceUrl).toBe('https://www.instagram.com/reel/Cx1y2Z3aBcD/');
    expect(row!.extractionState).toBe('settled');
  });

  it('records why metadata was unavailable, for later debugging (NFR-6.3)', async () => {
    const r = await seed();
    await extractRecipe(r.id, db);

    const row = await db.recipes.get(r.id);
    // Tier 1 may also have logged an attempt when a Worker is configured; the
    // guarantee under test is that Tier 3 always records a settling attempt.
    const tier3 = row!.attempts.filter((a) => a.tier === 3);
    expect(tier3).toHaveLength(1);
    expect(tier3[0]!.outcome).toBe('success');
    expect(tier3[0]!.reason).toContain('link only');
  });

  it('never leaves a row stuck in running', async () => {
    const r = await seed();
    await extractRecipe(r.id, db);
    const row = await db.recipes.get(r.id);
    expect(row!.extractionState).not.toBe('running');
    expect(row!.extractionState).not.toBe('queued');
  });

  it('tolerates the recipe being deleted mid-extraction', async () => {
    const r = await seed();
    await db.recipes.delete(r.id);
    await expect(extractRecipe(r.id, db)).resolves.toBeUndefined();
  });
});

describe('never destroys user data (FR-2.10)', () => {
  it('does not overwrite a hand-edited title', async () => {
    const r = await seed();
    await db.recipes.update(r.id, {
      title: 'Nan’s chilli oil',
      manuallyEditedFields: ['title'],
    });

    // A Worker that returns a different title must not win over the user's.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'Some scraped title' }),
      }),
    );

    await extractRecipe(r.id, db);
    const row = await db.recipes.get(r.id);
    expect(row!.title).toBe('Nan’s chilli oil');
  });

  it('keeps the reel even when the metadata response is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    const r = await seed();
    await extractRecipe(r.id, db);

    const row = await db.recipes.get(r.id);
    expect(row!.extractionState).toBe('settled');
    expect(row!.sourceUrl).toBeTruthy();
  });
});

describe('re-extraction (FR-2.9)', () => {
  it('settles the row again without losing the reel', async () => {
    const r = await seed();
    await extractRecipe(r.id, db);
    await reExtract(r.id, db);

    const row = await db.recipes.get(r.id);
    expect(row!.sourceUrl).toBe('https://www.instagram.com/reel/Cx1y2Z3aBcD/');
    expect(row!.extractionState).toBe('settled');
  });

  it('records a second attempt rather than replacing the first', async () => {
    const r = await seed();
    await extractRecipe(r.id, db);
    const first = (await db.recipes.get(r.id))!.attempts.length;

    await reExtract(r.id, db);

    const row = await db.recipes.get(r.id);
    expect(row!.attempts.length).toBeGreaterThan(first);
  });

  it('never overwrites a hand-edited field', async () => {
    const r = await seed();
    await db.recipes.update(r.id, {
      title: 'Nan’s chilli oil',
      notes: 'Used half the chilli',
      manuallyEditedFields: ['title', 'notes'],
    });

    await reExtract(r.id, db);

    const row = await db.recipes.get(r.id);
    expect(row!.title).toBe('Nan’s chilli oil');
    expect(row!.notes).toBe('Used half the chilli');
  });

  it('does nothing for a deleted recipe', async () => {
    const r = await seed();
    await db.recipes.delete(r.id);
    await expect(reExtract(r.id, db)).resolves.toBeUndefined();
  });
});

describe('processQueue (FR-1.6)', () => {
  it('settles everything left queued from a previous session', async () => {
    await seed('https://www.instagram.com/reel/AAAAAAAAAAA/');
    await seed('https://www.instagram.com/reel/BBBBBBBBBBB/');
    await seed('https://www.instagram.com/reel/CCCCCCCCCCC/');

    await processQueue(db);

    const rows = await db.recipes.toArray();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.extractionState === 'settled')).toBe(true);
  });

  it('picks up a row stranded in running by a closed tab', async () => {
    const r = await seed();
    await db.recipes.update(r.id, { extractionState: 'running', activeTier: 2 });

    await processQueue(db);

    const row = await db.recipes.get(r.id);
    expect(row!.extractionState).toBe('settled');
  });

  it('does nothing to already-settled rows', async () => {
    const r = await seed();
    await extractRecipe(r.id, db);
    const after = await db.recipes.get(r.id);

    await processQueue(db);

    const again = await db.recipes.get(r.id);
    expect(again!.attempts).toHaveLength(after!.attempts.length);
  });
});
