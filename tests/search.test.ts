import { describe, it, expect } from 'vitest';
import {
  matchByIngredients,
  parseIngredientQuery,
  searchRecipes,
  allTags,
} from '../src/lib/search';
import { ingredientTerms, recipeSearchTerms, termMatches } from '../src/lib/ingredient-terms';
import type { Recipe, Ingredient } from '../src/data/types';

function recipe(partial: Partial<Recipe> & { title: string }): Recipe {
  const ingredients = partial.ingredients ?? [];
  return {
    id: partial.title.toLowerCase().replace(/\W+/g, '-'),
    sourceUrl: `https://www.instagram.com/reel/${partial.title.slice(0, 6)}/`,
    extractionMethod: 'caption',
    status: 'complete',
    extractionState: 'settled',
    attempts: [],
    savedAt: 1,
    updatedAt: 1,
    searchTerms: recipeSearchTerms(ingredients),
    ...partial,
    ingredients,
  };
}

const ing = (item: string, extra: Partial<Ingredient> = {}): Ingredient => ({ item, ...extra });

const LIBRARY: Recipe[] = [
  recipe({
    title: 'Chicken Bhuna Masala',
    cuisine: 'Indian',
    mealType: 'dinner',
    tags: ['quick', 'one-pot'],
    ingredients: [
      ing('chicken', { quantity: 500, unit: 'gm' }),
      ing('onions', { quantity: 2, note: 'thinly sliced' }),
      ing('ginger garlic paste', { quantity: 1, unit: 'tbsp' }),
      ing('yoghurt', { quantity: 0.5, unit: 'cup' }),
    ],
    steps: ['Marinate the chicken.', 'Fry the onions.'],
  }),
  recipe({
    title: 'Potato and Coriander Salad',
    cuisine: 'British',
    mealType: 'lunch',
    tags: ['vegetarian'],
    ingredients: [
      ing('potatoes', { quantity: 4 }),
      ing('coriander', { note: 'freshly chopped' }),
      ing('olive oil', { quantity: 2, unit: 'tbsp' }),
    ],
    steps: ['Boil the potatoes.'],
  }),
  recipe({
    title: 'Chicken and Potato Traybake',
    cuisine: 'British',
    mealType: 'dinner',
    tags: ['one-pot'],
    ingredients: [
      ing('chicken thighs', { quantity: 6 }),
      ing('potatoes', { quantity: 500, unit: 'g' }),
      ing('rosemary'),
    ],
    steps: ['Roast everything together.'],
  }),
];

describe('ingredientTerms — normalising messy real ingredients', () => {
  it('strips quantity, unit, and preparation words', () => {
    expect(ingredientTerms(ing('garlic', { quantity: 3, unit: 'cloves', note: 'finely sliced' })))
      .toContain('garlic');
  });

  it('reduces plurals so "potatoes" matches "potato"', () => {
    expect(ingredientTerms(ing('potatoes'))).toContain('potato');
  });

  it('keeps each word AND the whole phrase', () => {
    const terms = ingredientTerms(ing('ginger garlic paste'));
    expect(terms).toContain('ginger');
    expect(terms).toContain('garlic');
    expect(terms).toContain('ginger garlic paste');
  });

  it('drops prep words that are not the foodstuff', () => {
    const terms = ingredientTerms(ing('freshly chopped coriander'));
    expect(terms).toContain('coriander');
    expect(terms).not.toContain('chopped');
    expect(terms).not.toContain('freshly');
  });

  it('returns nothing for an empty item', () => {
    expect(ingredientTerms(ing(''))).toEqual([]);
  });
});

describe('termMatches — typo tolerance (FR-3.2)', () => {
  it('matches exactly', () => {
    expect(termMatches('chicken', 'chicken')).toBe(true);
  });

  it('matches a plural query against a singular term', () => {
    expect(termMatches('potatoes', 'potato')).toBe(true);
  });

  it('tolerates a misspelling', () => {
    // The PRD calls this out by name: "corriander" should find "coriander".
    expect(termMatches('corriander', 'coriander')).toBe(true);
  });

  it('does not match unrelated words', () => {
    expect(termMatches('chicken', 'chocolate')).toBe(false);
    expect(termMatches('beef', 'chicken')).toBe(false);
  });

  it('will not fuzzy-match very short words, where it would be noise', () => {
    expect(termMatches('oil', 'egg')).toBe(false);
  });
});

describe('matchByIngredients — "what can I cook?" (FR-3.4)', () => {
  it('finds the recipe using both ingredients I have', () => {
    const out = matchByIngredients(LIBRARY, ['chicken', 'potatoes']);
    expect(out[0]!.recipe.title).toBe('Chicken and Potato Traybake');
    expect(out[0]!.have).toHaveLength(2);
    expect(out[0]!.missing).toHaveLength(0);
  });

  it('includes partial matches and says what is missing', () => {
    const out = matchByIngredients(LIBRARY, ['chicken', 'potatoes']);
    const partial = out.find((m) => m.recipe.title === 'Chicken Bhuna Masala');
    expect(partial).toBeDefined();
    expect(partial!.have).toEqual(['chicken']);
    expect(partial!.missing).toEqual(['potatoes']);
  });

  it('ranks full matches above partial ones', () => {
    const out = matchByIngredients(LIBRARY, ['chicken', 'potatoes']);
    expect(out[0]!.score).toBe(1);
    expect(out[out.length - 1]!.score).toBeLessThan(1);
  });

  it('excludes recipes using none of the query', () => {
    const out = matchByIngredients(LIBRARY, ['chocolate']);
    expect(out).toHaveLength(0);
  });

  it('matches through a phrase ingredient', () => {
    const out = matchByIngredients(LIBRARY, ['ginger']);
    expect(out.map((m) => m.recipe.title)).toContain('Chicken Bhuna Masala');
  });

  it('returns nothing for an empty query', () => {
    expect(matchByIngredients(LIBRARY, [])).toHaveLength(0);
  });
});

describe('parseIngredientQuery', () => {
  it('splits on commas and "and"', () => {
    expect(parseIngredientQuery('chicken, potatoes and cream')).toEqual([
      'chicken',
      'potatoes',
      'cream',
    ]);
  });

  it('strips leading articles', () => {
    expect(parseIngredientQuery('some chicken, the potatoes')).toEqual(['chicken', 'potatoes']);
  });

  it('ignores fragments too short to be meaningful', () => {
    expect(parseIngredientQuery('a, chicken')).toEqual(['chicken']);
  });
});

describe('searchRecipes — full text (FR-3.2)', () => {
  it('finds by title', () => {
    expect(searchRecipes(LIBRARY, 'bhuna')[0]!.title).toBe('Chicken Bhuna Masala');
  });

  it('finds by ingredient', () => {
    expect(searchRecipes(LIBRARY, 'rosemary').map((r) => r.title)).toEqual([
      'Chicken and Potato Traybake',
    ]);
  });

  it('finds by tag and by cuisine', () => {
    expect(searchRecipes(LIBRARY, 'vegetarian')).toHaveLength(1);
    expect(searchRecipes(LIBRARY, 'indian')).toHaveLength(1);
  });

  it('treats multiple words as AND, so more words narrow the result', () => {
    const broad = searchRecipes(LIBRARY, 'chicken');
    const narrow = searchRecipes(LIBRARY, 'chicken rosemary');
    expect(broad.length).toBeGreaterThan(narrow.length);
    expect(narrow).toHaveLength(1);
  });

  it('ranks a title match above a body match', () => {
    expect(searchRecipes(LIBRARY, 'potato')[0]!.title).toContain('Potato');
  });

  it('returns everything for an empty query', () => {
    expect(searchRecipes(LIBRARY, '   ')).toHaveLength(LIBRARY.length);
  });

  it('returns nothing when a word matches nothing', () => {
    expect(searchRecipes(LIBRARY, 'lasagne')).toHaveLength(0);
  });
});

describe('allTags — autocomplete source (FR-3.6)', () => {
  it('counts usage and sorts by frequency', () => {
    const tags = allTags(LIBRARY);
    expect(tags[0]).toEqual({ tag: 'one-pot', count: 2 });
    expect(tags.map((t) => t.tag)).toContain('vegetarian');
  });
});
