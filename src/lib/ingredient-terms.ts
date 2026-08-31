import type { Ingredient } from '../data/types';

/**
 * Ingredient normalisation for search — PRD FR-3.4.
 *
 * A search for "garlic" must find "3 cloves garlic, finely sliced", "Garlic-
 * 4 No's", and "ginger garlic paste". That means reducing each ingredient to
 * the foodstuff itself, stripping preparation words, plurals, and quantities.
 *
 * Deliberately shallow: no stemmer, no ontology. Real captions are messy in
 * predictable ways, and a short explicit word list is easier to fix at 11pm
 * than a clever algorithm (NFR-6.1).
 */

/** Preparation and qualifier words that are never the foodstuff. */
const PREP_WORDS = new Set([
  'finely', 'roughly', 'thinly', 'thickly', 'freshly', 'lightly', 'well',
  'chopped', 'sliced', 'diced', 'minced', 'grated', 'crushed', 'ground',
  'peeled', 'washed', 'rinsed', 'drained', 'soaked', 'beaten', 'whisked',
  'melted', 'softened', 'chilled', 'warm', 'cold', 'hot', 'room',
  'temperature', 'large', 'small', 'medium', 'big', 'whole', 'half',
  'fresh', 'dried', 'dry', 'frozen', 'canned', 'tinned', 'raw', 'cooked',
  'optional', 'taste', 'needed', 'required', 'garnish', 'serve', 'serving',
  'each', 'about', 'approx', 'roughly', 'plus', 'extra', 'more', 'few',
  'little', 'bit', 'good', 'quality', 'best', 'nice',
]);

/** Units, so "cloves garlic" reduces to "garlic". */
const UNIT_WORDS = new Set([
  'tablespoon', 'tablespoons', 'tbsp', 'tbsps', 'tbs',
  'teaspoon', 'teaspoons', 'tsp', 'tsps',
  'cup', 'cups', 'gram', 'grams', 'g', 'gm', 'gms', 'kg', 'kgs',
  'kilogram', 'kilograms', 'ml', 'mls', 'litre', 'litres', 'liter', 'liters',
  'l', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds',
  'pinch', 'pinches', 'clove', 'cloves', 'inch', 'inches',
  'handful', 'handfuls', 'bunch', 'bunches', 'slice', 'slices',
  'piece', 'pieces', 'can', 'cans', 'tin', 'tins', 'sprig', 'sprigs',
  'stick', 'sticks', 'no', 'nos', "no's", 'nom', 'numbers', 'number',
]);

/** Filler words with no search value. */
const STOP_WORDS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'with', 'as',
  'into', 'at', 'on', 'by', 'from', 'per', 'your', 'you', 'it', 'its',
]);

/**
 * Reduce an ingredient to its searchable terms.
 *
 * "3 cloves garlic, finely sliced" → ["garlic"]
 * "1 tbsp ginger garlic paste"     → ["ginger", "garlic", "paste", "ginger garlic paste"]
 */
export function ingredientTerms(ing: Ingredient): string[] {
  const raw = `${ing.item ?? ''}`.toLowerCase();
  if (!raw.trim()) return [];

  const words = raw
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !UNIT_WORDS.has(w))
    .filter((w) => !PREP_WORDS.has(w))
    .filter((w) => !STOP_WORDS.has(w))
    .map(singularise)
    .filter((w) => w.length >= 2);

  if (!words.length) return [];

  const terms = new Set(words);
  // Keep the whole phrase too, so "ginger garlic paste" is findable as such.
  if (words.length > 1) terms.add(words.join(' '));
  return [...terms];
}

/**
 * Crude singulariser. Handles the endings that actually occur in ingredient
 * names; deliberately does not try to be a general stemmer.
 */
export function singularise(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ses') || word.endsWith('shes') || word.endsWith('ches')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

/** All searchable terms for a recipe's ingredient list. */
export function recipeSearchTerms(ingredients: Ingredient[] | undefined): string[] {
  const set = new Set<string>();
  for (const ing of ingredients ?? []) {
    for (const t of ingredientTerms(ing)) set.add(t);
  }
  return [...set];
}

/**
 * Trigram similarity, for typo tolerance (FR-3.2) — "corriander" should find
 * "coriander". Local and cheap; the library is small enough that comparing a
 * query against every term is instant.
 */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** True when a query term matches a stored term exactly, by prefix, or closely. */
export function termMatches(query: string, term: string): boolean {
  const q = singularise(query.toLowerCase().trim());
  const t = term.toLowerCase();
  if (!q) return false;
  if (t === q || t.includes(q) || q.includes(t)) return true;
  // Only attempt fuzzy matching on words long enough for it to mean something.
  return q.length >= 5 && similarity(q, t) >= 0.55;
}
