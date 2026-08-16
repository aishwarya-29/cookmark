/**
 * Instagram URL canonicalisation — PRD FR-2.1.
 *
 * Instagram produces the same reel under many URLs. We reduce them all to one
 * canonical form so duplicate detection (FR-2.2) actually works.
 *
 * Canonical form: https://www.instagram.com/reel/{shortcode}/
 *
 * The one case we cannot fully handle in the browser: /share/ links are
 * server-side redirects, and CORS blocks following them from page JS. We flag
 * those as unresolved and let a Worker canonicalise them later.
 */

export type UrlKind = 'reel' | 'post' | 'tv' | 'share' | 'profile_reel';

export interface CanonicalUrl {
  /** The canonical URL to store, or the cleaned original for unresolved shares. */
  canonical: string;
  /** Instagram shortcode, absent for unresolved /share/ links. */
  shortcode?: string;
  kind: UrlKind;
  /** True when this needs a server round-trip before duplicates are reliable. */
  unresolved: boolean;
  /** Handle, when the URL form carries one (e.g. /{user}/reel/{code}/). */
  creatorHandle?: string;
}

export class InvalidInstagramUrlError extends Error {
  constructor(
    message: string,
    /** Set when the input is a URL but not an Instagram one — a different message in the UI. */
    readonly kind: 'not_a_url' | 'not_instagram' | 'unrecognised_path' = 'not_a_url',
  ) {
    super(message);
    this.name = 'InvalidInstagramUrlError';
  }
}

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'l.instagram.com',
  'ig.me',
  'instagr.am',
  'www.instagr.am',
]);

/**
 * Query params we strip. Instagram's own tracking (`igsh`, `igshid`) plus the
 * usual analytics junk that gets appended when links pass through other apps.
 */
const TRACKING_PARAMS = new Set([
  'igsh',
  'igshid',
  'img_index',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mibextid',
  'si',
  'ref',
  'referrer',
  'source',
  '__d',
  '__a',
]);

/**
 * Instagram shortcodes are base64-ish: alphanumerics plus - and _.
 * Length varies (historically 11, now sometimes longer), so we don't pin it.
 */
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,32}$/;

/** Reserved first-path-segments that are never usernames. */
const RESERVED_SEGMENTS = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'share',
  'stories',
  'explore',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
]);

function stripTracking(u: URL): void {
  for (const key of [...u.searchParams.keys()]) {
    // Case-insensitive: real-world links arrive with IGSH= and igsh= both.
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
}

function buildCanonical(shortcode: string): string {
  return `https://www.instagram.com/reel/${shortcode}/`;
}

/**
 * Parse and canonicalise an Instagram URL.
 *
 * Accepts bare input without a scheme ("instagram.com/reel/abc") because that
 * is what a copy-paste from some apps produces.
 *
 * @throws {InvalidInstagramUrlError} when the input isn't a usable IG link.
 */
export function canonicaliseInstagramUrl(input: string): CanonicalUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidInstagramUrlError('No link provided', 'not_a_url');
  }

  // Reject free text before URL-parsing it. Prefixing a scheme onto "chicken
  // curry" yields a technically-parseable URL with a nonsense hostname, which
  // would otherwise surface as the misleading "not from Instagram".
  if (/\s/.test(trimmed) || !trimmed.includes('.')) {
    throw new InvalidInstagramUrlError("That doesn't look like a link", 'not_a_url');
  }

  // Tolerate a missing scheme — paste from Notes/Messages often drops it.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new InvalidInstagramUrlError("That doesn't look like a link", 'not_a_url');
  }

  const host = u.hostname.toLowerCase();
  if (!INSTAGRAM_HOSTS.has(host)) {
    throw new InvalidInstagramUrlError(
      'That link is not from Instagram',
      'not_instagram',
    );
  }

  stripTracking(u);

  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new InvalidInstagramUrlError(
      "That's the Instagram home page, not a reel",
      'unrecognised_path',
    );
  }

  const [first, second, third] = segments;

  // --- /share/... — a redirect stub. Cannot resolve client-side (CORS). ---
  if (first === 'share') {
    // Keep the cleaned URL verbatim; a Worker resolves it later.
    return {
      canonical: u.toString(),
      kind: 'share',
      unresolved: true,
    };
  }

  // --- /reel/{code}, /reels/{code}, /p/{code}, /tv/{code} ---
  if (first === 'reel' || first === 'reels' || first === 'p' || first === 'tv') {
    if (!second || !SHORTCODE_RE.test(second)) {
      throw new InvalidInstagramUrlError(
        'That Instagram link is missing a post ID',
        'unrecognised_path',
      );
    }
    return {
      canonical: buildCanonical(second),
      shortcode: second,
      kind: first === 'p' ? 'post' : first === 'tv' ? 'tv' : 'reel',
      unresolved: false,
    };
  }

  // --- /{username}/reel/{code}/ and /{username}/p/{code}/ ---
  // Instagram serves these for posts opened from a profile.
  if (
    !RESERVED_SEGMENTS.has(first!) &&
    (second === 'reel' || second === 'reels' || second === 'p' || second === 'tv')
  ) {
    if (!third || !SHORTCODE_RE.test(third)) {
      throw new InvalidInstagramUrlError(
        'That Instagram link is missing a post ID',
        'unrecognised_path',
      );
    }
    return {
      canonical: buildCanonical(third),
      shortcode: third,
      kind: 'profile_reel',
      unresolved: false,
      creatorHandle: first,
    };
  }

  // A profile, a story, an explore page — real Instagram, but not a reel.
  throw new InvalidInstagramUrlError(
    'That Instagram link is not a reel or post',
    'unrecognised_path',
  );
}

/**
 * Non-throwing variant, for UI paths that want to test a string (e.g. clipboard
 * sniffing) without exception control flow.
 */
export function tryCanonicaliseInstagramUrl(input: string): CanonicalUrl | null {
  try {
    return canonicaliseInstagramUrl(input);
  } catch {
    return null;
  }
}
