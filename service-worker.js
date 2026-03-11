/**
 * 10-4 Timer — Service Worker
 *
 * Handles offline caching for the PWA shell.
 *
 * NOTE ON BACKGROUND AUDIO:
 * Full background audio (playing sounds when the browser tab is hidden or the
 * screen is locked) is heavily restricted on mobile browsers for battery and
 * privacy reasons.  iOS Safari will suspend JS timers and Web Audio when the
 * tab is backgrounded; Android Chrome behaves similarly.
 * What this service worker CAN do:
 *   • Cache all app assets so the app works completely offline.
 *   • Receive push notifications from a server (requires a push subscription,
 *     not implemented here).
 * To get the best experience on mobile, keep the browser tab visible and the
 * screen awake (the app uses the Screen Wake Lock API for this).
 */

const CACHE_NAME = '10-4-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  // Google Fonts are fetched at runtime; cache them on first access via the
  // fetch handler below so subsequent loads work offline.
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  // Activate immediately rather than waiting for existing clients to close.
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  // Take control of all open clients immediately.
  self.clients.claim();
});

// ── Fetch — network-first for API calls, cache-first for assets ───────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET requests (POST to sync endpoint, etc.) must go directly to the
  // network.  We do NOT call event.respondWith() here so the browser handles
  // them normally — calling respondWith with fetch(request) would cause the
  // service worker to interfere with CORS preflight requests.
  if (request.method !== 'GET') return;

  // For Google Fonts CDN assets, use stale-while-revalidate.
  // Use exact hostname matching to avoid URL sanitization bypass.
  const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // For same-origin navigation/assets, prefer cache then network.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback — return the cached index for navigations.
    const fallback = await caches.match('/index.html');
    return fallback || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      caches.open(CACHE_NAME).then((c) => c.put(request, response.clone()));
    }
    return response;
  });
  return cached || fetchPromise;
}
