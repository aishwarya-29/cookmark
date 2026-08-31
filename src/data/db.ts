import Dexie, { type Table } from 'dexie';
import type { Recipe, Collection } from './types';

/**
 * On-device store. Local-first (NFR-4.4) — this is the primary copy of the
 * user's data, not a cache of something else.
 *
 * Indexes are deliberately minimal. `sourceUrl` is unique because duplicate
 * detection (FR-2.2) depends on the database enforcing it rather than on
 * application code remembering to check.
 *
 * MIGRATIONS: Dexie applies every version in order, so adding a store is
 * additive and existing recipes are untouched. Never remove or retype a field
 * in place — the user's library is the primary copy and cannot be rebuilt.
 */
export class ReelRecipesDb extends Dexie {
  recipes!: Table<Recipe, string>;
  collections!: Table<Collection, string>;

  /**
   * DO NOT RENAME. The app is called Cookmark now, but this string is the
   * IndexedDB database name: changing it would orphan every recipe already
   * saved on the device, with no way to get them back. The user-facing name
   * and the storage key are deliberately allowed to diverge.
   */
  constructor(name = 'reel-recipes') {
    super(name);

    this.version(1).stores({
      // &sourceUrl — unique. savedAt — for newest-first listing.
      recipes: 'id, &sourceUrl, savedAt, status, extractionState',
    });

    // v2 — user-defined collections (FR-3.5). Purely additive: the recipes
    // store is unchanged, so nothing needs upgrading.
    this.version(2).stores({
      recipes: 'id, &sourceUrl, savedAt, status, extractionState',
      collections: 'id, name, updatedAt',
    });
  }
}

export const db = new ReelRecipesDb();
