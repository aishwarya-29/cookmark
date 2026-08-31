import type { ReelRecipesDb } from '../data/db';
import { db as defaultDb } from '../data/db';
import type { Recipe, ExtractionAttempt, Ingredient } from '../data/types';
import { updateRecipe } from '../data/recipes';
import { getTierConfig, WORKER_URL } from './config';
import { parseCaption } from './parse-caption';

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

/**
 * Tier 1 does an Instagram fetch AND a 70B model round-trip. Measured latency
 * is well under this, but the ceiling is generous on purpose: a slow
 * extraction costs nothing (the save is already durable and the user has moved
 * on), while a premature timeout throws away a good result.
 */
const TIER1_TIMEOUT_MS = 100_000;

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

export interface ExtractResponse {
  creatorHandle?: string;
  displayName?: string;
  thumbnailUrl?: string;
  rawCaption?: string;
  title?: string;
  ingredients?: Ingredient[];
  steps?: string[];
  sourceLanguage?: string;
  translated?: boolean;
  cuisine?: string;
  mealType?: string;
  tags?: string[];
  route?: string;
  parseError?: 'quota_exhausted' | 'parse_failed' | 'no_caption';
}

type Tier1Result =
  | { kind: 'skipped' }
  | { kind: 'complete' | 'partial'; patch: Partial<Recipe>; attempt: ExtractionAttempt }
  | { kind: 'none'; caption?: string; meta?: ExtractResponse }
  | { kind: 'failed'; permanent: boolean; reason: string };

/**
 * Tier 1 — CAPTION.
 *
 * Two sub-tiers, so a Workers AI outage or an exhausted daily allowance
 * degrades to the local regex parser rather than to nothing (NFR-1.4):
 *
 *   1a  LLM parse in the Worker — handles prose, inline quantities, and
 *       non-English captions in a single pass.
 *   1b  Local regex parse — no network, works offline, lower yield.
 *
 * Qualifying rule (FR-2.3): >= 2 ingredients AND >= 1 step qualifies.
 * Ingredients alone is PARTIAL — saved and flagged, and explicitly NOT
 * passed down to audio.
 */
async function runTier1(recipe: Recipe): Promise<Tier1Result> {
  if (!WORKER_URL) return { kind: 'skipped' };

  let data: ExtractResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIER1_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${WORKER_URL}/extract?url=${encodeURIComponent(recipe.sourceUrl)}`,
        { signal: controller.signal },
      );
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          kind: 'failed',
          permanent: true,
          reason: body.error ?? 'This post is private or has been deleted',
        };
      }
      if (res.status === 429) {
        return {
          kind: 'failed',
          permanent: false,
          reason: 'Instagram is busy right now — this will retry automatically',
        };
      }
      if (!res.ok) {
        return { kind: 'failed', permanent: false, reason: `Worker returned ${res.status}` };
      }
      data = (await res.json()) as ExtractResponse;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? 'Extraction timed out'
        : 'Could not reach the extraction service';
    return { kind: 'failed', permanent: false, reason };
  }

  let ingredients = data.ingredients ?? [];
  let steps = data.steps ?? [];
  let title = data.title;
  let route = data.route ?? 'worker';
  let sourceLanguage = data.sourceLanguage;
  let translated = data.translated;

  // --- Tier 1b: local regex parse, when the LLM was unavailable or found
  // nothing but we do have a caption to work with. ---
  if ((!ingredients.length || !steps.length) && data.rawCaption) {
    const local = parseCaption(data.rawCaption);
    if (local.ingredients.length > ingredients.length || local.steps.length > steps.length) {
      if (local.ingredients.length > ingredients.length) ingredients = local.ingredients;
      if (local.steps.length > steps.length) steps = local.steps;
      if (!title && local.title) title = local.title;
      route = data.parseError ? `local_regex (${data.parseError})` : `${route}+local_regex`;
      // The local parser cannot translate.
      sourceLanguage = data.sourceLanguage;
      translated = data.translated;
    }
  }

  const edited = new Set(recipe.manuallyEditedFields ?? []);
  const patch: Partial<Recipe> = {};
  if (data.creatorHandle && !edited.has('creatorHandle')) patch.creatorHandle = data.creatorHandle;
  if (data.thumbnailUrl && !edited.has('thumbnailUrl')) patch.thumbnailUrl = data.thumbnailUrl;
  if (data.rawCaption && !edited.has('rawCaption')) patch.rawCaption = data.rawCaption;

  const qualifies = ingredients.length >= 2 && steps.length >= 1;
  const isPartial = ingredients.length >= 2 && steps.length === 0;

  if (!qualifies && !isPartial) {
    return { kind: 'none', ...(data.rawCaption ? { caption: data.rawCaption } : {}), meta: data };
  }

  // The model returns no title when the caption opens with a series name or a
  // hook rather than a dish name. Fall back to the local parser's guess, then
  // to the creator handle, rather than leaving the provisional "Saved reel".
  if (!title && data.rawCaption) title = parseCaption(data.rawCaption).title;
  if (title && !edited.has('title')) patch.title = title;
  if (!edited.has('ingredients')) patch.ingredients = ingredients;
  if (!edited.has('steps')) patch.steps = steps;
  if (sourceLanguage) patch.sourceLanguage = sourceLanguage;

  // FR-3.7 — suggestions, never silent assignment. These sit in `suggested`
  // until the user accepts them; a library that reorganises itself is
  // unsettling, and a wrong auto-tag erodes trust faster than a missing one.
  const suggested: NonNullable<Recipe['suggested']> = {};
  if (data.cuisine && !recipe.cuisine) suggested.cuisine = data.cuisine;
  if (data.mealType && !recipe.mealType) suggested.mealType = data.mealType;
  const newTags = (data.tags ?? []).filter((t) => !(recipe.tags ?? []).includes(t));
  if (newTags.length) suggested.tags = newTags;
  if (suggested.cuisine || suggested.mealType || suggested.tags?.length) {
    patch.suggested = suggested;
  }

  patch.extractionMethod = translated ? 'audio_translated' : 'caption';
  patch.status = qualifies ? 'complete' : 'partial';
  patch.extractionState = 'settled';
  patch.activeTier = undefined;

  return {
    kind: qualifies ? 'complete' : 'partial',
    patch,
    attempt: {
      tier: 1,
      at: Date.now(),
      outcome: qualifies ? 'success' : 'partial',
      route,
      ...(isPartial ? { reason: 'Caption had ingredients but no method steps' } : {}),
    },
  };
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

      if (r1.kind === 'complete' || r1.kind === 'partial') {
        await updateRecipe(
          recipeId,
          { ...r1.patch, attempts: [...recipe.attempts, r1.attempt] },
          db,
        );
        // PARTIAL stops here by design (FR-2.3): ingredients without a method
        // must be saved and flagged, NOT passed down to audio.
        return;
      }

      if (r1.kind === 'failed' && r1.permanent) {
        // Private or deleted. Retrying will never help, and Tier 2 needs the
        // same media, so stop — but the reel itself is still saved.
        await updateRecipe(
          recipeId,
          {
            extractionMethod: 'link_only',
            status: 'needs_attention',
            extractionState: 'failed_permanent',
            activeTier: undefined,
            attempts: [
              ...recipe.attempts,
              { tier: 1, at: Date.now(), outcome: 'failure', reason: r1.reason },
            ],
          },
          db,
        );
        return;
      }

      if (r1.kind === 'failed') {
        // Retryable — record it and let the cascade continue.
        await updateRecipe(
          recipeId,
          {
            attempts: [
              ...recipe.attempts,
              { tier: 1, at: Date.now(), outcome: 'failure', reason: r1.reason },
            ],
          },
          db,
        );
      } else if (r1.kind === 'none') {
        // Caption held no recipe. That is a legitimate outcome, not an error —
        // keep whatever metadata we did get for Tier 3.
        await updateRecipe(
          recipeId,
          {
            ...(r1.meta?.creatorHandle ? { creatorHandle: r1.meta.creatorHandle } : {}),
            ...(r1.meta?.thumbnailUrl ? { thumbnailUrl: r1.meta.thumbnailUrl } : {}),
            ...(r1.caption ? { rawCaption: r1.caption } : {}),
            attempts: [
              ...recipe.attempts,
              {
                tier: 1,
                at: Date.now(),
                outcome: 'failure',
                route: r1.meta?.route ?? 'worker',
                reason: 'No recipe found in the caption',
              },
            ],
          },
          db,
        );
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
