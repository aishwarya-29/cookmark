// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ReelRecipesDb } from '../src/data/db';
import {
  thumbSrc,
  isCached,
  hydrateThumbnails,
  preloadThumbnails,
  cacheThumbnail,
  releaseThumbnail,
  backfillThumbnails,
} from '../src/lib/thumbnail';
import type { Recipe } from '../src/data/types';

/**
 * Thumbnail source selection.
 *
 * The bug this file exists to prevent: views rendered Instagram's EXPIRING url
 * and relied on a later swap to substitute cached bytes. The browser starts
 * fetching immediately, so an expired url raced that swap — and the library's
 * onerror handler removed the element outright, deleting an image that was
 * about to work. Hence "sometimes I see it and sometimes I don't".
 *
 * The invariant: when local bytes exist, they are what gets rendered. No race
 * to win, because the correct url is in the markup from the start.
 */

let db: ReelRecipesDb;
let counter = 0;

/** jsdom has no object-URL support; ids are enough to assert selection. */
let created: string[] = [];

beforeEach(async () => {
  db = new ReelRecipesDb(`thumb-test-${++counter}`);
  await db.recipes.clear();
  created = [];

  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (_blob: Blob) => {
      const url = `blob:mock/${++n}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      created = created.filter((u) => u !== url);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function addRecipe(over: Partial<Recipe> = {}): Promise<Recipe> {
  const id = `r${++counter}`;
  const r: Recipe = {
    id,
    title: `Recipe ${id}`,
    sourceUrl: `https://www.instagram.com/reel/${id}/`,
    extractionMethod: 'caption',
    status: 'complete',
    extractionState: 'settled',
    attempts: [],
    savedAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
  await db.recipes.add(r);
  return r;
}

function blob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
}

describe('thumbSrc', () => {
  it('returns undefined when there is no image at all', () => {
    expect(thumbSrc({ id: 'nope' })).toBeUndefined();
  });

  it('falls back to the remote url when nothing is cached', () => {
    const url = 'https://cdn.instagram.com/x.jpg?oe=ABC';
    expect(thumbSrc({ id: 'uncached', thumbnailUrl: url })).toBe(url);
  });

  it('PREFERS cached bytes over the remote url — the core invariant', async () => {
    const r = await addRecipe({
      thumbnailUrl: 'https://cdn.instagram.com/expiring.jpg?oe=DEAD',
      thumbnailBlob: blob(),
    });
    await preloadThumbnails(db);

    const src = thumbSrc(r);
    expect(src).toMatch(/^blob:/);
    expect(src).not.toContain('instagram.com');
    expect(isCached(r.id)).toBe(true);
  });

  it('serves a cached image even with no remote url left to fall back on', async () => {
    const r = await addRecipe({ thumbnailBlob: blob() });
    await preloadThumbnails(db);
    expect(thumbSrc(r)).toMatch(/^blob:/);
  });

  it('reuses one object url per recipe rather than allocating per call', async () => {
    const r = await addRecipe({ thumbnailBlob: blob() });
    await preloadThumbnails(db);
    expect(thumbSrc(r)).toBe(thumbSrc(r));
    expect(created).toHaveLength(1);
  });

  it('stops claiming a cache after the recipe is released', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg', thumbnailBlob: blob() });
    await preloadThumbnails(db);
    expect(isCached(r.id)).toBe(true);

    releaseThumbnail(r.id);
    expect(isCached(r.id)).toBe(false);
    // Falls back to the remote url rather than a revoked blob url.
    expect(thumbSrc(r)).toBe('https://cdn/x.jpg');
  });
});

describe('hydrateThumbnails', () => {
  it('clears the broken marker once cached bytes are available', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg', thumbnailBlob: blob() });
    await preloadThumbnails(db);

    // A card whose remote url already 403'd before the bytes landed.
    document.body.innerHTML = `
      <a class="card-thumb broken"><img data-thumb-for="${r.id}" src="https://cdn/x.jpg" /></a>`;

    hydrateThumbnails(document, db);

    const wrap = document.querySelector('.card-thumb')!;
    expect(wrap.classList.contains('broken')).toBe(false);
    expect(document.querySelector('img')!.src).toMatch(/^blob:/);
  });

  it('drops loading="lazy" when swapping in local bytes', async () => {
    const r = await addRecipe({ thumbnailBlob: blob() });
    await preloadThumbnails(db);

    // A lazy image below the fold: left lazy, the swap would not take effect
    // until scrolled into view, so the tile stays blank.
    document.body.innerHTML = `<img data-thumb-for="${r.id}" loading="lazy" src="https://cdn/x.jpg" />`;

    hydrateThumbnails(document, db);

    const img = document.querySelector('img')!;
    expect(img.hasAttribute('loading')).toBe(false);
    expect(img.src).toMatch(/^blob:/);
  });

  it('leaves an uncached image on its remote url', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg' });
    document.body.innerHTML = `<img data-thumb-for="${r.id}" src="https://cdn/x.jpg" />`;

    hydrateThumbnails(document, db);

    expect(document.querySelector('img')!.src).toBe('https://cdn/x.jpg');
  });

  it('does not throw when the DOM holds no thumbnails', () => {
    document.body.innerHTML = '<p>nothing here</p>';
    expect(() => hydrateThumbnails(document, db)).not.toThrow();
  });
});

describe('cacheThumbnail', () => {
  it('rejects a non-image response rather than storing HTML as a thumbnail', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['<html>login</html>'], { type: 'text/html' }),
      }),
    );

    expect(await cacheThumbnail(r.id, 'https://cdn/x.jpg', db)).toBe(false);
    expect((await db.recipes.get(r.id))!.thumbnailBlob).toBeUndefined();
  });

  it('reports failure rather than throwing when the url has expired', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    expect(await cacheThumbnail(r.id, 'https://cdn/x.jpg', db)).toBe(false);
  });

  it('stores the bytes on success', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob() }),
    );

    expect(await cacheThumbnail(r.id, 'https://cdn/x.jpg', db)).toBe(true);
    // Asserted as "something was stored" rather than instanceof Blob:
    // fake-indexeddb structured-clones the value, and the clone is not a jsdom
    // Blob. What matters is that the row now holds bytes.
    expect((await db.recipes.get(r.id))!.thumbnailBlob).toBeDefined();
  });
});

describe('backfillThumbnails', () => {
  it('works through the whole backlog, not a fixed slice', async () => {
    // A cap of 12 per launch meant a larger library could never finish before
    // its urls expired.
    for (let i = 0; i < 20; i++) {
      await addRecipe({ thumbnailUrl: `https://cdn/${i}.jpg` });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob() }),
    );

    expect(await backfillThumbnails(db)).toBe(20);
    expect((await db.recipes.toArray()).every((r) => r.thumbnailBlob)).toBe(true);
  });

  it('caches oldest first, since those urls expire soonest', async () => {
    const old = await addRecipe({ thumbnailUrl: 'https://cdn/old.jpg', savedAt: 1_000 });
    const recent = await addRecipe({ thumbnailUrl: 'https://cdn/new.jpg', savedAt: 9_000 });

    const order: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        order.push(url);
        return Promise.resolve({ ok: true, blob: async () => blob() });
      }),
    );

    await backfillThumbnails(db);
    expect(order).toEqual(['https://cdn/old.jpg', 'https://cdn/new.jpg']);
    expect(old.savedAt).toBeLessThan(recent.savedAt);
  });

  it('gives up after repeated failures rather than hammering an offline network', async () => {
    for (let i = 0; i < 20; i++) {
      await addRecipe({ thumbnailUrl: `https://cdn/${i}.jpg` });
    }
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await backfillThumbnails(db)).toBe(0);
    // Stops at the 5-failure threshold instead of trying all 20.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('skips recipes that already hold bytes', async () => {
    await addRecipe({ thumbnailUrl: 'https://cdn/a.jpg', thumbnailBlob: blob() });
    await addRecipe({ thumbnailUrl: 'https://cdn/b.jpg' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, blob: async () => blob() });
    vi.stubGlobal('fetch', fetchMock);

    expect(await backfillThumbnails(db)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn/b.jpg', expect.anything());
  });

  it('reports progress as each image lands, so the UI can re-render', async () => {
    for (let i = 0; i < 3; i++) {
      await addRecipe({ thumbnailUrl: `https://cdn/${i}.jpg` });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob() }),
    );

    const onProgress = vi.fn();
    await backfillThumbnails(db, onProgress);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('publishes bytes to the cache immediately, without waiting for a reload', async () => {
    const r = await addRecipe({ thumbnailUrl: 'https://cdn/x.jpg' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: async () => blob() }),
    );

    expect(isCached(r.id)).toBe(false);
    await backfillThumbnails(db);
    // thumbSrc must serve the new bytes on the very next render.
    expect(isCached(r.id)).toBe(true);
    expect(thumbSrc(r)).toMatch(/^blob:/);
  });
});
