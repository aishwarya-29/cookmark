import type { ReelRecipesDb } from '../data/db';
import { db as defaultDb } from '../data/db';
import type { Recipe, ExtractionAttempt } from '../data/types';
import { updateRecipe } from '../data/recipes';
import { getTierConfig, WORKER_URL } from './config';

/**
 * The extraction cascade — PRD §04.
 *
 * Tier 3 is the floor and is implemented here in full. Tiers 1 and 2 are
 * stubs that report "not built yet" and fall through; Steps 4 and 5 fill them
 * in. The cascade structure exists now so that adding a tier is a local change.
 *
 * Invariants this module must never violate:
 *   - It is only ever called on a row that is ALREADY durably saved.
 *   - Every path through it ends with the row in a settled state.
 *   - A thrown error anywhere still leaves the reel saved (NFR-3.4).
 */

/** How long we allow an optional metadata fetch before giving up on it. */
const METADATA_TIMEOUT_MS = 8000;

export interface ReelMetadata {
  creatorHandle?: string;
  thumbnailUrl?: string;
  rawCaption?: string;
  title?: string;
}

/**
 * Optional metadata enrichment. Tier 3 does NOT depend on this succeeding —
 * it is strictly a bonus. Returns null on any failure, and never throws.
 */
async function fetchMetadata(recipe: Recipe): Promise<ReelMetadata | null> {
  if (!WORKER_URL) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${WORKER_URL}/metadata?url=${encodeURIComponent(recipe.sourceUrl)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    return (await res.json()) as ReelMetadata;
  } catch {
    // Offline, timeout, CORS, Worker down, malformed JSON — all the same to
    // Tier 3: we simply have less to show.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 3 — LINK ONLY. Always succeeds.
 *
 * Saves whatever metadata was reachable and settles the row. With no network,
 * no Worker, and no metadata, this still produces a usable library entry
 * containing the URL — which is the whole point (FR-2.6).
 */
async function runTier3(recipe: Recipe, db: ReelRecipesDb): Promise<void> {
  const meta = await fetchMetadata(recipe);

  const attempt: ExtractionAttempt = {
    tier: 3,
    at: Date.now(),
    outcome: 'success', // Tier 3 cannot fail. Metadata is a bonus, not a criterion.
    route: meta ? 'worker_metadata' : 'local_only',
    reason: meta ? undefined : 'No metadata available — saved with the link only',
  };

  const patch: Partial<Recipe> = {
    extractionMethod: 'link_only',
    // A link-only save is a valid outcome, not a failure — but it does want
    // the user's attention eventually, which is what needs_attention means.
    status: 'needs_attention',
    extractionState: 'settled',
    activeTier: undefined,
    attempts: [...recipe.attempts, attempt],
  };

  // Only overwrite fields we actually learned something about, and never
  // clobber a value the user has hand-edited (FR-2.10).
  const edited = new Set(recipe.manuallyEditedFields ?? []);
  if (meta?.creatorHandle && !edited.has('creatorHandle')) {
    patch.creatorHandle = meta.creatorHandle;
  }
  if (meta?.thumbnailUrl && !edited.has('thumbnailUrl')) {
    patch.thumbnailUrl = meta.thumbnailUrl;
  }
  if (meta?.rawCaption && !edited.has('rawCaption')) {
    patch.rawCaption = meta.rawCaption;
  }
  if (meta?.title && !edited.has('title')) {
    patch.title = meta.title;
  }

  await updateRecipe(recipe.id, patch, db);
}

/** Tier 1 — caption. Built in Step 4. */
async function runTier1(_recipe: Recipe): Promise<'not_implemented'> {
  return 'not_implemented';
}

/** Tier 2 — audio. Built in Step 5. */
async function runTier2(_recipe: Recipe): Promise<'not_implemented'> {
  return 'not_implemented';
}

/**
 * Run the cascade for one recipe.
 *
 * Never throws. A failure anywhere degrades to Tier 3, which always succeeds.
 */
export async function extractRecipe(
  recipeId: string,
  db: ReelRecipesDb = defaultDb,
  /**
   * Called whenever the row's visible state changes mid-extraction, so the UI
   * can show which tier is running. Without this the user sees only the initial
   * and final states — unacceptable for Tier 2, which can take minutes.
   */
  onProgress?: () => void,
): Promise<void> {
  const recipe = await db.recipes.get(recipeId);
  if (!recipe) return; // Deleted while queued — nothing to do.

  const tiers = getTierConfig();

  try {
    await updateRecipe(recipeId, { extractionState: 'running', activeTier: 1 }, db);
    onProgress?.();

    // --- Tier 1: caption ---
    if (tiers.caption) {
      const r1 = await runTier1(recipe);
      if (r1 !== 'not_implemented') {
        // Step 4 handles the success path here.
      }
    }

    // --- Tier 2: audio ---
    if (tiers.audio) {
      await updateRecipe(recipeId, { activeTier: 2 }, db);
      onProgress?.();
      const r2 = await runTier2(recipe);
      if (r2 !== 'not_implemented') {
        // Step 5 handles the success path here.
      }
    }

    // --- Tier 3: link only. The floor. ---
    await updateRecipe(recipeId, { activeTier: 3 }, db);
    onProgress?.();
    const fresh = (await db.recipes.get(recipeId)) ?? recipe;
    await runTier3(fresh, db);
  } catch (err) {
    // Something unexpected broke. The reel is still saved — that is the
    // promise. Record why, and settle the row so it is never stuck (NFR-6.3).
    const reason = err instanceof Error ? err.message : String(err);
    try {
      const current = (await db.recipes.get(recipeId)) ?? recipe;
      await updateRecipe(
        recipeId,
        {
          extractionMethod: 'link_only',
          status: 'needs_attention',
          extractionState: 'settled',
          activeTier: undefined,
          attempts: [
            ...current.attempts,
            { tier: 3, at: Date.now(), outcome: 'success', route: 'local_only', reason },
          ],
        },
        db,
      );
    } catch {
      // Even the recovery write failed (storage full, database closed). The
      // row itself is still on disk from the save path, which is what matters.
    }
  }
}

/**
 * Settle every queued row. Called on startup so entries saved during an outage,
 * or while the tab was closed, are picked up (FR-1.6).
 */
export async function processQueue(
  db: ReelRecipesDb = defaultDb,
  onProgress?: () => void,
): Promise<void> {
  const pending = await db.recipes
    .filter((r) => r.extractionState === 'queued' || r.extractionState === 'running')
    .toArray();

  // Sequential on purpose: a burst of parallel requests to Instagram is the
  // fastest way to get rate-limited once Tiers 1 and 2 are live.
  for (const r of pending) {
    await extractRecipe(r.id, db, onProgress);
    onProgress?.();
  }
}
