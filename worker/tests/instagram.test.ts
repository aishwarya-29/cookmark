import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchReelMetadata, PermanentFetchError, RateLimitedError } from '../src/instagram';

/**
 * Tests for the Instagram metadata fetch. The network is stubbed — what is
 * under test is the parsing of what Instagram returns, and the classification
 * of failures into retryable vs permanent, which drives whether the app ever
 * tries a reel again.
 */

function htmlWith(meta: Record<string, string>): string {
  const tags = Object.entries(meta)
    .map(([k, v]) => `<meta property="${k}" content="${v}" />`)
    .join('');
  return `<!doctype html><html><head>${tags}</head><body></body></html>`;
}

function stubFetch(status: number, body = ''): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('caption extraction from og:title', () => {
  it('splits the display name from the caption', async () => {
    stubFetch(
      200,
      htmlWith({
        'og:title': 'Vipin Jadhav on Instagram: &quot;Spicy lemon coriander chicken&quot;',
        'og:url': 'https://www.instagram.com/chefvpnjadhav/reel/DUAkiKKDPER/',
        'og:image': 'https://scontent.cdninstagram.com/v/thumb.jpg',
      }),
    );

    const m = await fetchReelMetadata('DUAkiKKDPER');
    expect(m.displayName).toBe('Vipin Jadhav');
    expect(m.caption).toBe('Spicy lemon coriander chicken');
    expect(m.creatorHandle).toBe('chefvpnjadhav');
    expect(m.thumbnailUrl).toContain('thumb.jpg');
  });

  it('keeps a multi-line caption intact', async () => {
    stubFetch(
      200,
      htmlWith({
        'og:title': 'A on Instagram: &quot;Title\n\nIngredients-\nOil\nSalt&quot;',
        'og:url': 'https://www.instagram.com/a/reel/X/',
      }),
    );
    const m = await fetchReelMetadata('X');
    expect(m.caption).toContain('Ingredients-');
    expect(m.caption!.split('\n').length).toBeGreaterThan(3);
  });

  it('does not mistake the reel path for a handle', async () => {
    stubFetch(
      200,
      htmlWith({
        'og:title': 'A on Instagram: &quot;hi there everyone&quot;',
        'og:url': 'https://www.instagram.com/reel/X/',
      }),
    );
    const m = await fetchReelMetadata('X');
    expect(m.creatorHandle).toBeUndefined();
  });
});

describe('HTML entity decoding', () => {
  it('decodes &hellip; rather than mangling it', async () => {
    // Regression: the old decoder turned "END&hellip;" into "END&;".
    stubFetch(
      200,
      htmlWith({
        'og:title': 'A on Instagram: &quot;WAIT FOR THE END&hellip;&quot;',
        'og:url': 'https://www.instagram.com/a/reel/X/',
      }),
    );
    const m = await fetchReelMetadata('X');
    expect(m.caption).toBe('WAIT FOR THE END…');
  });

  it('decodes numeric and hex entities', async () => {
    stubFetch(
      200,
      htmlWith({
        'og:title': 'A on Instagram: &quot;Don&#039;t stop caf&#233; &#x1F600;&quot;',
        'og:url': 'https://www.instagram.com/a/reel/X/',
      }),
    );
    const m = await fetchReelMetadata('X');
    expect(m.caption).toBe("Don't stop café 😀");
  });

  it('leaves an unknown entity untouched rather than half-eating it', async () => {
    stubFetch(
      200,
      htmlWith({
        'og:title': 'A on Instagram: &quot;salt &amp; pepper &notreal; here&quot;',
        'og:url': 'https://www.instagram.com/a/reel/X/',
      }),
    );
    const m = await fetchReelMetadata('X');
    expect(m.caption).toContain('salt & pepper');
    expect(m.caption).toContain('&notreal;');
  });
});

describe('failure classification', () => {
  it('treats 404 as permanent — the post is gone', async () => {
    stubFetch(404);
    await expect(fetchReelMetadata('X')).rejects.toBeInstanceOf(PermanentFetchError);
  });

  it('treats 410 as permanent', async () => {
    stubFetch(410);
    await expect(fetchReelMetadata('X')).rejects.toBeInstanceOf(PermanentFetchError);
  });

  it('treats 429 as a rate limit, not a dead post', async () => {
    // This distinction matters: a rate limit must retry, a dead post must not.
    stubFetch(429);
    await expect(fetchReelMetadata('X')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('rejects a login shell that carries no usable metadata', async () => {
    stubFetch(200, '<!doctype html><html><head></head><body>login</body></html>');
    await expect(fetchReelMetadata('X')).rejects.toThrow(/no usable metadata/i);
  });

  it('surfaces an unexpected status as a generic retryable error', async () => {
    stubFetch(503);
    await expect(fetchReelMetadata('X')).rejects.toThrow(/503/);
  });
});
