/**
 * Instagram metadata fetch.
 *
 * How this works, and why it is fragile (NFR-3.5):
 *
 * Instagram serves no useful metadata to a logged-out browser — the reel page
 * and the /embed/captioned/ route both return a ~600KB login shell, and both
 * ?__a=1 and the GraphQL doc_id endpoint are closed (404/403 as of Aug 2026).
 *
 * What still works is the link-preview path: presenting a messaging-app
 * user-agent returns OpenGraph tags intended for chat previews, and the FULL
 * caption is in `og:title` (not og:description, which is served empty).
 *
 * Format: `<Display Name> on Instagram: "<caption>"`
 *
 * This is unofficial and may break without notice. When it does, Tier 1 is
 * disabled via its toggle and everything falls to Tier 3 — the app keeps
 * working as a link organiser.
 */

export interface ReelMetadata {
  creatorHandle?: string;
  displayName?: string;
  caption?: string;
  thumbnailUrl?: string;
  /** Which route produced this, for debugging a break months later. */
  route: string;
}

export class PermanentFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFetchError';
  }
}

/**
 * Instagram is rate-limiting us. Distinct from a generic failure because the
 * remedy is different: wait and retry, rather than give up on the reel.
 */
export class RateLimitedError extends Error {
  constructor() {
    super('Instagram is rate-limiting requests — this will retry automatically');
    this.name = 'RateLimitedError';
  }
}

/** Messaging-app UA — the only one that reliably yields OG tags. */
const PREVIEW_UA = 'WhatsApp/2.23.20.0';

function extractMeta(html: string, property: string, attr = 'property'): string | undefined {
  const re = new RegExp(`<meta ${attr}="${property}" content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m?.[1] ? decodeEntities(m[1]) : undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  amp: '&',
};

/**
 * Decode HTML entities in meta tag content.
 *
 * Handles named entities and both decimal and hex numeric forms. `&amp;` is
 * decoded LAST so that a double-encoded `&amp;hellip;` does not first become
 * `&hellip;` and then get decoded again — and unknown entities are left as-is
 * rather than being half-eaten (which produced "WAIT FOR THE END&;").
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined && name.toLowerCase() !== 'amp' ? v : match;
    })
    .replace(/&amp;/g, '&');
}

export async function fetchReelMetadata(
  shortcode: string,
  signal?: AbortSignal,
): Promise<ReelMetadata> {
  const url = `https://www.instagram.com/reel/${shortcode}/`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': PREVIEW_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    signal,
  });

  if (res.status === 404 || res.status === 410) {
    throw new PermanentFetchError('This post is private or has been deleted');
  }
  if (res.status === 429) {
    // Datacentre IPs get rate-limited quickly. This is temporary and the
    // caller should retry later rather than treating the reel as unavailable.
    throw new RateLimitedError();
  }
  if (!res.ok) {
    throw new Error(`Instagram returned ${res.status}`);
  }

  const html = await res.text();

  const ogTitle = extractMeta(html, 'og:title');
  const ogUrl = extractMeta(html, 'og:url');
  const thumbnailUrl = extractMeta(html, 'og:image');

  // og:url carries the handle: https://www.instagram.com/{handle}/reel/{code}/
  let creatorHandle: string | undefined;
  if (ogUrl) {
    const m = ogUrl.match(/instagram\.com\/([^/]+)\//);
    if (m?.[1] && m[1] !== 'reel' && m[1] !== 'p') creatorHandle = m[1];
  }

  // og:title = `<Display Name> on Instagram: "<caption>"`
  let displayName: string | undefined;
  let caption: string | undefined;
  if (ogTitle) {
    const m = ogTitle.match(/^(.*?) on Instagram:\s*"([\s\S]*)"$/);
    if (m) {
      displayName = m[1]?.trim();
      caption = m[2];
    } else {
      caption = ogTitle;
    }
  }

  // No caption AND no handle means the shell came back — treat as a failure so
  // the caller can retry, rather than silently reporting an empty success.
  if (!caption && !creatorHandle) {
    throw new Error('Instagram returned no usable metadata');
  }

  return {
    ...(creatorHandle ? { creatorHandle } : {}),
    ...(displayName ? { displayName } : {}),
    ...(caption ? { caption } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    route: 'og_preview_ua',
  };
}
