import { onClick } from './dom';
import {
  exportJson,
  exportMarkdown,
  importJson,
  wipeEverything,
  InvalidBackupError,
} from '../data/backup';
import { getTierConfig, setTierEnabled, WORKER_URL } from '../lib/config';

/**
 * Settings — export, import, and the extraction tier toggles.
 *
 * Export is deliberately the first thing on this screen: "the user's data is
 * theirs... export must never be degraded, delayed, or used as leverage"
 * (FR-5.4). No account, no gating, one tap.
 */

function download(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download on some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function settingsHtml(recipeCount: number): string {
  const tiers = getTierConfig();

  return `
    <h2>Your data</h2>
    <p class="dim small settings-note">
      ${recipeCount} ${recipeCount === 1 ? 'recipe' : 'recipes'} on this device.
      Everything lives here, not on a server — so keep a backup.
    </p>
    <div class="action-row">
      <button data-action="export-json">Export backup</button>
      <button class="subtle" data-action="export-md">Export as text</button>
    </div>

    <h2>Restore</h2>
    <p class="dim small settings-note">
      Adds recipes from a backup file. Anything already here is kept as it is —
      import never overwrites.
    </p>
    <input type="file" id="import-file" accept="application/json,.json" hidden />
    <div class="action-row">
      <button class="subtle" data-action="import">Choose a backup file</button>
    </div>

    <h2>Extraction</h2>
    <p class="dim small settings-note">
      ${
        WORKER_URL
          ? 'Turn a tier off if it starts failing — saving always works regardless.'
          : 'No extraction service is configured, so everything saves as a link.'
      }
    </p>
    <label class="switch">
      <input type="checkbox" data-tier="caption" ${tiers.caption ? 'checked' : ''} />
      <span>Read the caption</span>
    </label>
    <label class="switch">
      <input type="checkbox" data-tier="audio" ${tiers.audio ? 'checked' : ''} />
      <span>Listen to the audio <span class="dim small">(not built yet)</span></span>
    </label>

    <h2>Danger zone</h2>
    <div class="action-row">
      <button class="subtle danger" data-action="wipe">Delete everything</button>
    </div>
  `;
}

export function bindSettings(root: ParentNode, onChange: () => void): void {
  onClick(root, '[data-action="export-json"]', async () => {
    const backup = await exportJson();
    download(
      `reel-recipes-${stamp()}.json`,
      JSON.stringify(backup, null, 2),
      'application/json',
    );
  });

  onClick(root, '[data-action="export-md"]', async () => {
    download(`reel-recipes-${stamp()}.md`, await exportMarkdown(), 'text/markdown');
  });

  const fileInput = root.querySelector<HTMLInputElement>('#import-file');
  onClick(root, '[data-action="import"]', () => fileInput?.click());

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const result = await importJson(await file.text());
      alert(
        `Added ${result.added} ${result.added === 1 ? 'recipe' : 'recipes'}` +
          (result.collectionsAdded
            ? `, ${result.collectionsAdded} ${result.collectionsAdded === 1 ? 'collection' : 'collections'}`
            : '') +
          (result.skipped ? `. ${result.skipped} already here, left alone.` : '.'),
      );
      onChange();
    } catch (err) {
      alert(
        err instanceof InvalidBackupError
          ? err.message
          : `Couldn't read that file: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Allow re-picking the same file.
      fileInput.value = '';
    }
  });

  root.querySelectorAll<HTMLInputElement>('[data-tier]').forEach((el) => {
    el.addEventListener('change', () => {
      setTierEnabled(el.dataset['tier'] as 'caption' | 'audio', el.checked);
    });
  });

  onClick(root, '[data-action="wipe"]', async () => {
    // Two confirmations, because this is unrecoverable without a backup.
    if (!confirm('Delete every recipe and collection on this device?')) return;
    if (!confirm('This cannot be undone. Have you exported a backup?')) return;
    await wipeEverything();
    onChange();
  });
}

/**
 * Register the service worker (NFR-3.2).
 *
 * Requires a secure context, so this quietly does nothing over LAN HTTP —
 * which is exactly the dev setup, and must not throw there.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  // Vite serves no service worker in dev; registering would 404.
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is an enhancement — never break startup over it.
    });
  });
}
