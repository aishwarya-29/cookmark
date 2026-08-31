import { escapeHtml } from './dom';
import type { Route } from './router';

/**
 * App chrome — the persistent frame around every screen.
 *
 * A native-feeling app has a fixed shell and swapping content, not one long
 * document. The header and tab bar live outside #app so they never re-render
 * with the view, which is what stops the tab bar flickering on navigation.
 */

export type Tab = 'library' | 'add' | 'settings';

/** Sticky top bar. Title collapses into the bar as the page scrolls. */
export function headerHtml(title: string, opts: { back?: string; compact?: boolean } = {}): string {
  return `
    <header class="topbar ${opts.compact ? 'compact' : ''}">
      ${
        opts.back
          // A button using real browser history, not a link to a fixed
          // destination: an href both pushes a new entry AND ignores where the
          // user actually came from (a recipe opened from a collection should
          // return to that collection, not to home).
          ? `<button class="topbar-back" data-action="go-back" aria-label="Back">
               <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                 <path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round"/>
               </svg>
             </button>`
          : ''
      }
      <span class="topbar-title">${escapeHtml(title)}</span>
    </header>`;
}

/**
 * Bottom tab bar. Anchored in the thumb zone and padded for the home
 * indicator, so an installed PWA doesn't put controls under the gesture bar.
 */
export function tabBarHtml(active: Tab): string {
  const tab = (
    id: Tab,
    label: string,
    href: string,
    icon: string,
    isButton = false,
  ): string => {
    const cls = `tab ${active === id ? 'active' : ''}`;
    const inner = `${icon}<span>${label}</span>`;
    return isButton
      ? `<button class="${cls}" data-tab="${id}" aria-label="${label}">${inner}</button>`
      : `<a class="${cls}" href="${href}" aria-label="${label}">${inner}</a>`;
  };

  const iconLibrary = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6.5A2.5 2.5 0 016.5 4H19v14.5M4 6.5V19a1 1 0 001 1h14M4 6.5A2.5 2.5 0 006.5 9H19"
            stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  const iconAdd = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2"
            stroke-linecap="round"/>
    </svg>`;

  const iconSettings = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.7"/>
      <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6L6 18M18 18l-1.4-1.4M7.4 7.4L6 6"
            stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </svg>`;

  return `
    <nav class="tabbar" aria-label="Main">
      ${tab('library', 'Library', '#/', iconLibrary)}
      ${tab('add', 'Add', '#', iconAdd, true)}
      ${tab('settings', 'Settings', '#/settings', iconSettings)}
    </nav>`;
}

/**
 * The paste sheet — capture lives here rather than permanently occupying the
 * top of the library. It slides up from the tab bar, which is where the
 * thumb already is.
 */
export function pasteSheetHtml(open: boolean, clipboardOffer: string | null): string {
  return `
    <div class="sheet-scrim ${open ? 'open' : ''}" data-close-sheet></div>
    <div class="sheet ${open ? 'open' : ''}" role="dialog" aria-label="Save a reel"
         aria-hidden="${open ? 'false' : 'true'}">
      <div class="sheet-grip"></div>
      <h2 class="sheet-title">Save a reel</h2>

      ${
        clipboardOffer
          ? `<div class="clip-offer">
               <button class="clip-main" data-action="accept-clip">
                 <span class="clip-label">Found on your clipboard</span>
                 <span class="clip-url">${escapeHtml(clipboardOffer)}</span>
               </button>
               <button class="clip-dismiss" data-action="dismiss-clip"
                       aria-label="Not now">Not now</button>
             </div>`
          : ''
      }

      <form class="paste-form" id="paste-form" novalidate>
        <input id="url-input" type="text" inputmode="url" autocomplete="off"
               autocapitalize="off" spellcheck="false"
               placeholder="https://instagram.com/reel/…"
               aria-label="Instagram reel link" />
        <button type="submit">Save</button>
      </form>

      <p class="sheet-hint dim small">
        Copy a link in Instagram, come back, and it's saved before anything else happens.
      </p>

      <button class="subtle sheet-alt" data-action="new-manual">Write a recipe by hand</button>
    </div>`;
}

export function activeTabFor(route: Route): Tab {
  return route.name === 'library' ? 'library' : 'library';
}

/**
 * "Add to a collection" — a checklist sheet reached from a recipe (FR-3.5).
 * A recipe can be in many collections, so these are toggles rather than a
 * single choice.
 */
export function collectionPickerHtml(
  open: boolean,
  collections: { id: string; name: string; recipeIds: string[] }[],
  recipeId: string | null,
): string {
  const rows = collections
    .map((c) => {
      const inIt = recipeId ? c.recipeIds.includes(recipeId) : false;
      return `
        <button class="pick-row ${inIt ? 'on' : ''}" data-toggle-collection="${c.id}">
          <span class="pick-tick">${inIt ? '✓' : ''}</span>
          <span class="pick-name">${escapeHtml(c.name)}</span>
          <span class="pick-count dim small">${c.recipeIds.length}</span>
        </button>`;
    })
    .join('');

  return `
    <div class="sheet-scrim ${open ? 'open' : ''}" data-close-picker></div>
    <div class="sheet ${open ? 'open' : ''}" role="dialog" aria-label="Add to a collection"
         aria-hidden="${open ? 'false' : 'true'}">
      <div class="sheet-grip"></div>
      <h2 class="sheet-title">Add to a collection</h2>
      ${
        collections.length
          ? `<div class="pick-list">${rows}</div>`
          : `<p class="dim small">No collections yet. Make your first one below.</p>`
      }
      <button class="subtle sheet-alt" data-action="new-collection-from-recipe">
        New collection
      </button>
    </div>`;
}
