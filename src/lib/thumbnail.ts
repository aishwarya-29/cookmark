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
 * The URL a view should render for a recipe's thumbnail, or undefined for none.
 *
 * ALWAYS prefer the cached blob. Rendering Instagram's URL and swapping it for
 * the cached copy afterwards looked equivalent but was not: the browser starts
 * fetching the moment the HTML lands, so an expired URL raced the swap and the
 * error handler frequently won. Putting the right URL in the initial markup
 * removes the race rather than trying to win it.
 *
 * The remote URL stays as the fallback for recipes not cached yet — it works
 * for about four days, which is usually long enough for the backfill to catch
 * up.
 */
export function thumbSrc(r: { id: string; thumbnailUrl?: string }): string | undefined {
  return objectUrls.get(r.id) ?? r.thumbnailUrl;
}

/** True when we hold local bytes, so the img needs no crossorigin dance. */
export function isCached(recipeId: string): boolean {
  return objectUrls.has(recipeId);
}

/**
 * Swap in cached bytes for any `<img data-thumb-for="<recipeId>">` on screen.
 *
 * With {@link thumbSrc} in the views this is now a repair pass rather than the
 * primary path: it covers thumbnails that finished caching after the current
 * render, and clears the `broken` marker on images that failed earlier.
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
      if (img.src !== url) {
        // A lazy image below the fold may not have loaded the remote URL yet;
        // pointing it at local bytes means it never will. Drop the attribute
        // so the swap takes effect immediately rather than on scroll.
        img.removeAttribute('loading');
        img.src = url;
      }
      // The remote URL may have failed before the bytes arrived. Local bytes
      // cannot 403, so clear the marker and let it render.
      clearBroken(img);
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

/** Undo the `broken` marker its container picked up from a failed load. */
function clearBroken(img: HTMLImageElement): void {
  img.closest('.hero, .folder-cover, .card-thumb')?.classList.remove('broken');
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
 * so an image that failed to cache once gets another chance. Sequential: this
 * is background housekeeping, not something worth saturating a phone's
 * connection for.
 *
 * It works through the WHOLE backlog rather than a fixed slice. A per-launch
 * cap of a dozen sounded prudent but quietly lost images: a URL only lives
 * about four days, so anything beyond the cap could expire before enough
 * launches had happened to reach it. Oldest first, because those are the
 * closest to expiring.
 *
 * `onProgress` fires after each success so the caller can re-render as images
 * land instead of waiting for the whole sweep.
 */
export async function backfillThumbnails(
  db: ReelRecipesDb = defaultDb,
  onProgress?: () => void,
): Promise<number> {
  const pending = (await db.recipes.toArray())
    .filter((r) => r.thumbnailUrl && !r.thumbnailBlob)
    .sort((a, b) => a.savedAt - b.savedAt);

  let cached = 0;
  let consecutiveFailures = 0;
  for (const r of pending) {
    if (await cacheThumbnail(r.id, r.thumbnailUrl!, db)) {
      cached++;
      consecutiveFailures = 0;
      // Publish the bytes immediately so the next render picks them up.
      const row = await db.recipes.get(r.id);
      if (row?.thumbnailBlob && !objectUrls.has(r.id)) {
        objectUrls.set(r.id, URL.createObjectURL(row.thumbnailBlob));
      }
      onProgress?.();
    } else if (++consecutiveFailures >= 5) {
      // Five in a row means offline or rate limited, not five dead URLs.
      // Stop and let the next launch try again rather than hammering.
      break;
    }
  }
  return cached;
}
