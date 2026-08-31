/*
 * Service worker — PRD NFR-3.2, "the full library is readable offline".
 *
 * Two caches with different rules, because the two kinds of content have
 * different failure costs:
 *
 *   APP SHELL   Cache-first, updated in the background. The app must open
 *               instantly in a kitchen with no signal.
 *   THUMBNAILS  Cache-first with no revalidation. Instagram CDN URLs are
 *               signed and expire, so a cached copy is often the ONLY copy —
 *               re-fetching an expired URL would replace a working image with
 *               a 403.
 *
 * Recipe data is not cached here at all: it lives in IndexedDB, which is
 * already local and already offline.
 */

const VERSION = 'v2';
const SHELL_CACHE = `reel-recipes-shell-${VERSION}`;
const IMAGE_CACHE = `reel-recipes-images-${VERSION}`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

/**
 * Find the hashed JS/CSS bundles by reading index.html.
 *
 * These MUST be cached at install time. The worker activates after the page
 * has already loaded its assets, so its fetch handler never sees them — a
 * first visit followed by going offline would otherwise render a blank page.
 */
async function precacheAssets(cache) {
  try {
    const res = await fetch('/index.html', { cache: 'reload' });
    if (!res.ok) return;
    const html = await res.text();
    const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await Promise.allSettled(urls.map((u) => cache.add(u)));
  } catch {
    // A failed precache degrades offline support; it must not fail install.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        // addAll rejects the whole batch if one URL 404s; individual puts do not.
        await Promise.allSettled(SHELL_URLS.map((u) => cache.add(u)));
        await precacheAssets(cache);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('reel-recipes-') && !k.endsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Instagram thumbnails, which we want to survive their URL expiring. */
function isThumbnail(url) {
  return /cdninstagram\.com|fbcdn\.net/.test(url.hostname);
}

/** The extraction Worker — never cached; a stale extraction is worse than none. */
function isWorkerApi(url) {
  return url.pathname === '/extract' || url.pathname === '/metadata' || url.pathname === '/health';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isWorkerApi(url)) return; // straight to the network, always

  // --- Thumbnails: cache-first, and keep what we have ---
  if (isThumbnail(url)) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          // Opaque responses (no-cors) are cacheable and still render.
          if (res.ok || res.type === 'opaque') await cache.put(request, res.clone());
          return res;
        } catch {
          // Offline with nothing cached: let the <img> onerror fallback run.
          return Response.error();
        }
      }),
    );
    return;
  }

  // --- Navigations: serve the shell so the app opens offline ---
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          void caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('/index.html')) ??
            (await cache.match('/')) ??
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }),
    );
    return;
  }

  // --- Everything else (JS, CSS, fonts): cache-first, refresh in background ---
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) {
        // Revalidate without blocking the response.
        void fetch(request)
          .then((res) => {
            if (res.ok) void cache.put(request, res);
          })
          .catch(() => {});
        return hit;
      }
      try {
        const res = await fetch(request);
        if (res.ok) await cache.put(request, res.clone());
        return res;
      } catch {
        return Response.error();
      }
    }),
  );
});
