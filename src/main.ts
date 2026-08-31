import { saveReelUrl, listRecipes, getRecipe, createManualRecipe } from './data/recipes';
import type { Recipe } from './data/types';
import { InvalidInstagramUrlError } from './lib/url';
import { extractRecipe, processQueue } from './lib/extract';
import {
  checkClipboardForReel,
  markManualPasteDone,
  markClipboardDeclined,
} from './lib/clipboard';
import { currentRoute, onRouteChange, navigate } from './ui/router';
import { libraryHtml } from './ui/library';
import { renderRecipe, renderEdit } from './ui/recipe';
import { renderCook, enterCookMode, exitCookMode } from './ui/cook';
import { escapeHtml, onClick } from './ui/dom';
import {
  searchPanelHtml, matchResultsHtml, applyFilters, ingredientMatches,
  isSearchActive, emptySearch, type SearchState,
} from './ui/search-ui';
import { allTags } from './lib/search';
import { homeHtml } from './ui/home';
import {
  listCollections, createCollection, toggleInCollection, deleteCollection,
  renameCollection, recipesIn,
} from './data/collections';
import type { Collection } from './data/types';
import { headerHtml, tabBarHtml, pasteSheetHtml, collectionPickerHtml } from './ui/chrome';
import { settingsHtml, bindSettings, registerServiceWorker } from './ui/settings';

/**
 * App shell: owns routing, the paste bar, and the single render entry point.
 * Views live in ./ui/* and are pure render functions given a recipe.
 */

type Notice = { tone: 'info' | 'duplicate' | 'error'; text: string } | null;

const app = document.querySelector<HTMLElement>('#app')!;
const chromeTop = document.querySelector<HTMLDivElement>('#chrome-top')!;
const chromeBottom = document.querySelector<HTMLDivElement>('#chrome-bottom')!;
const sheetRoot = document.querySelector<HTMLDivElement>('#sheet-root')!;

let recipes: Recipe[] = [];
let notice: Notice = null;
let saving = false;
/** A reel found on the clipboard, awaiting the user's confirmation (FR-1.2). */
let clipboardOffer: string | null = null;
/** True while cook mode holds the screen, so we can tear it down on route change. */
let cooking = false;
/** Current search / filter state (FR-3.2, FR-3.3, FR-3.4). */
let search: SearchState = { ...emptySearch };
/** Whether the paste sheet is open. */
let sheetOpen = false;
/** User-defined collections (FR-3.5). */
let collections: Collection[] = [];
/** Recipe id whose "add to collection" picker is open, if any. */
let pickerFor: string | null = null;

function libraryShellHtml(collection?: Collection): string {
  const noticeHtml = notice
    ? `<div class="notice ${notice.tone}">${escapeHtml(notice.text)}</div>`
    : '';

  // Inside a collection, search and filters apply to that collection only.
  const scope = collection ? recipesIn(collection, recipes) : recipes;

  // Ingredient match replaces the normal list when active — a different
  // question deserves a different answer shape.
  const matching = search.cookWith.trim().length > 0;
  const visible = applyFilters(scope, search);
  const listHtml = matching
    ? matchResultsHtml(ingredientMatches(scope, search))
    : libraryHtml(visible);

  const countLabel = isSearchActive(search)
    ? matching
      ? 'What you can cook'
      : `${visible.length} of ${scope.length}`
    : `${scope.length} ${scope.length === 1 ? 'recipe' : 'recipes'}`;

  return `
    ${noticeHtml}
    ${searchPanelHtml(scope, search)}

    <div class="library-head">
      <p class="section-label">${escapeHtml(countLabel)}</p>
      ${
        collection
          ? `<button class="subtle" data-action="collection-menu">Edit</button>`
          : ''
      }
    </div>
    ${
      collection && !scope.length
        ? `<div class="empty">
             <p><strong>Nothing in here yet</strong></p>
             <p class="dim">Open a recipe and use “add to a collection”.</p>
           </div>`
        : listHtml
    }
  `;
}

/** Render the chrome (header + tab bar + sheet), which lives outside #app. */
function renderChrome(route: ReturnType<typeof currentRoute>, title: string): void {
  // Cook mode is a full takeover: no header, no tabs, nothing to mis-tap.
  if (route.name === 'cook') {
    chromeTop.innerHTML = '';
    chromeBottom.innerHTML = '';
    sheetRoot.innerHTML = '';
    return;
  }

  // Home is the only screen with no back link; everything else returns to it.
  const back = route.name === 'home' ? undefined : '#/';
  chromeTop.innerHTML = headerHtml(title, back ? { back } : {});

  // The tab bar and paste sheet belong to the browsing screens, not to detail.
  const browsing = route.name === 'home' || route.name === 'library';
  chromeBottom.innerHTML =
    browsing || route.name === 'settings'
      ? tabBarHtml(route.name === 'settings' ? 'settings' : 'library')
      : '';
  sheetRoot.innerHTML = browsing ? pasteSheetHtml(sheetOpen, clipboardOffer) : '';

  onClick(chromeBottom, '[data-tab="add"]', () => {
    sheetOpen = true;
    void render();
    // Focus after the sheet's transition, so iOS doesn't scroll mid-animation.
    setTimeout(() => sheetRoot.querySelector<HTMLInputElement>('#url-input')?.focus(), 260);
  });

  onClick(sheetRoot, '[data-close-sheet]', () => {
    sheetOpen = false;
    void render();
  });

  const form = sheetRoot.querySelector<HTMLFormElement>('#paste-form');
  form?.addEventListener('submit', onSubmit);

  onClick(sheetRoot, '[data-action="accept-clip"]', () => void acceptClipboardOffer());
  onClick(sheetRoot, '[data-action="dismiss-clip"]', () => {
    // Declined for good — no nag prompts (FR-1.2).
    clipboardOffer = null;
    markClipboardDeclined();
    void render();
  });
  onClick(sheetRoot, '[data-action="new-manual"]', async () => {
    sheetOpen = false;
    const r = await createManualRecipe('Untitled recipe');
    await refresh();
    navigate(`#/edit/${r.id}`);
  });
}

async function render(): Promise<void> {
  const route = currentRoute();

  // Leaving cook mode by any path — back button included — must release the
  // wake lock, or the screen stays awake for the rest of the session.
  if (cooking && route.name !== 'cook') {
    cooking = false;
    await exitCookMode();
  }

  if (route.name === 'home') {
    renderChrome(route, 'Reel Recipes');
    app.innerHTML = homeHtml(recipes, collections);
    document.body.classList.toggle('sheet-open', sheetOpen);

    onClick(app, '[data-action="new-collection"]', () => void promptNewCollection());
    onClick(app, '[data-action="open-sheet"]', () => {
      sheetOpen = true;
      void render();
    });
    return;
  }

  if (route.name === 'library') {
    const collection = route.collectionId
      ? collections.find((c) => c.id === route.collectionId)
      : undefined;

    // A deleted collection should not strand the user on a blank screen.
    if (route.collectionId && !collection) {
      navigate('#/');
      return;
    }

    // Preserve what the user is typing across background refreshes — for every
    // text field on screen, including those in the sheet.
    const FIELDS = ['#url-input', '#search-text', '#cook-with'];
    const preserved = FIELDS.map((sel) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      return el
        ? { sel, value: el.value, focused: document.activeElement === el, pos: el.selectionStart }
        : null;
    });

    renderChrome(route, collection ? collection.name : 'All recipes');
    app.innerHTML = libraryShellHtml(collection);
    document.body.classList.toggle('sheet-open', sheetOpen);

    for (const p of preserved) {
      if (!p) continue;
      const el = document.querySelector<HTMLInputElement>(p.sel);
      if (!el) continue;
      el.value = p.value;
      if (p.focused) {
        el.focus();
        try {
          el.setSelectionRange(p.pos ?? 0, p.pos ?? 0);
        } catch {
          /* not selectable */
        }
      }
    }

    // --- Search and filters (FR-3.2, FR-3.3, FR-3.4) ---
    const searchInput = app.querySelector<HTMLInputElement>('#search-text');
    searchInput?.addEventListener('input', () => {
      search = { ...search, text: searchInput.value };
      void render();
    });

    const cookInput = app.querySelector<HTMLInputElement>('#cook-with');
    cookInput?.addEventListener('input', () => {
      search = { ...search, cookWith: cookInput.value };
      void render();
    });

    onClick(app, '[data-filter]', (el) => {
      const key = el.dataset['filter'] as 'cuisine' | 'mealType' | 'tag';
      const value = el.dataset['value'];
      // Tapping an active filter clears it — one tap in, one tap out.
      search = { ...search, [key]: search[key] === value ? undefined : value };
      void render();
    });

    onClick(app, '[data-action="clear-filters"]', () => {
      search = { ...emptySearch };
      void render();
    });

    onClick(app, '[data-action="open-sheet"]', () => {
      sheetOpen = true;
      void render();
    });

    if (collection) {
      onClick(app, '[data-action="collection-menu"]', () => void collectionMenu(collection));
    }

    return;
  }

  if (route.name === 'settings') {
    renderChrome(route, 'Settings');
    app.innerHTML = settingsHtml(recipes.length);
    bindSettings(app, () => void refresh());
    return;
  }

  // Detail, edit, and cook all need a loaded recipe.
  const r = await getRecipe(route.id);
  if (!r) {
    renderChrome(route, 'Not found');
    app.innerHTML = `<div class="empty">That recipe is no longer here.</div>`;
    return;
  }

  document.body.classList.remove('sheet-open');

  if (route.name === 'recipe') {
    renderChrome(route, r.title);
    renderRecipe(app, r, () => void refresh(), allTags(recipes).map((t) => t.tag), collections);

    // The "add to a collection" picker lives in the sheet slot, which the
    // detail screen otherwise leaves empty.
    sheetRoot.innerHTML = collectionPickerHtml(pickerFor === r.id, collections, r.id);
    document.body.classList.toggle('sheet-open', pickerFor === r.id);

    onClick(app, '[data-action="add-to-collection"]', () => {
      pickerFor = r.id;
      void render();
    });
    onClick(sheetRoot, '[data-close-picker]', () => {
      pickerFor = null;
      void render();
    });
    onClick(sheetRoot, '[data-toggle-collection]', async (el) => {
      await toggleInCollection(el.dataset['toggleCollection']!, r.id);
      await refresh();
    });
    onClick(sheetRoot, '[data-action="new-collection-from-recipe"]', async () => {
      await promptNewCollection(r.id);
    });
  } else if (route.name === 'edit') {
    renderChrome(route, 'Edit');
    renderEdit(app, r, () => void refresh());
  } else {
    renderChrome(route, r.title);
    if (!cooking) {
      cooking = true;
      await enterCookMode();
    }
    renderCook(app, r, () => void render());
  }
}

/** Create a collection and drop the user straight into it. */
async function promptNewCollection(recipeId?: string): Promise<void> {
  const name = prompt('Name this collection')?.trim();
  if (!name) return;
  const c = await createCollection(name);
  // Creating one from a recipe means "put this in it" — do that, don't make
  // the user file it separately.
  if (recipeId) await toggleInCollection(c.id, recipeId);
  await refresh();
  if (!recipeId) navigate(`#/collection/${c.id}`);
}

/** Rename or delete a collection. The recipes inside are never touched. */
async function collectionMenu(c: Collection): Promise<void> {
  const name = prompt('Rename this collection, or clear the box to delete it', c.name);
  if (name === null) return;

  if (!name.trim()) {
    const ok = confirm(
      `Delete the collection "${c.name}"? The recipes in it stay in your library.`,
    );
    if (!ok) return;
    await deleteCollection(c.id);
    await refresh();
    navigate('#/');
    return;
  }

  await renameCollection(c.id, name);
  await refresh();
}

async function refresh(): Promise<void> {
  [recipes, collections] = await Promise.all([listRecipes(), listCollections()]);
  await render();
}

/**
 * Turn a save failure into something the user can act on.
 *
 * The generic "couldn't save that" told the user nothing and hid real causes
 * — most importantly a full or unavailable IndexedDB, which is the one case
 * where the product's core promise is genuinely at risk (PRD §07).
 */
function saveErrorMessage(err: unknown): string {
  if (err instanceof InvalidInstagramUrlError) return err.message;

  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);

  if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return 'This device is out of storage, so the reel could not be saved. Free some space and try again.';
  }
  if (name === 'InvalidStateError' || /database|indexeddb/i.test(msg)) {
    // Private browsing on iOS blocks IndexedDB entirely.
    return 'Storage is unavailable in this browser — a private window blocks it. Try a normal tab.';
  }
  // Anything else: say what actually happened rather than a shrug.
  return `Couldn't save that: ${msg || 'unknown error'}`;
}

async function saveUrl(value: string): Promise<void> {
  notice = null;
  saving = true;

  let saved: Recipe | null = null;
  try {
    // ONLY the durable write is guarded here. Rendering used to sit inside
    // this try, so a render error reported as a save failure even though the
    // reel was safely on disk — the most misleading message the app can show.
    const outcome = await saveReelUrl(value);
    if (outcome.kind === 'duplicate') {
      notice = { tone: 'duplicate', text: 'Already in your library.' };
    } else {
      notice = { tone: 'info', text: 'Saved.' };
      saved = outcome.recipe;
    }
  } catch (err) {
    notice = { tone: 'error', text: saveErrorMessage(err) };
    // Keep the real error inspectable — debugging a silent failure months
    // later from memory is not viable (NFR-6.3).
    console.error('[save failed]', err);
  } finally {
    saving = false;
  }

  if (!saved) return;

  // FR-1.5 — the row is durable now, so show it NOW. Extraction can take 20s+
  // and must never gate the first paint.
  recipes = [saved, ...recipes];
  await render();

  // Extraction runs in the background. Deliberately not awaited.
  void extractRecipe(saved.id, undefined, () => void refresh()).then(() => refresh());
}

async function onSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  if (saving) return;

  const input = document.querySelector<HTMLInputElement>('#url-input')!;
  const value = input.value;
  if (!value.trim()) return;

  // Clear the field before saving: saveUrl() renders as soon as the row is
  // durable, and render() carries the live field value forward — so clearing
  // afterwards would be undone by that first paint.
  input.value = '';

  await saveUrl(value);

  if (notice?.tone === 'info') {
    // The clipboard prompt is earned by a successful manual paste — this is
    // the moment its value is self-evident (FR-1.2).
    markManualPasteDone();
    // Close the sheet so the saved recipe is visible immediately.
    sheetOpen = false;
    await render();
  } else {
    // Rejected or duplicate: put the text back so it can be corrected.
    const el = app.querySelector<HTMLInputElement>('#url-input');
    if (el) el.value = value;
    await render();
  }
  document.querySelector<HTMLInputElement>('#url-input')?.focus();
}

async function acceptClipboardOffer(): Promise<void> {
  const url = clipboardOffer;
  clipboardOffer = null;
  if (!url) return;
  await saveUrl(url);
  await refresh();
}

/** On focus, offer a reel found on the clipboard — never save it silently. */
async function pollClipboard(): Promise<void> {
  if (document.visibilityState !== 'visible') return;
  if (currentRoute().name !== 'library') return;
  const found = await checkClipboardForReel();
  if (!found) return;
  // Don't offer something already saved.
  if (recipes.some((r) => r.sourceUrl === found)) return;
  clipboardOffer = found;
  await render();
}

onRouteChange(() => void render());
document.addEventListener('visibilitychange', () => void pollClipboard());

/**
 * Android share target (FR-1.3). The manifest points the share sheet at "/"
 * with the shared URL as a query param, so a share arrives as a normal page
 * load carrying ?url= or ?text=.
 */
async function handleShareTarget(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // Instagram's share sheet does not use a single consistent field: Android
  // puts the link in `text` alongside a caption, iOS Shortcuts sends `url`,
  // and some launchers use `title`. Check all three.
  const shared = [params.get('url'), params.get('text'), params.get('title')]
    .filter(Boolean)
    .join(' ');
  if (!shared.trim()) return;

  // Clear it from the address bar first, so a reload cannot save twice.
  history.replaceState(null, '', location.pathname + location.hash);

  const match = shared.match(/https?:\/\/\S*instagram\.com\/\S+/i);
  if (!match) {
    // A share that produced nothing usable must say so, not vanish silently.
    notice = {
      tone: 'error',
      text: "That share didn't contain an Instagram link.",
    };
    await render();
    return;
  }

  // Land on the library, not home: a share should show what it just saved,
  // not bury it one level down inside "All recipes".
  if (currentRoute().name === 'home') location.hash = '#/all';
  await saveUrl(match[0]);
  await refresh();
}

registerServiceWorker();

void refresh().then(async () => {
  await handleShareTarget();
  await processQueue(undefined, () => void refresh());
  await refresh();
});
