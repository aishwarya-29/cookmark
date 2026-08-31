/**
 * Quantity formatting for display.
 *
 * Quantities are stored as numbers so they can be scaled later (FR-4.3), but
 * "0.3333333333333333 cup yoghurt" is not something anyone wants to read in a
 * kitchen. This renders the number back into cooking notation.
 */

/** Common cooking fractions, longest denominators last so 1/2 wins over 2/4. */
const FRACTION_GLYPHS: [number, string][] = [
  [0.125, '⅛'],
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.375, '⅜'],
  [0.5, '½'],
  [0.625, '⅝'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
  [0.875, '⅞'],
];

const TOLERANCE = 0.02;

/**
 * Format a numeric quantity the way a recipe would write it.
 *
 * 0.5 → "½", 1.5 → "1½", 0.333… → "⅓", 500 → "500", 2.25 → "2¼"
 */
export function formatQuantity(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';

  const whole = Math.floor(n);
  const frac = n - whole;

  if (frac < TOLERANCE) return String(whole);

  for (const [value, glyph] of FRACTION_GLYPHS) {
    if (Math.abs(frac - value) < TOLERANCE) {
      return whole > 0 ? `${whole}${glyph}` : glyph;
    }
  }

  // Not a recognisable cooking fraction — show at most two decimals, trimmed.
  return String(Math.round(n * 100) / 100);
}

/**
 * Render one ingredient as a single line. The one place this formatting lives,
 * so the library, detail view, and cook mode cannot drift apart.
 */
export function formatIngredient(ing: {
  quantity?: number;
  quantityText?: string;
  unit?: string;
  item: string;
  note?: string;
}): string {
  let line: string;

  if (ing.quantity !== undefined) {
    line = [formatQuantity(ing.quantity), ing.unit, ing.item].filter(Boolean).join(' ');
  } else if (ing.quantityText) {
    // Qualifiers like "as needed" or "to taste" read as a trailing phrase, not
    // a leading quantity: "Salt, as needed" — never "as needed Salt".
    const trailing = /^(?:as needed|to taste|as required|optional|for garnish|to serve)$/i.test(
      ing.quantityText.trim(),
    );
    line = trailing
      ? `${[ing.item, ing.unit].filter(Boolean).join(' ')}, ${ing.quantityText.trim()}`
      : [ing.quantityText, ing.unit, ing.item].filter(Boolean).join(' ');
  } else {
    line = [ing.unit, ing.item].filter(Boolean).join(' ');
  }

  return ing.note ? `${line}, ${ing.note}` : line;
}
