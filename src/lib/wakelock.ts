/**
 * Screen Wake Lock — PRD FR-4.2. The screen must not sleep mid-recipe.
 *
 * Two things make this harder than the API suggests:
 *   1. The lock is released automatically whenever the tab is hidden, so it
 *      must be reacquired on visibilitychange or it silently stops working
 *      after the first app switch.
 *   2. Safari only grants it in a secure context, and older iOS lacks it
 *      entirely. Absence must degrade quietly, not throw.
 */

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', fn: () => void) => void;
};

let sentinel: WakeLockSentinelLike | null = null;
let wanted = false;

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

async function acquire(): Promise<void> {
  if (!wanted || !supported() || sentinel) return;
  try {
    const nav = navigator as Navigator & {
      wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    };
    sentinel = await nav.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Denied, unsupported, or the document wasn't visible. Cook mode still
    // works — the screen just sleeps as normal.
    sentinel = null;
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void acquire();
}

/** Ask the screen to stay awake. Safe to call repeatedly. */
export async function requestWakeLock(): Promise<void> {
  wanted = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  await acquire();
}

/** Stop holding the screen awake. Safe to call when never acquired. */
export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  const s = sentinel;
  sentinel = null;
  try {
    if (s && !s.released) await s.release();
  } catch {
    /* already gone */
  }
}

/** For the UI to tell the user honestly whether the screen will stay on. */
export function wakeLockStatus(): 'held' | 'unsupported' | 'off' {
  if (!supported()) return 'unsupported';
  return sentinel ? 'held' : 'off';
}
