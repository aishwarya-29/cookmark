/** Shared view helpers. */

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Bind a click handler to every element matching a selector within root. */
export function onClick(
  root: ParentNode,
  selector: string,
  fn: (el: HTMLElement, ev: MouseEvent) => void,
): void {
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    el.addEventListener('click', (ev) => fn(el, ev as MouseEvent));
  });
}
