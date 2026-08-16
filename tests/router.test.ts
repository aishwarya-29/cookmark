import { describe, it, expect } from 'vitest';
import { parseRoute } from '../src/ui/router';

describe('parseRoute', () => {
  it('defaults to the library', () => {
    expect(parseRoute('').name).toBe('library');
    expect(parseRoute('#').name).toBe('library');
    expect(parseRoute('#/').name).toBe('library');
  });

  it('parses recipe, cook, and edit routes', () => {
    expect(parseRoute('#/recipe/abc-123')).toEqual({ name: 'recipe', id: 'abc-123' });
    expect(parseRoute('#/cook/abc-123')).toEqual({ name: 'cook', id: 'abc-123' });
    expect(parseRoute('#/edit/abc-123')).toEqual({ name: 'edit', id: 'abc-123' });
  });

  it('falls back to the library for a route with no id', () => {
    expect(parseRoute('#/recipe').name).toBe('library');
    expect(parseRoute('#/cook/').name).toBe('library');
  });

  it('falls back to the library for an unknown route', () => {
    expect(parseRoute('#/nonsense/1').name).toBe('library');
  });
});
