import { describe, it, expect } from 'vitest';
import { parseCaption, parseIngredientLine } from '../src/lib/parse-caption';
import fixtures from './fixtures/captions.json';

/**
 * Regression tests over REAL captions pulled from Instagram (see
 * tests/fixtures/captions.json). When the parser breaks on a new format, add
 * the caption here rather than debugging from memory.
 *
 * These assert the local regex parser (Tier 1b) — the offline fallback used
 * when Workers AI is unavailable or its daily allowance is spent. It is
 * expected to be weaker than the LLM path; these tests pin what it does get
 * right so a change cannot silently regress it.
 */

const f = fixtures as Record<
  string,
  { caption: string; creatorHandle: string; displayName: string }
>;

describe('the qualifying rule (FR-2.3)', () => {
  it('ingredients without a method is PARTIAL, not complete', () => {
    // @chefvpnjadhav — "Ingredients-" then a bare list, no method at all.
    const r = parseCaption(f['DUAkiKKDPER']!.caption);
    expect(r.outcome).toBe('partial');
    expect(r.ingredients.length).toBeGreaterThanOrEqual(2);
    expect(r.steps).toHaveLength(0);
  });

  it('returns none for a caption that is only a hashtag wall', () => {
    // @studiobyferi — "enjoy xo" plus 16 hashtags. Must NOT invent a recipe.
    const r = parseCaption(f['DM6uxd6g3UI']!.caption);
    expect(r.outcome).toBe('none');
    expect(r.ingredients).toHaveLength(0);
    expect(r.steps).toHaveLength(0);
  });

  it('qualifies a caption with both ingredients and a method', () => {
    const r = parseCaption(f['DROuylukbH2']!.caption);
    expect(r.outcome).toBe('complete');
    expect(r.ingredients.length).toBeGreaterThanOrEqual(2);
    expect(r.steps.length).toBeGreaterThanOrEqual(1);
  });
});

describe('real caption: Bachelor Chicken Peratal (@sainus_diary)', () => {
  const r = parseCaption(f['DROuylukbH2']!.caption);

  it('takes the dish name as the title, not the emoji line', () => {
    expect(r.title).toContain('Bachelor Chicken Peratal');
  });

  it('parses "Coriander seeds – 1 tbsp" item-first with a dash', () => {
    const ing = r.ingredients.find((i) => /coriander seeds/i.test(i.item));
    expect(ing).toMatchObject({ quantity: 1, unit: 'tbsp' });
  });

  it('parses the ½ fraction glyph', () => {
    const ing = r.ingredients.find((i) => /red chilli powder/i.test(i.item));
    expect(ing?.quantity).toBe(0.5);
  });

  it('does not treat "For Masala Paste:" as an ingredient', () => {
    expect(r.ingredients.some((i) => /^for\b/i.test(i.item))).toBe(false);
  });

  it('keeps numbered steps as separate steps', () => {
    expect(r.steps.length).toBeGreaterThanOrEqual(4);
    expect(r.steps.some((s) => /grind/i.test(s))).toBe(true);
    expect(r.steps.some((s) => /marinate/i.test(s))).toBe(true);
  });

  it('drops the trailing hashtag wall from the steps', () => {
    expect(r.steps.some((s) => s.includes('#'))).toBe(false);
  });

  it('does not leak an ingredient line into the steps', () => {
    // Regression: "Water – 2–3 tbsp (to grind)" used to flip the parser into
    // method mode because "grind" appeared inside the parenthetical note.
    expect(r.steps.some((s) => /^Water\s*[–-]/.test(s))).toBe(false);
  });
});

describe('real caption: Spicy lemon coriander chicken (@chefvpnjadhav)', () => {
  const r = parseCaption(f['DUAkiKKDPER']!.caption);

  it('recognises the "Ingredients-" heading with a trailing hyphen', () => {
    // Regression: the heading regex only allowed a colon, so this whole
    // caption parsed as nothing.
    expect(r.ingredients.length).toBe(8);
  });

  it('keeps unquantified ingredients', () => {
    expect(r.ingredients.map((i) => i.item)).toContain('Oil');
    expect(r.ingredients.map((i) => i.item)).toContain('Salt');
  });

  it('strips hashtags from the ingredient list', () => {
    expect(r.ingredients.some((i) => i.item.includes('#'))).toBe(false);
  });
});

describe('title extraction', () => {
  it('does not make a 500-character paragraph into a title', () => {
    // Regression: a real caption opened with a long paragraph about tomato
    // gojju, and the entire paragraph became the recipe title.
    const caption = [
      'tometo gojju is a kannada pickle like thick gravy made entirely with tomatoes',
      'as the base. it’s similar to thakkali thokku and comes in different varieties.',
      'did gojju came from thokku, idk! what i know is its quick to make, stores well',
      'and goes well with roti to rice.',
      '',
      'Ingredients:',
      '4 tomatoes',
      '2 tbsp oil',
      '',
      'Method:',
      'Cook the tomatoes down until thick.',
    ].join(' ');
    const r = parseCaption(caption);
    expect((r.title ?? '').length).toBeLessThanOrEqual(60);
  });

  it('cuts a long opening line at its first sentence', () => {
    const r = parseCaption(
      'Tomato gojju. This is a long trailing explanation that goes on well past any reasonable title length.\n\nIngredients:\n2 tomatoes\n1 tbsp oil\n\nMethod:\nCook.',
    );
    expect(r.title).toBe('Tomato gojju');
  });

  it('cuts at a comma when there is no sentence break', () => {
    const r = parseCaption(
      'Creamy tomato pasta, the one my flatmate begs me to make every single week without fail\n\nIngredients:\n200g pasta\n1 tbsp oil\n\nMethod:\nBoil.',
    );
    expect(r.title).toBe('Creamy tomato pasta');
  });

  it('gives no title rather than a truncated one', () => {
    // Better to fall back to "@handle — date" than show a chopped fragment.
    const wall =
      'this is one enormous unbroken run of words with no punctuation anywhere at all so nothing can be cut sensibly from it';
    const r = parseCaption(`${wall}\n\nIngredients:\n2 eggs\n1 cup flour\n\nMethod:\nMix.`);
    expect(r.title).toBeUndefined();
  });

  it('keeps a normal short title untouched', () => {
    const r = parseCaption('Bachelor Chicken Peratal\n\nIngredients:\n2 eggs\n1 cup flour\n\nMethod:\nMix.');
    expect(r.title).toBe('Bachelor Chicken Peratal');
  });
});

describe('engagement hooks are not titles', () => {
  it('skips "WAIT FOR THE END…" and takes the dish name below it', () => {
    // Regression: this real caption made the creator's hook the recipe title.
    const r = parseCaption(f['DIy0z9SyS-H']!.caption);
    expect(r.title).not.toMatch(/wait for the end/i);
  });

  it('skips a series label', () => {
    const r = parseCaption(
      'Broke but Bougie Ep. 3\nChilli oil noodles\n\nIngredients:\n300g noodles\n2 tbsp oil\n\nMethod:\nBoil.',
    );
    expect(r.title).toBe('Chilli oil noodles');
  });

  it('still uses a normal opening line', () => {
    const r = parseCaption('Chilli oil noodles\n\nIngredients:\n300g noodles\n2 tbsp oil\n\nMethod:\nBoil.');
    expect(r.title).toBe('Chilli oil noodles');
  });
});

describe('section sub-headings', () => {
  it('drops "For the Chicken Marinade" — no trailing colon', () => {
    // Regression: these appeared as ingredients because the old pattern
    // required a colon.
    const r = parseCaption(f['DbDdLfHIP3q']!.caption);
    expect(r.ingredients.some((i) => /^for the\b/i.test(i.item))).toBe(false);
    expect(r.ingredients.some((i) => /^for\b/i.test(i.item))).toBe(false);
  });

  it('keeps a real ingredient line that happens to start with "For"', () => {
    const r = parseCaption(
      'Ingredients:\nFor 4 people use 2 onions\n1 tsp salt\n\nMethod:\nCook it.',
    );
    expect(r.ingredients.some((i) => /onions/i.test(i.item))).toBe(true);
  });
});

describe('promotional noise', () => {
  it('drops long call-to-action lines rather than treating them as steps', () => {
    // Regression: "Save this recipe and try it today! ... follow @handle"
    // exceeded the old 40-char cap and became a method step.
    const r = parseCaption(f['DbDdLfHIP3q']!.caption);
    expect(r.steps.some((s) => /save this recipe|don.?t forget|follow @/i.test(s))).toBe(false);
  });

  it('ignores a "recipe below 👇" preamble', () => {
    const r = parseCaption('Recipe below 👇\n\nIngredients:\n2 eggs\n1 cup flour\n\nMethod:\nMix well.');
    expect(r.outcome).toBe('complete');
    expect(r.ingredients).toHaveLength(2);
    expect(r.steps).toHaveLength(1);
  });
});

describe('parseIngredientLine', () => {
  it('parses quantity-first with a unit', () => {
    expect(parseIngredientLine('500 gm chicken')).toMatchObject({
      quantity: 500,
      unit: 'gm',
      item: 'chicken',
    });
  });

  it('parses item-first with a dash', () => {
    expect(parseIngredientLine('Black pepper – 1 tsp')).toMatchObject({
      quantity: 1,
      unit: 'tsp',
      item: 'Black pepper',
    });
  });

  it('takes the lower bound of a range', () => {
    expect(parseIngredientLine('2-3 tbsp oil')?.quantity).toBe(2);
  });

  it('handles a mixed fraction', () => {
    expect(parseIngredientLine('1 1/2 cups flour')?.quantity).toBe(1.5);
  });

  it('keeps a non-numeric amount as text', () => {
    expect(parseIngredientLine('Salt – as needed')).toMatchObject({
      quantityText: 'as needed',
      item: 'Salt',
    });
  });

  it('splits a trailing qualifier into a note', () => {
    expect(parseIngredientLine('2 onions, thinly sliced')).toMatchObject({
      quantity: 2,
      item: 'onions',
      note: 'thinly sliced',
    });
  });

  it('keeps a parenthetical as a note', () => {
    const r = parseIngredientLine('Water – 2 tbsp (to grind)');
    expect(r?.note).toBe('to grind');
    expect(r?.item).toBe('Water');
  });

  it('handles an ingredient with no quantity at all', () => {
    expect(parseIngredientLine('Garlic')).toMatchObject({ item: 'Garlic' });
  });

  it('strips bullet glyphs', () => {
    expect(parseIngredientLine('• 1 tsp cumin')).toMatchObject({
      quantity: 1,
      unit: 'tsp',
      item: 'cumin',
    });
    expect(parseIngredientLine('🔸 2 eggs')).toMatchObject({ quantity: 2, item: 'eggs' });
  });

  it('returns null for an empty line', () => {
    expect(parseIngredientLine('   ')).toBeNull();
  });
});
