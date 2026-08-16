import type { Recipe } from '../data/types';
import { isManual } from '../data/recipes';
import { escapeHtml, formatDate } from './dom';

/**
 * Library list (FR-3.1).
 *
 * Design test from the PRD: this view must be good, not merely functional,
 * when 100% of entries are Tier 3 link-only saves. That is a real scenario
 * whenever Instagram access breaks.
 */

/**
 * Status wording. A link-only save is a valid outcome and must read as
 * "saved, add details whenever" — never as a failure, and never red.
 * A failure must never be phrased as the user's mistake.
 */
export function statusBadge(r: Recipe): string {
  if (r.extractionState === 'queued') return '<span class="badge">waiting</span>';

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

  const hasIngredients = (r.ingredients?.length ?? 0) > 0;
  const hasSteps = (r.steps?.length ?? 0) > 0;
  if (hasIngredients && !hasSteps) {
    return '<span class="badge">missing the method</span>';
  }

  switch (r.extractionMethod) {
    case 'link_only':
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
  // Attribution is permanent and always visible (NFR-4.2), including here.
  const attribution = isManual(r)
    ? '<span class="dim">your own recipe</span>'
    : r.creatorHandle
      ? `<a href="https://www.instagram.com/${encodeURIComponent(r.creatorHandle)}/"
           target="_blank" rel="noopener noreferrer"
           >@${escapeHtml(r.creatorHandle)}</a>`
      : '<span class="dim">creator unknown</span>';

  const counts: string[] = [];
  if (r.ingredients?.length) counts.push(`${r.ingredients.length} ingredients`);
  if (r.steps?.length) counts.push(`${r.steps.length} steps`);

  return `
    <li class="card">
      <a class="card-link" href="#/recipe/${r.id}">
        <p class="card-title">${escapeHtml(r.title)}</p>
      </a>
      <div class="card-meta">
        ${attribution}
        <span>·</span>
        <span>${formatDate(r.savedAt)}</span>
        ${statusBadge(r)}
        ${r.unresolvedShareLink ? '<span class="badge">share link — resolves later</span>' : ''}
      </div>
      ${counts.length ? `<p class="dim small">${counts.join(' · ')}</p>` : ''}
      ${
        isManual(r)
          ? ''
          : `<div class="card-meta">
               <a href="${escapeHtml(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">
                 open original reel
               </a>
             </div>`
      }
    </li>`;
}

export function libraryHtml(recipes: Recipe[]): string {
  if (!recipes.length) {
    // First run — the most important screen in the app. One sentence, no
    // tutorial (PRD §11 Q5).
    return `
      <div class="empty">
        <p><strong>Nothing saved yet.</strong></p>
        <p>Copy a reel link in Instagram, then paste it above.</p>
      </div>`;
  }
  return `<ul class="card-list">${recipes.map(cardHtml).join('')}</ul>`;
}
