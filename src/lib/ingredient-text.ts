import type { Ingredient } from '../data/types';
import { parseIngredientLine } from './parse-caption';
import { formatIngredient } from './quantity';

/**
 * Ingredients <-> editable text — PRD v2 FR-8.
 *
 * The edit screen shows ingredients as one line each, because that is the
 * shape people paste and the shape they think in. Turning those lines back
 * into rows used to store the WHOLE line as `item`, which quietly destroyed
 * quantity and unit: a hand-edited recipe could no longer be scaled, and its
 * ingredients could not be merged into a grocery list by amount.
 *
 * This reuses the caption parser rather than growing a second, weaker one
 * (FR-8.2) — one parser, one set of tests, one place to fix a bug.
 *
 * THE GUARD (FR-8.3). The caption parser is built for captions, which carry
 * prose and promotional noise, so it does things that are right there and
 * wrong here:
 *
 *   "Oil - for frying"  ->  "for frying Oil"   word order scrambled
 *   "#hashtag thing"    ->  "thing"            hashtag stripped as noise
 *
 * In a caption that is cleanup. In the edit box it is rewriting what someone
 * deliberately typed. So a parse is kept ONLY when re-formatting it reproduces
 * the input; otherwise the line is stored verbatim as `item`. Structure is a
 * bonus, never a reason to alter the user's words.
 */

/** Vulgar fractions, mapped to the decimals they render as. */
const FRACTION_GLYPHS: Record<string, string> = {
  '½': '.5', '⅓': '.333', '⅔': '.667', '¼': '.25', '¾': '.75',
  '⅕': '.2', '⅖': '.4', '⅗': '.6', '⅘': '.8', '⅙': '.167', '⅚': '.833',
  '⅛': '.125', '⅜': '.375', '⅝': '.625', '⅞': '.875',
};

/**
 * Reduce a line to what it MEANS, so the guard compares substance rather than
 * notation.
 *
 * Without this, "300g noodles" would be rejected because the parser renders it
 * back as "300 g noodles", and "1½ cups" because the user typed "1.5 cups" —
 * losing structure over a space or a glyph. Case, spacing, punctuation and
 * fraction notation are all noise here; digits and letters are the signal.
 */
function normalise(s: string): string {
  let t = s.toLowerCase();
  for (const [glyph, decimal] of Object.entries(FRACTION_GLYPHS)) {
    t = t.split(glyph).join(decimal);
  }
  // "1 . 5" and "1.5" are the same number written differently.
  t = t.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
  // formatQuantity rounds to two decimals, so ⅓ renders as 0.33 where this
  // map gives .333. Truncate both to the same precision before comparing.
  t = t.replace(/(\d*\.\d\d)\d+/g, '$1');
  return t.replace(/[^a-z0-9.]/g, '');
}

/**
 * Parse one typed line into an ingredient, keeping structure only when it is
 * faithful to the input. Never returns null for non-empty input: an
 * unparseable line is still an ingredient, just an unstructured one.
 */
export function parseIngredientText(raw: string): Ingredient | null {
  const line = raw.trim();
  if (!line) return null;

  const parsed = parseIngredientLine(line);
  if (!parsed) return { item: line };

  return normalise(formatIngredient(parsed)) === normalise(line) ? parsed : { item: line };
}

/** The edit textarea's contents as structured rows. Blank lines are dropped. */
export function textToIngredients(text: string): Ingredient[] {
  return text
    .split('\n')
    .map(parseIngredientText)
    .filter((i): i is Ingredient => i !== null);
}

/** Ingredients as editable text — one per line, the format people paste. */
export function ingredientsToText(list: Ingredient[] | undefined): string {
  return (list ?? []).map(formatIngredient).join('\n');
}

/** True when a row carries more than just a name — i.e. it can be scaled. */
export function hasStructure(ing: Ingredient): boolean {
  return ing.quantity !== undefined || ing.unit !== undefined || ing.quantityText !== undefined;
}
