import type { Recipe, Collection } from '../data/types';
import { coverRecipeFor, recipesIn } from '../data/collections';
import { escapeHtml } from './dom';
import { thumbSrc, isCached } from '../lib/thumbnail';

/**
 * Home — a grid of collection folders, in the spirit of Instagram's Saved
 * collections (FR-3.5). Recipes live one level down.
 *
 * "All recipes" is always present and always first, so home is never empty
 * and there is always a way to everything. It is a view, not a stored
 * collection.
 */

/** A folder tile. Cover image where one exists, else a warm placeholder. */
function folderTile(opts: {
  href: string;
  name: string;
  count: number;
  /** The recipe whose image fronts the folder, if any has one. */
  cover?: Recipe;
  pinned?: boolean;
}): string {
  const label = `${opts.count} ${opts.count === 1 ? 'recipe' : 'recipes'}`;
  // Cached bytes win over the remote URL — see thumbSrc. `loading="lazy"` is
  // only safe for the remote URL; on a cached image it would defer a swap that
  // has already happened.
  const src = opts.cover ? thumbSrc(opts.cover) : undefined;
  const cached = opts.cover ? isCached(opts.cover.id) : false;

  return `
    <a class="folder ${opts.pinned ? 'pinned' : ''}" href="${escapeHtml(opts.href)}">
      <div class="folder-cover">
        ${
          src
            ? `<img src="${escapeHtml(src)}" alt=""${cached ? '' : ' loading="lazy"'}
                    data-thumb-for="${opts.cover!.id}"
                    referrerpolicy="no-referrer"
                    onerror="this.closest('.folder-cover').classList.add('broken')" />`
            : ''
        }
        <div class="folder-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M3 7.5A1.5 1.5 0 014.5 6h4.2a1.5 1.5 0 011.06.44l1.3 1.3a1.5 1.5 0 001.06.44h6.38A1.5 1.5 0 0120 9.68V17a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013 17V7.5z"
                  stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
      <p class="folder-name">${escapeHtml(opts.name)}</p>
      <p class="folder-count">${label}</p>
    </a>`;
}

export function homeHtml(recipes: Recipe[], collections: Collection[]): string {
  // First run: teach the flow rather than showing an empty grid.
  if (!recipes.length) {
    return `
      <div class="empty first-run">
        <div class="first-run-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor"
                  stroke-width="1.5"/>
            <path d="M10 8.5l5.5 3.5L10 15.5v-7z" fill="currentColor"/>
          </svg>
        </div>
        <p><strong>Your library is empty</strong></p>
        <p class="dim">Copy a reel link in Instagram, then tap Add.</p>
        <button data-action="open-sheet">Save your first reel</button>
      </div>`;
  }

  // Recipes in no collection at all — always reachable, never orphaned.
  const filed = new Set(collections.flatMap((c) => c.recipeIds));
  const unfiled = recipes.filter((r) => !filed.has(r.id));

  const tiles: string[] = [
    folderTile({
      href: '#/all',
      name: 'All recipes',
      count: recipes.length,
      cover: recipes.find((r) => r.thumbnailUrl),
      pinned: true,
    }),
    ...collections.map((c) =>
      folderTile({
        href: `#/collection/${c.id}`,
        name: c.name,
        count: recipesIn(c, recipes).length,
        cover: coverRecipeFor(c, recipes),
      }),
    ),
  ];

  // Only worth showing once collections exist to file things into.
  if (collections.length && unfiled.length) {
    tiles.push(
      folderTile({
        href: '#/unfiled',
        name: 'Not in a collection',
        count: unfiled.length,
        cover: unfiled.find((r) => r.thumbnailUrl),
      }),
    );
  }

  return `
    <div class="folder-grid">
      ${tiles.join('')}
      <button class="folder new-folder" data-action="new-collection">
        <div class="folder-cover">
          <div class="folder-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 7v10M7 12h10" stroke="currentColor" stroke-width="1.8"
                    stroke-linecap="round"/>
            </svg>
          </div>
        </div>
        <p class="folder-name">New collection</p>
        <p class="folder-count">Group recipes yourself</p>
      </button>
    </div>`;
}
