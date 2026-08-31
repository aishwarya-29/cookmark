/**
 * Hash router. Deliberately tiny — this app has four routes and hand-rolling
 * this is less maintenance than a dependency (NFR-6.1).
 *
 * Hash-based, not History API, so the app works when served from any static
 * path with no server rewrite rules.
 */

export type Route =
  /** Home: the grid of collection folders. */
  | { name: 'home' }
  /**
   * All recipes, the contents of one collection, or the recipes that are in
   * no collection at all.
   */
  | { name: 'library'; collectionId?: string; unfiled?: boolean }
  | { name: 'recipe'; id: string }
  | { name: 'cook'; id: string }
  | { name: 'edit'; id: string }
  | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, id] = path.split('/');

  if (head === 'recipe' && id) return { name: 'recipe', id };
  if (head === 'cook' && id) return { name: 'cook', id };
  if (head === 'edit' && id) return { name: 'edit', id };
  if (head === 'settings') return { name: 'settings' };
  if (head === 'all') return { name: 'library' };
  if (head === 'unfiled') return { name: 'library', unfiled: true };
  if (head === 'collection' && id) return { name: 'library', collectionId: id };
  return { name: 'home' };
}

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

/**
 * Depth within this app's own history, so Back knows whether it can go back.
 *
 * Tracked on the history entry itself rather than in a variable: a variable
 * cannot tell a forward navigation from a backward one (both fire hashchange),
 * and it is lost on reload. Reading it back from history.state survives both.
 */
function currentDepth(): number {
  const st = history.state as { depth?: number } | null;
  return typeof st?.depth === 'number' ? st.depth : 0;
}

/** Stamp the depth on whatever entry we just created. */
function stampDepth(depth: number): void {
  history.replaceState({ ...(history.state ?? {}), depth }, '');
}

export function navigate(to: string): void {
  const next = currentDepth() + 1;
  location.hash = to;
  // The hash change creates the entry; stamp it once it exists.
  stampDepth(next);
}

/**
 * Navigate without leaving a history entry behind.
 *
 * For screens the user finishes rather than passes through — saving an edit,
 * deleting, leaving cook mode. Using navigate() there pushes a new entry, so
 * Back returns to the screen they just completed: save an edit and Back takes
 * you straight into the editor again.
 */
export function navigateReplacing(to: string): void {
  const depth = currentDepth();
  history.replaceState({ depth }, '', location.pathname + location.search + to);
  // replaceState fires no hashchange, so the router has to be told directly.
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/**
 * Go back one step, or to the fallback when this is the app's first screen.
 *
 * Uses the depth stamped on the history entry rather than `history.length`,
 * which counts entries from before the app was even opened.
 */
export function goBack(fallback = '#/'): void {
  if (currentDepth() > 0) history.back();
  else navigateReplacing(fallback);
}

/**
 * Plain <a href="#/..."> links — library cards, folder tiles — change the hash
 * without going through navigate(), so their entries carry no depth. Stamp
 * them as one deeper than wherever we were.
 */
let lastDepth = 0;
// Guarded: parseRoute is pure and unit-tested in Node, where there is no
// window. The router must not require a DOM merely to be imported.
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
  const st = history.state as { depth?: number } | null;
    if (typeof st?.depth === 'number') {
      lastDepth = st.depth;
    } else {
      lastDepth += 1;
      stampDepth(lastDepth);
    }
  });
}

export function onRouteChange(fn: () => void): void {
  window.addEventListener('hashchange', fn);
}
