import { describe, it, expect, afterEach, vi } from 'vitest';
import { newId } from '../src/lib/id';

/**
 * Regression tests for a real failure: saving from a phone over plain HTTP
 * threw "crypto.randomUUID is not a function", because that API only exists
 * in a secure context. Desktop testing never caught it — localhost counts as
 * secure regardless of protocol.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newId', () => {
  it('produces a v4 UUID when crypto.randomUUID exists', () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it('works when randomUUID is missing but getRandomValues is not', () => {
    // This is exactly the insecure-context case: LAN HTTP on a phone.
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256;
        return a;
      },
    });
    expect(newId()).toMatch(UUID_V4);
  });

  it('works with no crypto object at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(newId()).toMatch(UUID_V4);
  });

  it('never throws, whatever the environment', () => {
    vi.stubGlobal('crypto', {});
    expect(() => newId()).not.toThrow();
    expect(newId()).toMatch(UUID_V4);
  });

  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });

  it('produces distinct ids on the Math.random fallback too', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });
});
