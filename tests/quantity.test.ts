import { describe, it, expect } from 'vitest';
import { formatQuantity, formatIngredient } from '../src/lib/quantity';

/**
 * Quantities are stored as numbers so they can be scaled (FR-4.3), but they
 * must read like a recipe in the kitchen, not like floating point.
 */

describe('formatQuantity', () => {
  it('renders whole numbers plainly', () => {
    expect(formatQuantity(500)).toBe('500');
    expect(formatQuantity(1)).toBe('1');
  });

  it('renders common cooking fractions as glyphs', () => {
    expect(formatQuantity(0.5)).toBe('½');
    expect(formatQuantity(0.25)).toBe('¼');
    expect(formatQuantity(0.75)).toBe('¾');
  });

  it('renders a repeating third cleanly', () => {
    // Regression: this displayed as "0.3333333333333333 cup yoghurt".
    expect(formatQuantity(1 / 3)).toBe('⅓');
    expect(formatQuantity(2 / 3)).toBe('⅔');
  });

  it('renders mixed numbers', () => {
    expect(formatQuantity(1.5)).toBe('1½');
    expect(formatQuantity(2.25)).toBe('2¼');
  });

  it('falls back to two decimals for an unusual value', () => {
    expect(formatQuantity(1.07)).toBe('1.07');
  });

  it('returns empty for zero or nonsense', () => {
    expect(formatQuantity(0)).toBe('');
    expect(formatQuantity(NaN)).toBe('');
  });
});

describe('formatIngredient', () => {
  it('joins quantity, unit, and item', () => {
    expect(formatIngredient({ quantity: 500, unit: 'gm', item: 'chicken' })).toBe(
      '500 gm chicken',
    );
  });

  it('formats the quantity rather than dumping the float', () => {
    expect(formatIngredient({ quantity: 1 / 3, unit: 'cup', item: 'yoghurt' })).toBe(
      '⅓ cup yoghurt',
    );
  });

  it('puts a trailing qualifier after the item, not before it', () => {
    // "as needed Salt" reads backwards; a cook writes "Salt, as needed".
    expect(formatIngredient({ quantityText: 'as needed', item: 'Salt' })).toBe(
      'Salt, as needed',
    );
    expect(formatIngredient({ quantityText: 'to taste', item: 'Pepper' })).toBe(
      'Pepper, to taste',
    );
  });

  it('keeps a real quantity phrase in front', () => {
    expect(formatIngredient({ quantityText: 'a handful', item: 'coriander' })).toBe(
      'a handful coriander',
    );
  });

  it('appends a note after a comma', () => {
    expect(formatIngredient({ quantity: 2, item: 'onions', note: 'thinly sliced' })).toBe(
      '2 onions, thinly sliced',
    );
  });

  it('handles an ingredient with no quantity at all', () => {
    expect(formatIngredient({ item: 'Garlic' })).toBe('Garlic');
  });
});
