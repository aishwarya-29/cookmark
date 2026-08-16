import { describe, it, expect } from 'vitest';
import {
  canonicaliseInstagramUrl,
  tryCanonicaliseInstagramUrl,
  InvalidInstagramUrlError,
} from '../src/lib/url';

const CANON = 'https://www.instagram.com/reel/Cx1y2Z3aBcD/';

describe('canonicaliseInstagramUrl — the forms Instagram actually produces', () => {
  it('canonicalises /reel/', () => {
    const r = canonicaliseInstagramUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/');
    expect(r.canonical).toBe(CANON);
    expect(r.shortcode).toBe('Cx1y2Z3aBcD');
    expect(r.kind).toBe('reel');
    expect(r.unresolved).toBe(false);
  });

  it('canonicalises /reels/ to the same URL as /reel/', () => {
    expect(canonicaliseInstagramUrl('https://www.instagram.com/reels/Cx1y2Z3aBcD/').canonical)
      .toBe(CANON);
  });

  it('canonicalises /p/ to the same URL — a reel opened as a post is the same reel', () => {
    expect(canonicaliseInstagramUrl('https://www.instagram.com/p/Cx1y2Z3aBcD/').canonical)
      .toBe(CANON);
  });

  it('canonicalises /tv/', () => {
    const r = canonicaliseInstagramUrl('https://www.instagram.com/tv/Cx1y2Z3aBcD/');
    expect(r.canonical).toBe(CANON);
    expect(r.kind).toBe('tv');
  });

  it('handles /{username}/reel/{code}/ and keeps the handle', () => {
    const r = canonicaliseInstagramUrl('https://www.instagram.com/nonnas_kitchen/reel/Cx1y2Z3aBcD/');
    expect(r.canonical).toBe(CANON);
    expect(r.creatorHandle).toBe('nonnas_kitchen');
    expect(r.kind).toBe('profile_reel');
  });

  it('handles /{username}/p/{code}/', () => {
    const r = canonicaliseInstagramUrl('https://www.instagram.com/nonnas_kitchen/p/Cx1y2Z3aBcD/');
    expect(r.canonical).toBe(CANON);
    expect(r.creatorHandle).toBe('nonnas_kitchen');
  });
});

describe('tracking parameter stripping (FR-2.1)', () => {
  it('strips ?igsh=', () => {
    expect(
      canonicaliseInstagramUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/?igsh=MzRlODBiNWFlZA==')
        .canonical,
    ).toBe(CANON);
  });

  it('strips igshid, the older variant', () => {
    expect(
      canonicaliseInstagramUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/?igshid=abc123')
        .canonical,
    ).toBe(CANON);
  });

  it('strips a pile of mixed tracking params', () => {
    expect(
      canonicaliseInstagramUrl(
        'https://www.instagram.com/reel/Cx1y2Z3aBcD/?igsh=xyz&utm_source=ig_web&fbclid=abc&img_index=1',
      ).canonical,
    ).toBe(CANON);
  });

  it('strips tracking params case-insensitively', () => {
    expect(
      canonicaliseInstagramUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/?IGSH=abc').canonical,
    ).toBe(CANON);
  });

  it('two links to the same reel with different tracking collapse to one', () => {
    const a = canonicaliseInstagramUrl('https://instagram.com/reel/Cx1y2Z3aBcD?igsh=AAA');
    const b = canonicaliseInstagramUrl('https://www.instagram.com/reels/Cx1y2Z3aBcD/?utm_source=x');
    expect(a.canonical).toBe(b.canonical);
  });
});

describe('host and format tolerance', () => {
  it('accepts a missing scheme — paste from Notes drops it', () => {
    expect(canonicaliseInstagramUrl('instagram.com/reel/Cx1y2Z3aBcD/').canonical).toBe(CANON);
  });

  it('normalises m.instagram.com', () => {
    expect(canonicaliseInstagramUrl('https://m.instagram.com/reel/Cx1y2Z3aBcD/').canonical)
      .toBe(CANON);
  });

  it('normalises a missing trailing slash', () => {
    expect(canonicaliseInstagramUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD').canonical)
      .toBe(CANON);
  });

  it('tolerates surrounding whitespace and newlines from a sloppy paste', () => {
    expect(canonicaliseInstagramUrl('  https://www.instagram.com/reel/Cx1y2Z3aBcD/\n').canonical)
      .toBe(CANON);
  });

  it('accepts http and upgrades to https', () => {
    expect(canonicaliseInstagramUrl('http://www.instagram.com/reel/Cx1y2Z3aBcD/').canonical)
      .toBe(CANON);
  });
});

describe('/share/ links — cannot be resolved client-side', () => {
  it('flags a share link as unresolved rather than throwing', () => {
    const r = canonicaliseInstagramUrl('https://www.instagram.com/share/reel/_AbC123xyz/');
    expect(r.unresolved).toBe(true);
    expect(r.kind).toBe('share');
    expect(r.shortcode).toBeUndefined();
  });

  it('still strips tracking params off a share link', () => {
    const r = canonicaliseInstagramUrl('https://www.instagram.com/share/reel/_AbC123xyz/?igsh=zzz');
    expect(r.canonical).not.toContain('igsh');
  });
});

describe('rejections — each needs a distinct message in the UI', () => {
  it('rejects a non-URL', () => {
    expect(() => canonicaliseInstagramUrl('chicken curry')).toThrow(InvalidInstagramUrlError);
  });

  // Regression: free text with a scheme prepended parses as a URL with a
  // nonsense hostname, which surfaced as the misleading "not from Instagram".
  it('reports free text as not-a-link, not as a wrong-host link', () => {
    for (const text of ['chicken curry', 'butter chicken recipe', 'notes to self']) {
      try {
        canonicaliseInstagramUrl(text);
        expect.unreachable(`should have thrown for ${text}`);
      } catch (e) {
        expect((e as InvalidInstagramUrlError).kind).toBe('not_a_url');
      }
    }
  });

  it('rejects a single bare word', () => {
    try {
      canonicaliseInstagramUrl('instagram');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as InvalidInstagramUrlError).kind).toBe('not_a_url');
    }
  });

  it('rejects an empty string', () => {
    expect(() => canonicaliseInstagramUrl('   ')).toThrow(InvalidInstagramUrlError);
  });

  it('rejects a non-Instagram host with the not_instagram kind', () => {
    try {
      canonicaliseInstagramUrl('https://www.tiktok.com/@user/video/123');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as InvalidInstagramUrlError).kind).toBe('not_instagram');
    }
  });

  it('rejects a profile URL — real Instagram, but not a reel', () => {
    try {
      canonicaliseInstagramUrl('https://www.instagram.com/nonnas_kitchen/');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as InvalidInstagramUrlError).kind).toBe('unrecognised_path');
    }
  });

  it('rejects the bare home page', () => {
    expect(() => canonicaliseInstagramUrl('https://www.instagram.com/')).toThrow();
  });

  it('rejects /reel/ with no shortcode', () => {
    expect(() => canonicaliseInstagramUrl('https://www.instagram.com/reel/')).toThrow();
  });

  it('rejects a shortcode with illegal characters', () => {
    expect(() => canonicaliseInstagramUrl('https://www.instagram.com/reel/abc$%^def/')).toThrow();
  });

  it('rejects a stories URL', () => {
    expect(() => canonicaliseInstagramUrl('https://www.instagram.com/stories/user/123/')).toThrow();
  });
});

describe('tryCanonicaliseInstagramUrl — for clipboard sniffing', () => {
  it('returns null instead of throwing', () => {
    expect(tryCanonicaliseInstagramUrl('not a link')).toBeNull();
  });

  it('returns the parsed result on success', () => {
    expect(tryCanonicaliseInstagramUrl('https://www.instagram.com/reel/Cx1y2Z3aBcD/')?.canonical)
      .toBe(CANON);
  });
});
