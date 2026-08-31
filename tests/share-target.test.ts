import { describe, it, expect } from 'vitest';
import { tryCanonicaliseInstagramUrl } from '../src/lib/url';

/**
 * Share-target payloads (FR-1.3).
 *
 * Instagram's share sheet does not send a clean URL. Android puts the link in
 * `text` wrapped in the creator's caption; iOS Shortcuts uses `url`; some
 * launchers use `title`. These are the shapes the handler must survive.
 *
 * This tests the extraction rule the handler uses, not the DOM plumbing.
 */

const SHARE_RE = /https?:\/\/\S*instagram\.com\/\S+/i;

function extract(...fields: (string | null)[]): string | null {
  const blob = fields.filter(Boolean).join(' ');
  return blob.match(SHARE_RE)?.[0] ?? null;
}

describe('extracting a reel URL from a share payload', () => {
  it('handles a bare url field (iOS Shortcuts)', () => {
    const got = extract(null, null, 'https://www.instagram.com/reel/DROuylukbH2/');
    expect(tryCanonicaliseInstagramUrl(got!)?.shortcode).toBe('DROuylukbH2');
  });

  it('handles Android putting the link inside a caption blob', () => {
    // This is the real Android shape: caption text, then the URL.
    const text =
      'Bachelor Chicken Peratal — quick and full of flavour!\n' +
      'https://www.instagram.com/reel/DROuylukbH2/?igsh=MzRlODBiNWFlZA==';
    const got = extract(text);
    expect(tryCanonicaliseInstagramUrl(got!)?.shortcode).toBe('DROuylukbH2');
  });

  it('strips tracking params through canonicalisation', () => {
    const got = extract('https://www.instagram.com/reel/DROuylukbH2/?igsh=abc&utm_source=ig_web');
    expect(tryCanonicaliseInstagramUrl(got!)?.canonical).toBe(
      'https://www.instagram.com/reel/DROuylukbH2/',
    );
  });

  it('finds the link when it is followed by more text', () => {
    const got = extract('Check this https://www.instagram.com/reel/DROuylukbH2/ so good');
    expect(tryCanonicaliseInstagramUrl(got!)?.shortcode).toBe('DROuylukbH2');
  });

  it('handles a share/ link, which resolves later', () => {
    const got = extract('https://www.instagram.com/share/reel/_AbC123xyz/');
    expect(tryCanonicaliseInstagramUrl(got!)?.unresolved).toBe(true);
  });

  it('handles a profile-scoped reel URL', () => {
    const got = extract('https://www.instagram.com/sainus_diary/reel/DROuylukbH2/');
    expect(tryCanonicaliseInstagramUrl(got!)?.creatorHandle).toBe('sainus_diary');
  });

  it('returns nothing for a share with no Instagram link', () => {
    expect(extract('Look at this cake', 'https://youtube.com/watch?v=x')).toBeNull();
  });

  it('returns nothing for an empty share', () => {
    expect(extract(null, null, null)).toBeNull();
  });

  it('takes the first Instagram link when several are present', () => {
    const got = extract(
      'https://www.instagram.com/reel/AAAAAAAAAAA/ and https://www.instagram.com/reel/BBBBBBBBBBB/',
    );
    expect(tryCanonicaliseInstagramUrl(got!)?.shortcode).toBe('AAAAAAAAAAA');
  });
});
