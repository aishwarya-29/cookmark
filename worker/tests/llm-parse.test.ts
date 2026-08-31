import { describe, it, expect, vi } from 'vitest';
import { parseCaptionWithLlm, QuotaExhaustedError, type AiBinding } from '../src/llm-parse';
import fixtures from '../../tests/fixtures/captions.json';

/**
 * Tests for the LLM parse path.
 *
 * The model itself is stubbed — what is under test is the grounding guard,
 * which is the defence against the failure mode that actually matters: an LLM
 * inventing a plausible recipe for a caption that contains none.
 */

const f = fixtures as Record<string, { caption: string }>;

function stubAi(response: unknown): AiBinding {
  return { run: async () => ({ response }) };
}

function failingAi(message: string): AiBinding {
  return {
    run: async () => {
      throw new Error(message);
    },
  };
}

describe('hallucination guard', () => {
  it('discards a recipe with no footing in the caption', async () => {
    // The hashtag-wall reel. If the model returns a generic chicken recipe,
    // none of it appears in the caption and all of it must be dropped.
    const invented = {
      title: 'Garlic Butter Chicken',
      ingredients: [
        { item: 'chicken breast', quantity: 500, unit: 'g' },
        { item: 'butter', quantity: 2, unit: 'tbsp' },
        { item: 'garlic cloves', quantity: 4 },
      ],
      steps: ['Season the chicken breast.', 'Melt butter and fry the garlic.'],
    };
    const r = await parseCaptionWithLlm(stubAi(invented), f['DM6uxd6g3UI']!.caption);
    expect(r.ingredients).toHaveLength(0);
    expect(r.steps).toHaveLength(0);
  });

  it('keeps a recipe whose terms do appear in the caption', async () => {
    const grounded = {
      title: 'Spicy lemon coriander chicken',
      ingredients: [
        { item: 'Coriander powder' },
        { item: 'Green chilli' },
        { item: 'Lemon juice' },
      ],
      steps: [],
    };
    const r = await parseCaptionWithLlm(stubAi(grounded), f['DUAkiKKDPER']!.caption);
    expect(r.ingredients).toHaveLength(3);
  });

  it('drops only the ungrounded items when most are real', async () => {
    const mixed = {
      ingredients: [
        { item: 'Coriander powder' },
        { item: 'Green chilli' },
        { item: 'Lemon juice' },
        { item: 'Oil' },
        { item: 'saffron threads' }, // not in the caption
      ],
      steps: [],
    };
    const r = await parseCaptionWithLlm(stubAi(mixed), f['DUAkiKKDPER']!.caption);
    expect(r.ingredients.some((i) => /saffron/i.test(i.item))).toBe(false);
    expect(r.ingredients.length).toBeGreaterThanOrEqual(3);
  });

  it('does not spend a request on a caption too short to hold a recipe', async () => {
    let called = false;
    const ai: AiBinding = {
      run: async () => {
        called = true;
        return { response: {} };
      },
    };
    const r = await parseCaptionWithLlm(ai, 'yum 😋 #food #reels #viral #trending');
    expect(called).toBe(false);
    expect(r.ingredients).toHaveLength(0);
  });
});

describe('quota exhaustion (NFR-1.4)', () => {
  it('raises QuotaExhaustedError so the caller can fall back', async () => {
    await expect(
      parseCaptionWithLlm(failingAi('Neuron limit exceeded for today'), f['DROuylukbH2']!.caption),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it('treats a 429 as quota exhaustion', async () => {
    await expect(
      parseCaptionWithLlm(failingAi('429 Too Many Requests'), f['DROuylukbH2']!.caption),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it('rethrows an unrelated error unchanged', async () => {
    await expect(
      parseCaptionWithLlm(failingAi('socket hang up'), f['DROuylukbH2']!.caption),
    ).rejects.not.toBeInstanceOf(QuotaExhaustedError);
  });
});

describe('stalled inference', () => {
  it('gives up rather than hanging forever', async () => {
    // Regression: with no timeout, a stalled AI call hung a real request for
    // 900+ seconds before the client gave up. Fake timers keep this instant.
    vi.useFakeTimers();
    try {
      const hangingAi: AiBinding = { run: () => new Promise(() => {}) };
      const promise = parseCaptionWithLlm(hangingAi, f['DROuylukbH2']!.caption);
      const assertion = expect(promise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(76_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('response handling', () => {
  it('parses a JSON string response', async () => {
    const r = await parseCaptionWithLlm(
      stubAi(JSON.stringify({ ingredients: [{ item: 'Lemon juice' }, { item: 'Oil' }], steps: [] })),
      f['DUAkiKKDPER']!.caption,
    );
    expect(r.ingredients).toHaveLength(2);
  });

  it('survives a malformed response without throwing', async () => {
    const r = await parseCaptionWithLlm(stubAi(null), f['DUAkiKKDPER']!.caption);
    expect(r.ingredients).toHaveLength(0);
  });

  it('drops ingredient entries with no item', async () => {
    const r = await parseCaptionWithLlm(
      stubAi({ ingredients: [{ item: 'Lemon juice' }, { quantity: 2 }, { item: '' }], steps: [] }),
      f['DUAkiKKDPER']!.caption,
    );
    expect(r.ingredients).toHaveLength(1);
  });

  it('carries through the detected source language', async () => {
    const r = await parseCaptionWithLlm(
      stubAi({
        ingredients: [{ item: 'Coriander powder' }, { item: 'Lemon juice' }],
        steps: [],
        sourceLanguage: 'Tamil',
        translated: true,
      }),
      f['DUAkiKKDPER']!.caption,
    );
    expect(r.sourceLanguage).toBe('Tamil');
    expect(r.translated).toBe(true);
  });
});
