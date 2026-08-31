import { describe, it, expect } from 'vitest';
import { parseRoute } from '../src/ui/router';

describe('parseRoute', () => {
  it('defaults to home — the collection folders (FR-3.5)', () => {
    expect(parseRoute('').name).toBe('home');
    expect(parseRoute('#').name).toBe('home');
    expect(parseRoute('#/').name).toBe('home');
  });

  it('routes #/all to the full library', () => {
    expect(parseRoute('#/all')).toEqual({ name: 'library' });
  });

  it('routes #/collection/:id to that collection', () => {
    expect(parseRoute('#/collection/abc-123')).toEqual({
      name: 'library',
      collectionId: 'abc-123',
    });
  });

  it('parses recipe, cook, and edit routes', () => {
    expect(parseRoute('#/recipe/abc-123')).toEqual({ name: 'recipe', id: 'abc-123' });
    expect(parseRoute('#/cook/abc-123')).toEqual({ name: 'cook', id: 'abc-123' });
    expect(parseRoute('#/edit/abc-123')).toEqual({ name: 'edit', id: 'abc-123' });
  });

  it('falls back to home for a route with no id', () => {
    expect(parseRoute('#/recipe').name).toBe('home');
    expect(parseRoute('#/cook/').name).toBe('home');
    expect(parseRoute('#/collection/').name).toBe('home');
  });

  it('falls back to home for an unknown route', () => {
    expect(parseRoute('#/nonsense/1').name).toBe('home');
  });
});
