import { fetchReelMetadata, PermanentFetchError, RateLimitedError } from './instagram';
import { parseCaptionWithLlm, QuotaExhaustedError, type AiBinding } from './llm-parse';

/**
 * Extraction Worker.
 *
 * Endpoints:
 *   GET /metadata?url=...   Tier 3 enrichment — handle, thumbnail, raw caption.
 *   GET /extract?url=...    Tier 1 — metadata plus a parsed recipe.
 *   GET /health
 *
 * The Worker never decides what to save. It reports what it found and why
 * anything failed; the client owns the durable row and the tier decisions.
 */

export interface Env {
  AI: AiBinding;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS?: string;
}

interface ExtractResponse {
  creatorHandle?: string;
  displayName?: string;
  thumbnailUrl?: string;
  rawCaption?: string;
  title?: string;
  ingredients?: unknown[];
  steps?: string[];
  sourceLanguage?: string;
  translated?: boolean;
  /** Category suggestions for the user to accept or dismiss (FR-3.7). */
  cuisine?: string;
  mealType?: string;
  tags?: string[];
  /** Which route produced the metadata, for debugging (NFR-6.3). */
  route?: string;
  /** Set when parsing was skipped or failed, so the client can degrade. */
  parseError?: 'quota_exhausted' | 'parse_failed' | 'no_caption';
}

const SHORTCODE_RE = /instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,32})/;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // With no allowlist configured, echo the origin. This Worker exposes only
  // public Instagram metadata and holds no user data or credentials.
  const allowOrigin =
    allowed.length === 0 ? origin || '*' : allowed.includes(origin) ? origin : allowed[0]!;

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true }, 200, cors);
    }


    const wantsParse = url.pathname === '/extract';
    if (url.pathname !== '/metadata' && !wantsParse) {
      return json({ error: 'Not found' }, 404, cors);
    }

    const target = url.searchParams.get('url');
    if (!target) {
      return json({ error: 'Missing url parameter' }, 400, cors);
    }

    const m = target.match(SHORTCODE_RE);
    if (!m?.[1]) {
      return json({ error: 'Not an Instagram reel or post URL' }, 400, cors);
    }
    const shortcode = m[1];

    // --- Fetch metadata (Tier 3 enrichment, and Tier 1's input) ---
    let meta;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        meta = await fetchReelMetadata(shortcode, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (err instanceof PermanentFetchError) {
        // Private or deleted — the client must not retry this forever.
        return json({ error: err.message, permanent: true }, 404, cors);
      }
      if (err instanceof RateLimitedError) {
        // Retryable, and worth saying so plainly — the user did nothing wrong.
        return json({ error: err.message, permanent: false, rateLimited: true }, 429, {
          ...cors,
          'Retry-After': '300',
        });
      }
      const reason = err instanceof Error ? err.message : String(err);
      return json({ error: reason, permanent: false }, 502, cors);
    }

    const body: ExtractResponse = {
      ...(meta.creatorHandle ? { creatorHandle: meta.creatorHandle } : {}),
      ...(meta.displayName ? { displayName: meta.displayName } : {}),
      ...(meta.thumbnailUrl ? { thumbnailUrl: meta.thumbnailUrl } : {}),
      ...(meta.caption ? { rawCaption: meta.caption } : {}),
      route: meta.route,
    };

    if (!wantsParse) {
      return json(body, 200, cors);
    }

    // --- Tier 1a: LLM parse ---
    if (!meta.caption) {
      body.parseError = 'no_caption';
      return json(body, 200, cors);
    }

    try {
      const parsed = await parseCaptionWithLlm(env.AI, meta.caption);
      body.ingredients = parsed.ingredients;
      body.steps = parsed.steps;
      if (parsed.title) body.title = parsed.title;
      if (parsed.sourceLanguage) body.sourceLanguage = parsed.sourceLanguage;
      if (parsed.translated) body.translated = parsed.translated;
      if (parsed.cuisine) body.cuisine = parsed.cuisine;
      if (parsed.mealType) body.mealType = parsed.mealType;
      if (parsed.tags?.length) body.tags = parsed.tags;
    } catch (err) {
      // Quota exhaustion is not a failure — the client falls back to its own
      // regex parser and still gets a usable result (NFR-1.4).
      body.parseError = err instanceof QuotaExhaustedError ? 'quota_exhausted' : 'parse_failed';
    }

    return json(body, 200, cors);
  },
};
