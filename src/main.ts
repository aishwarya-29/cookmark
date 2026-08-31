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
import { headerHtml, tabBarHtml, pasteSheetHtml } from './ui/chrome';

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

function libraryShellHtml(): string {
  const noticeHtml = notice
    ? `<div class="notice ${notice.tone}">${escapeHtml(notice.text)}</div>`
    : '';

  // Ingredient match replaces the normal list when active — a different
  // question deserves a different answer shape.
  const matching = search.cookWith.trim().length > 0;
  const visible = applyFilters(recipes, search);
  const listHtml = matching
    ? matchResultsHtml(ingredientMatches(recipes, search))
    : libraryHtml(visible);

  const countLabel = isSearchActive(search)
    ? matching
      ? 'What you can cook'
      : `${visible.length} of ${recipes.length}`
    : `${recipes.length} saved`;

  return `
    ${noticeHtml}
    ${searchPanelHtml(recipes, search)}

    <div class="library-head">
      <p class="section-label">${escapeHtml(countLabel)}</p>
    </div>
    ${listHtml}
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

  const back = route.name === 'library' ? undefined : '#/';
  chromeTop.innerHTML = headerHtml(title, back ? { back } : {});
  chromeBottom.innerHTML = route.name === 'library' ? tabBarHtml('library') : '';
  sheetRoot.innerHTML = route.name === 'library' ? pasteSheetHtml(sheetOpen, clipboardOffer) : '';

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

  if (route.name === 'library') {
    // Preserve what the user is typing across background refreshes — for every
    // text field on screen, including those in the sheet.
    const FIELDS = ['#url-input', '#search-text', '#cook-with'];
    const preserved = FIELDS.map((sel) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      return el
        ? { sel, value: el.value, focused: document.activeElement === el, pos: el.selectionStart }
        : null;
    });

    renderChrome(route, 'Reel Recipes');
    app.innerHTML = libraryShellHtml();
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
    renderRecipe(app, r, () => void refresh(), allTags(recipes).map((t) => t.tag));
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

async function refresh(): Promise<void> {
  recipes = await listRecipes();
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

void refresh().then(async () => {
  await processQueue(undefined, () => void refresh());
  await refresh();
});
