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

/**
 * App shell: owns routing, the paste bar, and the single render entry point.
 * Views live in ./ui/* and are pure render functions given a recipe.
 */

type Notice = { tone: 'info' | 'duplicate' | 'error'; text: string } | null;

const app = document.querySelector<HTMLDivElement>('#app')!;

let recipes: Recipe[] = [];
let notice: Notice = null;
let saving = false;
/** A reel found on the clipboard, awaiting the user's confirmation (FR-1.2). */
let clipboardOffer: string | null = null;
/** True while cook mode holds the screen, so we can tear it down on route change. */
let cooking = false;

function libraryShellHtml(): string {
  const noticeHtml = notice
    ? `<div class="notice ${notice.tone}">${escapeHtml(notice.text)}</div>`
    : '';

  // Never save silently — always show what was found and let the user confirm.
  const offerHtml = clipboardOffer
    ? `<div class="notice offer">
         <p class="small">Found a reel link on your clipboard:</p>
         <p class="offer-url">${escapeHtml(clipboardOffer)}</p>
         <div class="action-row">
           <button data-action="accept-clip">Save it</button>
           <button class="subtle" data-action="dismiss-clip">Not now</button>
         </div>
       </div>`
    : '';

  return `
    <h1>Reel Recipes</h1>
    <p class="subtitle">Paste a link. It's saved before anything else happens.</p>

    <!--
      type="text", not type="url": native URL validation silently blocks submit
      on input we handle better ourselves, and replaces our wording with a
      browser tooltip we don't control.
    -->
    <form class="paste-form" id="paste-form" novalidate>
      <input id="url-input" type="text" inputmode="url" autocomplete="off"
             autocapitalize="off" spellcheck="false"
             placeholder="https://instagram.com/reel/…"
             aria-label="Instagram reel link" />
      <button type="submit" ${saving ? 'disabled' : ''}>Save</button>
    </form>

    ${offerHtml}
    ${noticeHtml}

    <div class="library-head">
      <p class="section-label">Library — ${recipes.length} saved</p>
      <button class="subtle" data-action="new-manual">+ Write one</button>
    </div>
    ${libraryHtml(recipes)}
  `;
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
    // Preserve what the user is typing across background refreshes.
    const prev = app.querySelector<HTMLInputElement>('#url-input');
    const preserved = prev
      ? { value: prev.value, focused: document.activeElement === prev, pos: prev.selectionStart }
      : null;

    app.innerHTML = libraryShellHtml();

    if (preserved) {
      const next = app.querySelector<HTMLInputElement>('#url-input')!;
      next.value = preserved.value;
      if (preserved.focused) {
        next.focus();
        try {
          next.setSelectionRange(preserved.pos ?? 0, preserved.pos ?? 0);
        } catch {
          /* not selectable */
        }
      }
    }

    app.querySelector<HTMLFormElement>('#paste-form')!.addEventListener('submit', onSubmit);
    onClick(app, '[data-action="accept-clip"]', () => void acceptClipboardOffer());
    onClick(app, '[data-action="dismiss-clip"]', () => {
      clipboardOffer = null;
      markClipboardDeclined();
      void render();
    });
    onClick(app, '[data-action="new-manual"]', async () => {
      const r = await createManualRecipe('Untitled recipe');
      await refresh();
      navigate(`#/edit/${r.id}`);
    });
    return;
  }

  // Detail, edit, and cook all need a loaded recipe.
  const r = await getRecipe(route.id);
  if (!r) {
    app.innerHTML = `
      <p><a href="#/" class="back">← Library</a></p>
      <div class="empty">That recipe is no longer here.</div>`;
    return;
  }

  if (route.name === 'recipe') {
    renderRecipe(app, r, () => void refresh());
  } else if (route.name === 'edit') {
    renderEdit(app, r, () => void refresh());
  } else {
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

async function saveUrl(value: string): Promise<void> {
  notice = null;
  saving = true;
  try {
    const outcome = await saveReelUrl(value);
    if (outcome.kind === 'duplicate') {
      notice = {
        tone: 'duplicate',
        text: 'Already in your library.',
      };
    } else {
      notice = { tone: 'info', text: 'Saved.' };
      // FR-1.5 — optimistic. The row is durable; extraction runs in background.
      void extractRecipe(outcome.recipe.id, undefined, () => void refresh()).then(() =>
        refresh(),
      );
    }
  } catch (err) {
    notice = {
      tone: 'error',
      text:
        err instanceof InvalidInstagramUrlError
          ? err.message
          : "Couldn't save that just now. The link is unchanged — try again.",
    };
  } finally {
    saving = false;
  }
}

async function onSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  if (saving) return;

  const input = app.querySelector<HTMLInputElement>('#url-input')!;
  const value = input.value;
  if (!value.trim()) return;

  await saveUrl(value);
  // Clear before any refresh, so value preservation carries the cleared field
  // forward rather than restoring what we just saved.
  if (notice?.tone === 'info') {
    input.value = '';
    // The clipboard prompt is earned by a successful manual paste — this is
    // the moment its value is self-evident (FR-1.2).
    markManualPasteDone();
  }
  await refresh();
  app.querySelector<HTMLInputElement>('#url-input')?.focus();
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
