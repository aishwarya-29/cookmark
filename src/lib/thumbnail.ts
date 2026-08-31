import type { ReelRecipesDb } from '../data/db';
import { db as defaultDb } from '../data/db';

/**
 * Thumbnail caching.
 *
 * Instagram's CDN URLs are SIGNED AND EXPIRING — measured at roughly four days
 * from issue. A saved recipe whose image loaded fine on Monday shows a blank
 * tile by Friday, and the only repair is re-extracting, which fails once the
 * reel is deleted or the account goes private.
 *
 * So the bytes are copied into IndexedDB alongside the recipe. That also makes
 * the library genuinely readable offline (NFR-3.2) — a cached URL is no use in
 * a kitchen with no signal.
 */

/** Skip anything implausibly large for a 640px thumbnail. */
const MAX_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch and store the thumbnail bytes. Never throws — a missing image is a
 * cosmetic loss, and must not affect whether the reel is saved.
 */
export async function cacheThumbnail(
  recipeId: string,
  url: string,
  db: ReelRecipesDb = defaultDb,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Instagram's CDN rejects requests carrying a referrer.
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return false;

    const blob = await res.blob();
    if (!blob.size || blob.size > MAX_BYTES) return false;
    if (!blob.type.startsWith('image/')) return false;

    await db.recipes.update(recipeId, { thumbnailBlob: blob });
    return true;
  } catch {
    // Offline, expired, CORS, rate limited — all cosmetic.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Object URLs by recipe id, reused across renders.
 *
 * Revoking the previous render's URLs turned out to be wrong: the browser may
 * still be decoding an image that points at one, and revoking mid-decode
 * leaves a blank tile (naturalWidth 0). Since a library holds tens of small
 * thumbnails, keeping one URL per recipe alive is cheap and correct — and
 * reusing them means repeated renders allocate nothing new.
 */
const objectUrls = new Map<string, string>();

/**
 * Swap in cached bytes for any `<img data-thumb-for="<recipeId>">` on screen.
 *
 * Done after render rather than during it, so views stay pure string builders
 * and object-URL lifetimes live in exactly one place.
 */
export function hydrateThumbnails(root: ParentNode, db: ReelRecipesDb = defaultDb): void {
  const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-thumb-for]')];
  if (!imgs.length) return;

  // Apply what is already cached SYNCHRONOUSLY. An awaited database read here
  // let a re-render replace these <img> elements mid-flight, so the swap
  // landed on detached nodes and the visible image never loaded.
  const missing: string[] = [];
  for (const img of imgs) {
    const id = img.dataset['thumbFor'];
    if (!id) continue;
    const url = objectUrls.get(id);
    if (url) {
      if (img.src !== url) img.src = url;
    } else {
      missing.push(id);
    }
  }
  if (!missing.length) return;

  // Load any blobs not yet in the map, then re-apply against the CURRENT DOM
  // rather than the elements captured above, which may be gone by then.
  void db.recipes.bulkGet([...new Set(missing)]).then((rows) => {
    let added = false;
    for (const r of rows) {
      if (r?.thumbnailBlob && !objectUrls.has(r.id)) {
        objectUrls.set(r.id, URL.createObjectURL(r.thumbnailBlob));
        added = true;
      }
    }
    if (added) hydrateThumbnails(root, db);
  });
}

/**
 * Load every cached thumbnail into memory up front.
 *
 * Called once at startup so hydration can run synchronously thereafter — the
 * async path exists only for thumbnails cached later in the session.
 */
export async function preloadThumbnails(db: ReelRecipesDb = defaultDb): Promise<void> {
  const rows = await db.recipes.toArray();
  for (const r of rows) {
    if (r.thumbnailBlob && !objectUrls.has(r.id)) {
      objectUrls.set(r.id, URL.createObjectURL(r.thumbnailBlob));
    }
  }
}

/** Release a recipe's cached object URL — call when it is deleted. */
export function releaseThumbnail(recipeId: string): void {
  const url = objectUrls.get(recipeId);
  if (!url) return;
  URL.revokeObjectURL(url);
  objectUrls.delete(recipeId);
}

/**
 * Cache thumbnails for recipes that have a URL but no bytes yet.
 *
 * Run on startup so a library saved before caching existed is repaired, and
 * so an image that failed to cache once gets another chance. Sequential and
 * capped: this is background housekeeping, not something worth saturating a
 * phone's connection for.
 */
export async function backfillThumbnails(
  db: ReelRecipesDb = defaultDb,
  limit = 12,
): Promise<number> {
  const pending = (await db.recipes.toArray())
    .filter((r) => r.thumbnailUrl && !r.thumbnailBlob)
    .slice(0, limit);

  let cached = 0;
  for (const r of pending) {
    if (await cacheThumbnail(r.id, r.thumbnailUrl!, db)) cached++;
  }
  return cached;
}
