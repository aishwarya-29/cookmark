/**
 * Clipboard detection — PRD FR-1.2.
 *
 * The real capture flow is: see reel → Instagram's share → Copy Link → switch
 * to this app. If the app is already holding the link when the user arrives,
 * that collapses to one tap.
 *
 * Three constraints from the PRD, all of which shape this file:
 *   - Ask for permission only after the user has pasted manually once, where
 *     the value is self-evident — never on first launch.
 *   - Never save silently. Always show what was found and let the user confirm.
 *   - If permission is denied, manual paste keeps working with no nagging.
 */

import { tryCanonicaliseInstagramUrl } from './url';

/* DO NOT RENAME — see the note in db.ts. Renaming would re-prompt for
   clipboard access the user has already declined. */
const ASKED_KEY = 'reel-recipes:clipboard-asked';
const EARNED_KEY = 'reel-recipes:manual-paste-done';
const DECLINED_KEY = 'reel-recipes:clipboard-declined';

function flag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function setFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* private browsing — feature simply stays off */
  }
}

/** Call after the user's first successful manual paste. */
export function markManualPasteDone(): void {
  setFlag(EARNED_KEY);
}

/** The user dismissed the offer — stop asking (no nag prompts). */
export function markClipboardDeclined(): void {
  setFlag(DECLINED_KEY);
}

export function hasEarnedClipboardPrompt(): boolean {
  return flag(EARNED_KEY) && !flag(DECLINED_KEY);
}

/**
 * Read the clipboard and return an Instagram URL if it holds one.
 *
 * Returns null for every failure mode — permission denied, unsupported,
 * insecure context, or simply nothing relevant on the clipboard. The caller
 * cannot distinguish these, and shouldn't: all of them mean "carry on".
 */
export async function checkClipboardForReel(): Promise<string | null> {
  if (!hasEarnedClipboardPrompt()) return null;
  if (!navigator.clipboard?.readText) return null;

  setFlag(ASKED_KEY);
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return null;
    const parsed = tryCanonicaliseInstagramUrl(text.trim());
    return parsed ? text.trim() : null;
  } catch {
    // Denied or blocked. Manual paste remains fully functional.
    return null;
  }
}
