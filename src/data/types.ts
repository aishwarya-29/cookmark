/**
 * Recipe schema — PRD §04 "Structured recipe schema".
 *
 * Everything except `title` and `sourceUrl` is optional and absent-by-default,
 * because real captions frequently omit them. Do not add non-optional fields
 * here without a migration.
 */

/** How the recipe content was obtained. PRD FR-2.8. */
export type ExtractionMethod =
  | 'caption'
  | 'audio'
  | 'audio_translated'
  | 'manual'
  | 'link_only'
  /** Saved, nothing attempted yet. Distinct from link_only, which is a settled outcome. */
  | 'pending';

/** PRD §04 schema `status` field. */
export type RecipeStatus =
  | 'complete'
  | 'partial'
  | 'needs_attention';

/**
 * Where a recipe is in the extraction cascade. Separate from `status` on
 * purpose: status is about the *content* we hold, extractionState is about the
 * *process*. A recipe can be status:needs_attention while extractionState:running.
 */
export type ExtractionState =
  | 'queued'
  | 'running'
  | 'settled'
  /** Retryable failure — network, rate limit, quota. PRD §07. */
  | 'failed_retryable'
  /** Permanent failure — private or deleted post. PRD §07. */
  | 'failed_permanent';

/** Which tier is currently running, for honest progress UI. PRD §07. */
export type Tier = 1 | 2 | 3;

export interface Ingredient {
  /** Numeric amount where we could parse one. `1.5`, not `"1 1/2"`. */
  quantity?: number;
  /** Raw quantity text when it wouldn't reduce to a number ("a handful"). */
  quantityText?: string;
  unit?: string;
  /** The foodstuff itself. The only part we really need. */
  item: string;
  /** Trailing qualifier — "finely chopped", "at room temperature". */
  note?: string;
}

/**
 * A record of one extraction attempt. Kept as a list so a re-extraction
 * (FR-2.9) appends rather than overwrites — debugging a silent failure months
 * later from memory is not viable (NFR-6.3).
 */
export interface ExtractionAttempt {
  tier: Tier;
  at: number;
  outcome: 'success' | 'partial' | 'failure';
  /** Which concrete route was used, e.g. 'embed_captioned', 'og_meta'. */
  route?: string;
  /** Human-readable reason on failure. Shown in the UI, not just logged. */
  reason?: string;
}

export interface Recipe {
  /** UUID. Generated client-side so the save never waits on a server. */
  id: string;

  // --- Required ---
  /** Falls back to creator handle + date when extraction yields nothing. */
  title: string;
  /** Canonical reel URL — tracking params stripped. Unique across the library. */
  sourceUrl: string;

  // --- Provenance / attribution (NFR-4.2 — always displayed) ---
  creatorHandle?: string;
  /** Instagram shortcode, when we could parse one out of the URL. */
  shortcode?: string;
  /**
   * True when sourceUrl is a /share/ link we could not resolve client-side.
   * Duplicate detection is unreliable for these until a Worker resolves them.
   */
  unresolvedShareLink?: boolean;

  // --- Content ---
  thumbnailUrl?: string;
  /** Cached thumbnail bytes for offline use (NFR-3.2, NFR-4.3). */
  thumbnailBlob?: Blob;
  ingredients?: Ingredient[];
  steps?: string[];
  servings?: number;
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
  cuisine?: string;
  mealType?: string;
  tags?: string[];

  /** Unparsed caption, kept verbatim. Tier 3 keeps this even when parsing fails. */
  rawCaption?: string;

  // --- Translation (FR-2.5) ---
  /** BCP-47-ish code of the detected source language, when translated. */
  sourceLanguage?: string;

  // --- Process ---
  extractionMethod: ExtractionMethod;
  status: RecipeStatus;
  extractionState: ExtractionState;
  /** Which tier is running right now, for the progress UI. */
  activeTier?: Tier;
  attempts: ExtractionAttempt[];

  // --- User content (FR-4.6 — never overwritten by re-extraction) ---
  notes?: string;
  /** Fields the user has hand-edited. Protected from re-extraction (FR-2.10). */
  manuallyEditedFields?: string[];

  // --- Timestamps ---
  savedAt: number;
  updatedAt: number;
}

/** Everything needed to create a row, before any extraction has run. */
export type NewRecipe = Pick<Recipe, 'sourceUrl'> & Partial<Recipe>;
