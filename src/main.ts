import { saveReelUrl, listRecipes, deleteRecipe } from './data/recipes';
import type { Recipe } from './data/types';
import { InvalidInstagramUrlError } from './lib/url';
import { extractRecipe, processQueue } from './lib/extract';

/**
 * Step 1 UI — the paste path and a bare list, enough to prove persistence.
 * Step 3 replaces this with the real library, detail view, and cook mode.
 */

type Notice =
  | { tone: 'info' | 'duplicate' | 'error'; text: string }
  | null;

const app = document.querySelector<HTMLDivElement>('#app')!;

let recipes: Recipe[] = [];
let notice: Notice = null;
/** Set while a save is in flight, to prevent a double-submit creating two rows. */
let saving = false;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The status badge. Wording matters more than styling here — a link-only save
 * is a valid outcome and must not read as a failure or an apology (PRD §07,
 * §11 Q2), and a failure must never be phrased as the user's mistake.
 */
function statusBadge(r: Recipe): string {
  if (r.extractionState === 'queued') {
    return '<span class="badge">waiting</span>';
  }
  if (r.extractionState === 'running') {
    const what =
      r.activeTier === 2
        ? 'listening to the audio — can take a couple of minutes'
        : r.activeTier === 1
          ? 'reading the caption'
          : 'saving details';
    return `<span class="badge working">${what}</span>`;
  }
  if (r.extractionState === 'failed_retryable') {
    return '<span class="badge">couldn\'t reach Instagram — will retry</span>';
  }
  if (r.extractionState === 'failed_permanent') {
    return '<span class="badge">this post is private or deleted</span>';
  }
  // Settled outcomes.
  switch (r.extractionMethod) {
    case 'link_only':
      // Deliberately neutral: "saved, add details whenever".
      return '<span class="badge">link saved — add details whenever</span>';
    case 'caption':
      return '<span class="badge good">recipe from caption</span>';
    case 'audio':
      return '<span class="badge good">recipe from audio</span>';
    case 'audio_translated':
      return `<span class="badge good">translated${
        r.sourceLanguage ? ` from ${escapeHtml(r.sourceLanguage)}` : ''
      }</span>`;
    case 'manual':
      return '<span class="badge good">added by you</span>';
    default:
      return '<span class="badge">saved</span>';
  }
}

function cardHtml(r: Recipe): string {
  // Attribution is permanent and always visible, including on link-only
  // entries (NFR-4.2).
  const handle = r.creatorHandle
    ? `<a href="https://www.instagram.com/${encodeURIComponent(r.creatorHandle)}/"
         target="_blank" rel="noopener noreferrer">@${escapeHtml(r.creatorHandle)}</a>`
    : '<span style="color:var(--text-faint)">creator unknown</span>';

  const shareFlag = r.unresolvedShareLink
    ? '<span class="badge">share link — resolves later</span>'
    : '';

  return `
    <li class="card">
      <p class="card-title">${escapeHtml(r.title)}</p>
      <div class="card-meta">
        ${handle}
        <span>·</span>
        <span>${formatDate(r.savedAt)}</span>
        ${statusBadge(r)}
        ${shareFlag}
      </div>
      <div class="card-meta" style="margin-top:6px">
        <a href="${escapeHtml(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">
          open original reel
        </a>
      </div>
      <div class="card-actions">
        <button class="subtle" data-delete="${r.id}">Delete</button>
      </div>
    </li>`;
}

function render(): void {
  // A background refresh must never eat what the user is typing. Preserve the
  // field's value, focus, and caret across the innerHTML rebuild.
  const prev = document.querySelector<HTMLInputElement>('#url-input');
  const preserved = prev
    ? {
        value: prev.value,
        focused: document.activeElement === prev,
        start: prev.selectionStart,
        end: prev.selectionEnd,
      }
    : null;

  const noticeHtml = notice
    ? `<div class="notice ${notice.tone}">${escapeHtml(notice.text)}</div>`
    : '';

  const listHtml = recipes.length
    ? `<ul class="card-list">${recipes.map(cardHtml).join('')}</ul>`
    : `<div class="empty">
         Nothing saved yet.<br />
         Copy a reel link from Instagram and paste it above.
       </div>`;

  app.innerHTML = `
    <h1>Reel Recipes</h1>
    <p class="subtitle">Paste a link. It's saved before anything else happens.</p>

    <!--
      type="text", not type="url", deliberately: native URL validation silently
      blocks submit on input we can handle better ourselves (a bare
      "instagram.com/reel/x" is valid to us), and it replaces our wording with a
      browser tooltip we don't control.
    -->
    <form class="paste-form" id="paste-form" novalidate>
      <input
        id="url-input"
        type="text"
        inputmode="url"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="https://instagram.com/reel/…"
        aria-label="Instagram reel link"
      />
      <button type="submit" ${saving ? 'disabled' : ''}>Save</button>
    </form>

    ${noticeHtml}

    <p class="section-label">Library — ${recipes.length} saved</p>
    ${listHtml}
  `;

  if (preserved) {
    const next = document.querySelector<HTMLInputElement>('#url-input')!;
    next.value = preserved.value;
    if (preserved.focused) {
      next.focus();
      // setSelectionRange is only valid on text-type inputs.
      try {
        next.setSelectionRange(preserved.start ?? 0, preserved.end ?? 0);
      } catch {
        /* not selectable — harmless */
      }
    }
  }

  const form = document.querySelector<HTMLFormElement>('#paste-form')!;
  form.addEventListener('submit', onSubmit);

  app.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => onDelete(btn.dataset.delete!));
  });
}

async function refresh(): Promise<void> {
  recipes = await listRecipes();
  render();
}

async function onSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  if (saving) return;

  const input = document.querySelector<HTMLInputElement>('#url-input')!;
  const value = input.value;
  if (!value.trim()) return;

  // Clear any previous notice up front — a stale message left on screen reads
  // as the response to this action.
  notice = null;
  saving = true;
  try {
    const outcome = await saveReelUrl(value);

    if (outcome.kind === 'duplicate') {
      // FR-2.2 — reassure, don't scold.
      notice = {
        tone: 'duplicate',
        text: `Already in your library — saved ${formatDate(outcome.existing.savedAt)}.`,
      };
    } else {
      notice = { tone: 'info', text: 'Saved.' };
      // Clear the live input BEFORE any refresh, so render()'s value
      // preservation carries the cleared value forward rather than restoring
      // the URL we just saved.
      input.value = '';

      // FR-1.5 — optimistic save. The row is already durable; extraction runs
      // in the background and the user carries on. Deliberately not awaited.
      void extractRecipe(outcome.recipe.id, undefined, () => void refresh()).then(refresh);
    }
  } catch (err) {
    // Never phrase a rejection as the user's mistake.
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

  await refresh();

  // Keep focus in the field for a quick second paste.
  document.querySelector<HTMLInputElement>('#url-input')?.focus();
}

async function onDelete(id: string): Promise<void> {
  await deleteRecipe(id);
  notice = null;
  await refresh();
}

// Render what's on disk first, then settle anything left queued from a previous
// session (FR-1.6). Order matters: the library must be readable before any
// background work starts.
void refresh().then(async () => {
  await processQueue(undefined, () => void refresh());
  await refresh();
});
