/* Offline, and fast to open.
 *
 * The app is five small files and never changes between releases, so they
 * are cached on install and served from the cache first. That is what makes
 * "Add to Home Screen" behave like an app rather than a bookmark: no network
 * on launch, and it still opens on a train.
 *
 * Books are deliberately NOT cached here. They live in IndexedDB (see
 * shelf.js) and are hundreds of megabytes — putting them in the same cache
 * as the interface would mean a browser reclaiming space could take the app
 * and the library together.
 */
/* BUMP THIS ON EVERY RELEASE.
   The shell is served cache-first, which is what makes the app open with no
   network — and it means a stale cache is served forever until the cache
   name changes. This bit us repeatedly while building: edits appeared to do
   nothing because the worker kept handing back the old file. */
const VERSION = "spine-web-v2";
const SHELL = [
  ".", "index.html", "app.js", "shelf.js", "open.js", "style.css",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-1024.png",
  "icon-180.png",
];

self.addEventListener("install", e => {
  // addAll fails the whole install if one file 404s, which is the behaviour
  // we want: a half-cached app that "works offline" is worse than none.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // blob: URLs are the audio being played out of the file on disk — never
  // route those through here.
  if (url.protocol === "blob:") return;

  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) {
      // Refresh in the background so an update lands on the next launch
      // without ever making this one wait for the network.
      e.waitUntil((async () => {
        try {
          const fresh = await fetch(e.request);
          if (fresh.ok) (await caches.open(VERSION)).put(e.request, fresh.clone());
        } catch (_) { /* offline: the cached copy is the right answer */ }
      })());
      return hit;
    }
    try {
      return await fetch(e.request);
    } catch (_) {
      return (await caches.match("index.html")) || Response.error();
    }
  })());
});
