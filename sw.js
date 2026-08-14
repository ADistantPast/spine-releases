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
const VERSION = "spine-web-1.1.0";   // keep in step with WEB_VERSION in shelf.js
const SHELL = [
  ".", "index.html", "app.js", "shelf.js", "open.js", "style.css",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-1024.png",
  "icon-180.png",
];

/* ---------------------------------------------------------------- audio
 *
 * The reader used to point <audio> at a blob: URL made from a slice of the
 * book on disk. That works in Chromium and does not on an iPhone, where a
 * real device reported "this file will not play" — blob URLs for large
 * media on iOS have a long history of range requests failing outright, and
 * this was flagged as a risk before it was ever built.
 *
 * A media element wants a server that speaks Range. There is no server, so
 * the worker is one: the page hands over the Blob, and this answers 206s
 * out of it. Same bytes, same zero-copy slice, but arriving the way a
 * player expects rather than through a URL scheme that has to be special
 * cased by every browser.
 */
const AUDIO_PREFIX = "spine-audio/";
const audioBlobs = new Map();     // book id -> Blob

self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "audio" && d.id && d.blob) audioBlobs.set(d.id, d.blob);
  else if (d.type === "audio-drop" && d.id) audioBlobs.delete(d.id);
  else if (d.type === "audio-has") {
    // the page asking whether a restarted worker still has this book
    e.source && e.source.postMessage({ type: "audio-has", id: d.id, has: audioBlobs.has(d.id) });
  }
});

function serveAudio(id, request) {
  const blob = audioBlobs.get(id);
  // A worker can be stopped and restarted at any time and comes back with
  // an empty Map. 503 rather than 404: the page listens for it and hands
  // the book over again instead of telling the reader it is broken.
  if (!blob) return new Response("no audio held", { status: 503 });

  const type = blob.type || "audio/mpeg";
  const range = request.headers.get("range");
  if (!range) {
    return new Response(blob, { status: 200, headers: {
      "Content-Type": type,
      "Content-Length": String(blob.size),
      "Accept-Ranges": "bytes",
    }});
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return new Response(null, { status: 416 });

  let start, end;
  if (m[1] === "") {
    /* "bytes=-N" is a suffix range: the LAST n bytes, not the first. Worth
       getting right rather than treating as a typo — an mp4 keeps its index
       at the end of the file unless it was written for streaming, so a
       player's very first request is often a probe of the tail. Reading it
       as "0 to N" hands back the head of the file, the index is never
       found, and the whole thing looks like an unplayable format. */
    const n = parseInt(m[2], 10);
    if (isNaN(n) || n <= 0) return new Response(null, { status: 416,
      headers: { "Content-Range": `bytes */${blob.size}` } });
    start = Math.max(0, blob.size - n);
    end = blob.size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : blob.size - 1;
  }
  if (isNaN(start) || start >= blob.size) return new Response(null, { status: 416,
    headers: { "Content-Range": `bytes */${blob.size}` } });
  if (end >= blob.size) end = blob.size - 1;
  if (end < start) end = start;

  return new Response(blob.slice(start, end + 1, type), { status: 206, headers: {
    "Content-Type": type,
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${blob.size}`,
    "Accept-Ranges": "bytes",
  }});
}

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

  // audio first, and never through the cache — it is hundreds of megabytes
  // and is held in memory for exactly as long as the book is open
  const at = url.pathname.indexOf(AUDIO_PREFIX);
  if (at >= 0) {
    const id = url.pathname.slice(at + AUDIO_PREFIX.length);
    return e.respondWith(serveAudio(id, e.request));
  }
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
