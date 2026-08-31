/**
 * Tier toggles — PRD FR-2.7.
 *
 * Each extraction tier can be disabled independently, without a deploy, so a
 * broken tier is a config change rather than an emergency. Persisted in
 * localStorage (not IndexedDB) so it stays readable synchronously at startup
 * and survives a database wipe.
 *
 * Tier 3 is deliberately absent: it has no external dependency, cannot fail,
 * and therefore has nothing to disable. It is the floor.
 */

/** DO NOT RENAME — see the note in db.ts. Renaming resets the user's tiers. */
const STORAGE_KEY = 'reel-recipes:tiers';

export interface TierConfig {
  /** Tier 1 — caption extraction. Built in Step 4. */
  caption: boolean;
  /** Tier 2 — audio transcription. Built in Step 5. */
  audio: boolean;
}

const DEFAULTS: TierConfig = {
  caption: true,
  audio: true,
};

export function getTierConfig(): TierConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<TierConfig>;
    return {
      caption: parsed.caption ?? DEFAULTS.caption,
      audio: parsed.audio ?? DEFAULTS.audio,
    };
  } catch {
    // Corrupt or unavailable storage must never break startup.
    return { ...DEFAULTS };
  }
}

export function setTierEnabled(tier: keyof TierConfig, enabled: boolean): void {
  const next = { ...getTierConfig(), [tier]: enabled };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-browsing quota errors are not worth failing over.
  }
}

/**
 * Base URL of the extraction Worker. Empty means "no Worker configured", which
 * is a supported state: everything lands in Tier 3 and the app works as a link
 * organiser. Set VITE_WORKER_URL at build time to enable Tiers 1 and 2.
 */
export const WORKER_URL: string = import.meta.env['VITE_WORKER_URL'] ?? '';
