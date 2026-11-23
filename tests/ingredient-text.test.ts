import { describe, it, expect } from 'vitest';
import {
  parseIngredientText,
  textToIngredients,
  ingredientsToText,
  hasStructure,
} from '../src/lib/ingredient-text';
import { formatIngredient } from '../src/lib/quantity';

/**
 * Structured ingredient editing — PRD v2 FR-8.
 *
 * Two properties matter, and they pull against each other:
 *
 *   NEVER LOSE WHAT THE USER TYPED (FR-8.3). The caption parser rewrites
 *   lines in ways that suit captions and not an edit box, so anything it
 *   cannot reproduce faithfully is stored verbatim.
 *
 *   KEEP STRUCTURE WHERE IT IS FAITHFUL. The scaler (FR-9) and the grocery
 *   merge (FR-7.2) both need quantity and unit, and the old editor threw
 *   them away on every save.
 */

describe('the fidelity guard (FR-8.3)', () => {
  it('does not reorder words the parser would rearrange', () => {
    // The item-first dash rule turns this into "for frying Oil" — right for a
    // caption, wrong for something a person deliberately typed.
    const r = parseIngredientText('Oil - for frying')!;
    expect(r.item).toBe('Oil - for frying');
    expect(formatIngredient(r)).toBe('Oil - for frying');
  });

  it('does not strip a hashtag the user typed on purpose', () => {
    expect(parseIngredientText('#hashtag thing')!.item).toBe('#hashtag thing');
  });

  it('round-trips every line unchanged, structured or not', () => {
    const lines = [
      'Oil - for frying',
      '#hashtag thing',
      'Chicken',
      '2 tbsp chilli oil',
      '500 gm chicken',
      '2-3 tbsp oil',
      'Coriander seeds – 1 tbsp',
      'a handful of coriander',
      'juice of 1 lemon',
      'tomatoes x4',
      '2 onions, thinly sliced',
    ];
    for (const line of lines) {
      expect(formatIngredient(parseIngredientText(line)!)).toBe(line);
    }
  });

  /**
   * The one accepted exception, recorded rather than hidden.
   *
   * A decimal is stored as a number and redisplayed in cooking notation, so
   * "1.5 eggs" comes back as "1½ eggs". The VALUE is exactly preserved — it is
   * the same quantity, written the way recipes write it — and keeping it
   * numeric is what lets the scaler and the grocery merge work at all. The
   * alternative, storing "1.5 eggs" as an unparsed string to protect the
   * notation, would sacrifice the entire point of FR-8 for a glyph.
   */
  it('renders a decimal in cooking notation while preserving its value', () => {
    const r = parseIngredientText('1.5 eggs')!;
    expect(r.quantity).toBe(1.5);
    expect(formatIngredient(r)).toBe('1½ eggs');
  });

  it('falls back to verbatim rather than guessing at a range', () => {
    // parseQuantity takes a range's lower bound, so keeping the structure
    // would turn "2-3 tbsp" into "2 tbsp" — and later scale from the wrong
    // number. Verbatim is the honest outcome.
    const r = parseIngredientText('2-3 tbsp oil')!;
    expect(hasStructure(r)).toBe(false);
    expect(r.item).toBe('2-3 tbsp oil');
  });
});

describe('structure is kept where it is faithful (FR-8.1)', () => {
  it('keeps quantity and unit — the whole point of this change', () => {
    expect(parseIngredientText('2 tbsp chilli oil')).toMatchObject({
      quantity: 2,
      unit: 'tbsp',
      item: 'chilli oil',
    });
  });

  it('keeps a decimal quantity', () => {
    expect(parseIngredientText('1.5 eggs')).toMatchObject({ quantity: 1.5, item: 'eggs' });
  });

  it('keeps structure despite a spacing difference', () => {
    // The parser renders this back as "300 g noodles"; comparing literally
    // would reject it and lose a perfectly good quantity over one space.
    expect(parseIngredientText('300g noodles')).toMatchObject({
      quantity: 300,
      unit: 'g',
      item: 'noodles',
    });
  });

  it('keeps structure despite fraction notation', () => {
    // Typed as a glyph, rendered as a glyph.
    expect(parseIngredientText('½ cup yoghurt')).toMatchObject({
      quantity: 0.5,
      unit: 'cup',
      item: 'yoghurt',
    });
  });

  it('keeps a trailing preparation note', () => {
    expect(parseIngredientText('2 onions, thinly sliced')).toMatchObject({
      quantity: 2,
      item: 'onions',
      note: 'thinly sliced',
    });
  });

  it('marks unscalable rows as unstructured', () => {
    expect(hasStructure(parseIngredientText('Chicken')!)).toBe(false);
    expect(hasStructure(parseIngredientText('2 tbsp chilli oil')!)).toBe(true);
  });
});

describe('textToIngredients', () => {
  it('drops blank lines without dropping content', () => {
    const rows = textToIngredients('2 tbsp oil\n\n  \n1 onion\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ quantity: 2, unit: 'tbsp', item: 'oil' });
    expect(rows[1]).toMatchObject({ quantity: 1, item: 'onion' });
  });

  it('returns an empty list for empty input', () => {
    expect(textToIngredients('')).toEqual([]);
    expect(textToIngredients('\n\n   \n')).toEqual([]);
  });

  it('never loses a line, however odd', () => {
    const text = 'Chicken\nOil - for frying\n#tag\n2-3 tbsp oil\nMilk (full fat)';
    expect(textToIngredients(text)).toHaveLength(5);
  });
});

describe('ingredientsToText', () => {
  it('renders one ingredient per line', () => {
    expect(
      ingredientsToText([
        { quantity: 2, unit: 'tbsp', item: 'oil' },
        { item: 'Chicken' },
      ]),
    ).toBe('2 tbsp oil\nChicken');
  });

  it('handles an absent list', () => {
    expect(ingredientsToText(undefined)).toBe('');
  });
});

describe('editing a recipe repeatedly is stable', () => {
  /**
   * The failure mode this guards against is slow corruption: open, save,
   * reopen, and each pass rewrites the ingredients a little more, so the
   * damage is only obvious months later. One normalisation on the first save
   * is acceptable; continued drift is not.
   */
  it('settles after one pass and never moves again', () => {
    const original = [
      '2 tbsp chilli oil',
      'Oil - for frying',
      '1.5 eggs',
      '½ cup yoghurt',
      'a handful of coriander',
      '2 onions, thinly sliced',
    ].join('\n');

    const first = ingredientsToText(textToIngredients(original));
    // Only the decimal is renotated; everything else is untouched.
    expect(first).toBe(original.replace('1.5 eggs', '1½ eggs'));

    let text = first;
    for (let i = 0; i < 10; i++) {
      text = ingredientsToText(textToIngredients(text));
      expect(text).toBe(first);
    }
  });

  it('is a true fixed point for lines stored verbatim', () => {
    const awkward = ['Oil - for frying', '#tag', '2-3 tbsp oil', 'tomatoes x4'].join('\n');
    expect(ingredientsToText(textToIngredients(awkward))).toBe(awkward);
  });
});
