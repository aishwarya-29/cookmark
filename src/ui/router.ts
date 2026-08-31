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
  /** All recipes, or the contents of one collection. */
  | { name: 'library'; collectionId?: string }
  | { name: 'recipe'; id: string }
  | { name: 'cook'; id: string }
  | { name: 'edit'; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, id] = path.split('/');

  if (head === 'recipe' && id) return { name: 'recipe', id };
  if (head === 'cook' && id) return { name: 'cook', id };
  if (head === 'edit' && id) return { name: 'edit', id };
  if (head === 'all') return { name: 'library' };
  if (head === 'collection' && id) return { name: 'library', collectionId: id };
  return { name: 'home' };
}

export function currentRoute(): Route {
  return parseRoute(location.hash);
}

export function navigate(to: string): void {
  location.hash = to;
}

/** Back to the library without growing the history stack unboundedly. */
export function goBack(fallback = '#/'): void {
  if (history.length > 1) history.back();
  else location.hash = fallback;
}

export function onRouteChange(fn: () => void): void {
  window.addEventListener('hashchange', fn);
}
