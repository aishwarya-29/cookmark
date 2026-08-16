import Dexie, { type Table } from 'dexie';
import type { Recipe } from './types';

/**
 * On-device store. Local-first (NFR-4.4) — this is the primary copy of the
 * user's data, not a cache of something else.
 *
 * Indexes are deliberately minimal for now. `sourceUrl` is unique because
 * duplicate detection (FR-2.2) depends on the database enforcing it rather
 * than on application code remembering to check.
 */
export class ReelRecipesDb extends Dexie {
  recipes!: Table<Recipe, string>;

  constructor(name = 'reel-recipes') {
    super(name);
    this.version(1).stores({
      // &sourceUrl — unique. savedAt — for newest-first listing.
      recipes: 'id, &sourceUrl, savedAt, status, extractionState',
    });
  }
}

export const db = new ReelRecipesDb();
