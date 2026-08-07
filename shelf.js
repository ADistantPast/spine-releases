/* Spine on the web — the part that stands in for the server.
 *
 * The reader (app.js) is the same interface the phone runs. Every call it
 * makes to its backend goes through one function, api(), and every byte of
 * audio comes from one URL — so making it work with no server at all is a
 * matter of answering those two things locally rather than rewriting a
 * reader. That is the whole design: one interface, two backings.
 *
 * Nothing is uploaded. There is no server to upload to. The .spinebook you
 * open is read off your own disk and stays there.
 */
(() => {
  "use strict";

  /* The web reader's own version, reported to the Library footer through
     /api/about exactly as the desktop and the phone report theirs. There is
     no build step and no version.txt to read, so it is written here — keep
     it in step with VERSION in sw.js, which rotates the cache. */
  const WEB_VERSION = "1.0.29";
  window.SPINE_WEB_VERSION = WEB_VERSION;

  const DB_NAME = "spine";
  const DB_VERSION = 1;
  const STORE = "books";

  /* ---------------------------------------------------------------- zip
   *
   * A .spinebook is a zip holding book.json and the audio. We read it by
   * hand rather than pulling in a zip library, for two reasons: the whole
   * app is meant to work offline off a static page with no build step, and
   * the audio is stored *uncompressed* (ZIP_STORED, see save_bundle in
   * app.py), which means we do not want it decompressed or copied at all —
   * we want a window onto the bytes where they already sit.
   *
   * The archive is read via its central directory — see readCentralDirectory
   * below for why walking headers from the front does not survive a real book.
   */
  async function readBundle(file) {
    const dirEntries = await readCentralDirectory(file);
    if (!dirEntries["book.json"]) throw new Error("not-a-spinebook");
    const audioName = Object.keys(dirEntries).find(n => n.startsWith("audio."));
    if (!audioName) throw new Error("no-audio");

    const j = await dataRange(file, dirEntries["book.json"]);
    const raw = file.slice(j.start, j.start + j.comp);
    const text = j.method === 0
      ? await raw.text()
      : await new Response(raw.stream()
          .pipeThrough(new DecompressionStream("deflate-raw"))).text();

    const a = await dataRange(file, dirEntries[audioName]);
    if (a.method !== 0) throw new Error("audio-compressed");

    return {
      book: JSON.parse(text),
      // A slice, not a copy: this is a view onto the file on disk, so a
      // 600 MB audiobook costs nothing in memory and still seeks.
      audio: file.slice(a.start, a.start + a.comp, mimeFor(audioName)),
      audioName,
    };
  }

  /* Read the index at the end of the archive rather than walking headers
     from the front.
     
     Walking from the front looks simpler and was tried first: it breaks on
     every real book. book.json holds the whole transcript and deflates to
     more than a megabyte, so the audio's header sits past any sane read
     window and the audio simply appears not to be there. The central
     directory is a few hundred bytes at the end and gives every entry's
     offset outright. */
  async function readCentralDirectory(file) {
    // The end record is 22 bytes plus a comment of up to 64 KB. Ours has no
    // comment, but reading the whole tail costs nothing and is correct.
    const tailLen = Math.min(file.size, 66 * 1024);
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
    const tv = new DataView(tail.buffer);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not-a-spinebook");

    const count = tv.getUint16(eocd + 10, true);
    const dirSize = tv.getUint32(eocd + 12, true);
    const dirAt = tv.getUint32(eocd + 16, true);
    // 0xFFFFFFFF is zip64's "look elsewhere" marker. Spine never writes one
    // (it would need a 4 GB archive), so say so rather than read nonsense.
    if (dirAt === 0xFFFFFFFF || dirSize === 0xFFFFFFFF) throw new Error("unsupported");

    const dir = new Uint8Array(await file.slice(dirAt, dirAt + dirSize).arrayBuffer());
    const dv = new DataView(dir.buffer);
    const td = new TextDecoder();
    const out = {};

    let p = 0;
    for (let n = 0; n < count && p + 46 <= dir.length; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const comp = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(dir.subarray(p + 46, p + 46 + nlen));
      out[name] = { method, comp, local };
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  /* Where an entry's bytes actually begin. The central directory points at
     the local header, and that header carries its own extra-field length —
     which is allowed to differ from the one in the directory, so it has to
     be read rather than assumed. */
  async function dataRange(file, entry) {
    const h = new DataView(await file.slice(entry.local, entry.local + 30).arrayBuffer());
    if (h.getUint32(0, true) !== 0x04034b50) throw new Error("not-a-spinebook");
    const nlen = h.getUint16(26, true);
    const elen = h.getUint16(28, true);
    return { start: entry.local + 30 + nlen + elen, comp: entry.comp, method: entry.method };
  }

  const mimeFor = name => ({
    mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", mp4: "audio/mp4",
    wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg",
    aac: "audio/aac",
  }[name.split(".").pop().toLowerCase()] || "audio/mpeg");

  /* The same id the desktop and the phone use: SHA-1 over the file's size
   * written out in decimal, then its first 4 MB. Same file, same id, on any
   * machine — which is what lets a book you already have be matched back up
   * with its audio without asking you which is which. Mirrors book_id() in
   * app.py; changing one without the other silently breaks that matching. */
  async function idForAudio(file) {
    const head = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
    const size = new TextEncoder().encode(String(file.size));
    const buf = new Uint8Array(size.length + head.byteLength);
    buf.set(size, 0);
    buf.set(new Uint8Array(head), size.length);
    const digest = await crypto.subtle.digest("SHA-1", buf);
    return [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  /* ------------------------------------------------------------ storage
   *
   * The transcript, chapters, notes, bookmark and position are a few MB and
   * live in IndexedDB, so they survive closing the tab. The audio does not:
   * it is hundreds of megabytes, and browsers are entitled to throw that
   * away. So a book is remembered, and its audio is re-attached — see
   * needsAudio below.
   */
  let dbp = null;
  const db = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE))
        r.result.createObjectStore(STORE, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      /* An IDB get for a key that is not there succeeds with result
         undefined. Returning the request itself in that case — which the
         first version did — hands back a truthy object, so "no such book"
         read as "found one", and any file at all was accepted as a book
         already in the library. Unwrap the request always. */
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }

  const getBook = id => tx("readonly", s => s.get(id)).then(r => r || null);
  const putBook = b => tx("readwrite", s => s.put(b));
  const allBooks = () => tx("readonly", s => s.getAll());
  const dropBook = id => tx("readwrite", s => s.delete(id));

  /* ------------------------------------------------ a book sent by code
   *
   * Someone on the desktop app sends a book and reads out a code. This is
   * the other end of that: fetch it, unlock it, hand it to addBundle as if
   * it had been picked off disk.
   *
   * The browser can do this at all only because the host answers with
   * Access-Control-Allow-Origin:* — measured, not assumed, and it was the
   * open question that decided whether the web reader could take part.
   * Content-Length is exposed too, which is what makes the progress real
   * rather than a spinner.
   *
   * Nothing here is trusted to the host: it holds AES-GCM ciphertext and the
   * key lives in the code. See the sharing section of app.py for the format;
   * the two must agree byte for byte.
   */
  const SHARE_FETCH = "https://litter.catbox.moe/{code}.bin";
  const SHARE_MAGIC = "SPINEBK1";
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const SECRET_BYTES = 10;

  function parseCode(code) {
    const clean = (code || "").replace(/[^0-9A-Za-z]/g, "");
    if (clean.length !== 6 + 16) throw new Error("That code is not the right length.");
    const location = clean.slice(0, 6).toLowerCase();
    let n = 0n;
    for (const ch of clean.slice(6).toUpperCase()) {
      // the Crockford slips: a typed I or L is 1, a typed O is 0
      const v = B32.indexOf({ I: "1", L: "1", O: "0", U: "0" }[ch] || ch);
      if (v < 0) throw new Error(`"${ch}" is not part of a Spine code.`);
      n = (n << 5n) | BigInt(v);
    }
    const secret = new Uint8Array(SECRET_BYTES);
    for (let i = SECRET_BYTES - 1; i >= 0; i--) { secret[i] = Number(n & 255n); n >>= 8n; }
    return { location, secret };
  }

  async function shareKey(secret) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("spine-share-v1"),
        info: enc.encode("spine-share-key") }, base, 256);
    return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
  }

  async function receiveByCode(code, onProgress) {
    const { location, secret } = parseCode(code);
    const key = await shareKey(secret);
    const res = await fetch(SHARE_FETCH.replace("{code}", location));
    if (res.status === 404)
      throw new Error("That code has expired, or it was typed wrong. Codes only last a few hours.");
    if (!res.ok) throw new Error(`The transfer service answered ${res.status}.`);

    /* Read the stream and unseal as it arrives, rather than downloading the
       whole thing and then decrypting it. A book is several hundred
       megabytes and holding the ciphertext AND the plaintext at once is how
       a phone browser gets killed. The plaintext pieces go straight into a
       Blob, which the browser is free to spill to disk. */
    const total = +res.headers.get("Content-Length") || 0;
    const reader = res.body.getReader();
    const parts = [];
    let buf = new Uint8Array(0), got = 0, index = 0, prefix = null;

    const take = n => {
      if (buf.length < n) return null;
      const head = buf.slice(0, n);
      buf = buf.subarray(n);
      return head;
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        const grown = new Uint8Array(buf.length + value.length);
        grown.set(buf); grown.set(value, buf.length);
        buf = grown;
        got += value.length;
        if (onProgress && total) onProgress(got / total);
      }
      if (!prefix) {
        const head = take(17);
        if (head) {
          if (new TextDecoder().decode(head.slice(0, 8)) !== SHARE_MAGIC)
            throw new Error("That download is not a Spine book.");
          if (head[8] !== 1)
            throw new Error("That book was sent by a newer version of Spine.");
          prefix = head.slice(13, 17);
        }
      }
      while (prefix) {
        if (buf.length < 4) break;
        const size = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
        if (buf.length < 4 + size) break;
        take(4);
        const sealed = take(size);
        const nonce = new Uint8Array(12);
        nonce.set(prefix);
        new DataView(nonce.buffer).setUint32(8, index);   // 4-byte prefix + 8-byte counter
        const aad = new Uint8Array(4);
        new DataView(aad.buffer).setUint32(0, index);
        let plain;
        try {
          plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
            key, sealed);
        } catch (e) {
          throw new Error("That code is not right for this book.");
        }
        parts.push(plain);
        index++;
      }
      if (done) break;
    }
    if (buf.length) throw new Error("That download stopped early. Try the code again.");
    return addBundle(new Blob(parts));
  }

  /* --------------------------------------------------------- the shelf */

  const audioUrls = new Map();   // id -> object URL, for this session only
  const attached = new Map();    // id -> Blob, so a reload can re-use it

  async function addBundle(file) {
    const { book, audio, audioName } = await readBundle(file);
    if (!book.id) throw new Error("no-id");
    const existing = await getBook(book.id);
    /* Re-opening a bundle you already have keeps the reading you have done
       since — the file on someone else's disk does not know about it.

       Field by field, and only where the stored copy actually has something.
       Taking them wholesale looks tidier and quietly wipes the book: a
       record written before some field existed hands back undefined, and
       the bundle's real title and chapters are lost to it. */
    const merged = { ...book };
    if (existing) {
      if (Number.isFinite(existing.position)) merged.position = existing.position;
      if (existing.bookmark != null) merged.bookmark = existing.bookmark;
      if (existing.notes && existing.notes.length) merged.notes = existing.notes;
      if (existing.chapters && existing.chapters.length) merged.chapters = existing.chapters;
      if (existing.title) merged.title = existing.title;
      if (existing.series) merged.series = existing.series;
    }
    merged.audioMime = mimeFor(audioName);
    merged.added = merged.added || Date.now() / 1000;
    merged.updated = Date.now() / 1000;
    await putBook(merged);
    holdAudio(merged.id, audio);
    return merged;
  }

  /* Attach audio to a book we already know, by picking the plain audio file
   * rather than the whole bundle. The id is derived from the file itself, so
   * picking the wrong one is caught rather than silently playing the wrong
   * book against the right words. */
  async function attachAudio(file) {
    /* By content, not by name. A file can arrive called .zip because a
       transfer service rewrote it, or with no extension at all, or renamed
       by whoever forwarded it — and the name is the one part of a file that
       nothing guarantees. Every zip starts "PK", so looking is
       cheaper and more honest than trusting the label. */
    if (await looksLikeBundle(file)) return addBundle(file);
    const id = await idForAudio(file);
    const book = await getBook(id);
    if (!book) throw new Error("unknown-audio");
    holdAudio(id, file.slice(0, file.size, mimeFor(file.name)));
    return book;
  }

  /* Hand the book's audio to whoever is going to serve it.

     Preferred: the service worker, which answers Range requests like a
     server would. A blob: URL is the fallback for a first visit before the
     worker has taken control, and for anywhere workers are unavailable —
     it works everywhere except, apparently, an iPhone. */
  function holdAudio(id, blob) {
    const old = audioUrls.get(id);
    if (old) URL.revokeObjectURL(old);
    attached.set(id, blob);
    audioUrls.set(id, URL.createObjectURL(blob));
    tellWorker(id, blob);
  }

  function tellWorker(id, blob) {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (c) try { c.postMessage({ type: "audio", id, blob }); } catch (e) {}
  }

  /* A worker can be stopped and restarted at any time, and comes back
     holding nothing. Re-hand everything whenever one takes over. */
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      for (const [id, blob] of attached) tellWorker(id, blob);
    });
  }

  const workerServed = () =>
    !!(navigator.serviceWorker && navigator.serviceWorker.controller);

  const hasAudio = id => audioUrls.has(id);

  /* Four bytes is enough to tell a zip from an audio file. Whether it is a
     Spine book specifically is settled by readBundle looking for book.json. */
  async function looksLikeBundle(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    } catch (e) { return false; }
  }


  /* ------------------------------------------------- keeping a copy
   *
   * Everything above remembers the *book* — the words, chapters, notes and
   * your place. It does not remember the audio, because the audio is the
   * whole file and the browser only ever had a window onto it. Close the
   * tab and that window is gone.
   *
   * The origin private file system is somewhere the page can put a real
   * copy. It is not the user's disk — it is storage belonging to this site,
   * invisible in Finder, and removing the site removes it. Which is why it
   * is offered rather than assumed: 600 MB is a real thing to spend.
   *
   * Safari has no way to remember a file the user picked — no file handles,
   * in any version — so on a Mac or an iPhone this copy is the only way to
   * avoid re-picking the book on every visit.
   */
  const KEEP_DIR = "audio";

  const keepDir = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(KEEP_DIR, { create: true });

  const canKeep = () => !!(navigator.storage && navigator.storage.getDirectory);

  /* Written in slices, never all at once: a 600 MB ArrayBuffer is a bad idea
     on a phone, and slicing is what lets the copy report progress. */
  const CHUNK = 8 * 1024 * 1024;

  async function keepCopy(id, blob, onProgress) {
    const dir = await keepDir();
    const fh = await dir.getFileHandle(id, { create: true });

    if (typeof fh.createWritable === "function") {
      const w = await fh.createWritable();
      try {
        for (let at = 0; at < blob.size; at += CHUNK) {
          const end = Math.min(at + CHUNK, blob.size);
          await w.write(await blob.slice(at, end).arrayBuffer());
          onProgress && onProgress(end / blob.size);
        }
        await w.close();
      } catch (e) { try { await w.abort(); } catch (_) {} throw e; }
      return true;
    }
    // Safari before 26 has no createWritable, but has had the worker-only
    // sync handle since 15.2 — which is the version that matters here.
    return keepViaWorker(id, blob, onProgress);
  }

  let workerUrl = null;
  function keepViaWorker(id, blob, onProgress) {
    workerUrl ||= URL.createObjectURL(new Blob([`
      self.onmessage = async e => {
        const { id, blob, chunk } = e.data;
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle(${JSON.stringify(KEEP_DIR)}, { create: true });
          const fh = await dir.getFileHandle(id, { create: true });
          const h = await fh.createSyncAccessHandle();
          h.truncate(0);
          let at = 0;
          while (at < blob.size) {
            const buf = await blob.slice(at, Math.min(at + chunk, blob.size)).arrayBuffer();
            h.write(buf, { at });
            at += buf.byteLength;
            self.postMessage({ progress: at / blob.size });
          }
          h.flush(); h.close();
          self.postMessage({ done: true });
        } catch (err) { self.postMessage({ error: String((err && err.message) || err) }); }
      };
    `], { type: "text/javascript" }));

    return new Promise((res, rej) => {
      const w = new Worker(workerUrl);
      w.onmessage = e => {
        if (e.data.progress != null) return onProgress && onProgress(e.data.progress);
        w.terminate();
        e.data.error ? rej(new Error(e.data.error)) : res(true);
      };
      w.onerror = err => { w.terminate(); rej(err); };
      w.postMessage({ id, blob, chunk: CHUNK });
    });
  }

  /* The kept copy, as something an <audio> element can play. */
  async function keptBlob(id, mime) {
    if (!canKeep()) return null;
    try {
      const dir = await keepDir();
      const fh = await dir.getFileHandle(id);         // throws if not kept
      const f = await fh.getFile();
      return f.size ? f.slice(0, f.size, mime || "audio/mpeg") : null;
    } catch (e) { return null; }
  }

  /* Is there a copy on this device? Cheap — opening the handle, not the
     file. Kept separate from hasAudio(), which only asks whether the book
     can play right now. */
  async function hasKept(id) {
    if (!canKeep()) return false;
    try { await (await keepDir()).getFileHandle(id); return true; }
    catch (e) { return false; }
  }

  async function dropCopy(id) {
    if (!canKeep()) return;
    try { (await keepDir()).removeEntry(id); } catch (e) {}
  }

  /* Attach a kept copy if there is one. Called before answering anything
     that reports whether a book has its audio, so a book kept on a previous
     visit simply opens. */
  async function tryKept(id, book) {
    if (audioUrls.has(id)) return true;
    const blob = await keptBlob(id, book && book.audioMime);
    if (!blob) return false;
    holdAudio(id, blob);
    return true;
  }

  /* Ask the browser not to throw this away when it is short of room. It is
     granted on a heuristic, and being installed to a home screen is the
     strongest signal — which is why the page suggests that. */
  async function askPersist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    try { return await navigator.storage.persist(); } catch (e) { return false; }
  }

  const spaceLeft = async () => {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return { quota: e.quota || 0, used: e.usage || 0 };
  };

  /* ------------------------------------------------- the backend, faked
   *
   * Answers exactly the calls app.js makes. Anything it does not know about
   * returns an error rather than undefined, so a mistake here shows up as a
   * message instead of a blank screen. */
  async function api(url, body) {
    const [, , head, rest] = url.split("/");   // "", "api", head, rest
    const post = body !== undefined;

    switch (head) {
      case "about":
        return { version: window.SPINE_WEB_VERSION || "web",
                 kind: "Web reader", path: location.host || "offline" };

      case "update":
        /* There is no installer to fetch — the page *is* the app. But the
           shell is served cache-first, so a new release can be sitting on
           the server while this tab happily serves the old one. Tapping the
           version asks the worker to go and look, which is the only thing
           "check for an update" can honestly mean here. */
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await reg.update();
        } catch (e) { /* no worker, or offline: the page is what it is */ }
        return { state: "current", version: WEB_VERSION };

      case "library": {
        const books = await allBooks();
        // so the list can say which books are ready and which want their file
        const kept = await Promise.all(books.map(async b => {
          await tryKept(b.id, b);
          return hasKept(b.id);
        }));
        books.forEach((b, i) => { b._kept = kept[i]; });
        return books
          .sort((a, b) => (b.updated || 0) - (a.updated || 0))
          .map(b => ({
            id: b.id, title: b.title || "Untitled", series: b.series || "",
            duration: b.duration || 0, position: b.position || 0,
            bookmark: b.bookmark == null ? null : b.bookmark,
            chapters: (b.chapters || []).length,
            status: b.status || "",
            missing: !hasAudio(b.id),      // known, but its audio is not here
            kept: !!b._kept,               // a copy lives on this device
            updated: b.updated || 0,
          }));
      }

      case "book": {
        const b = await getBook(rest);
        if (!b) return { error: "That book is not on this device." };
        await tryKept(rest, b);          // kept on an earlier visit? just open it
        return { ...b, missing: !hasAudio(b.id) };
      }

      case "forget":
        await dropBook(rest);
        await dropCopy(rest);
        { const c = navigator.serviceWorker && navigator.serviceWorker.controller;
          if (c) try { c.postMessage({ type: "audio-drop", id: rest }); } catch (e) {} }
        audioUrls.delete(rest);
        attached.delete(rest);
        return { ok: true };

      case "chapters": case "notes": case "position":
      case "bookmark": case "offset": case "title": case "series":
      case "status": {
        if (!post) return { error: "Nothing sent." };
        const b = await getBook(rest);
        if (!b) return { error: "That book is not on this device." };
        if (head === "chapters") b.chapters = body.chapters || [];
        else if (head === "notes") b.notes = body.notes || [];
        else if (head === "title") b.title = (body.title || "").trim() || b.title;
        else if (head === "series") b.series = (body.series || "").trim();
        else if (head === "status") {
          /* Anything unrecognised clears it — "no label" is the ordinary
             state, and the same rule set_status() applies in app.py. */
          const want = (body.status || "").trim().toLowerCase();
          b.status = ["reading","paused","completed","dropped"].includes(want) ? want : "";
        }
        else b[head] = body.t;          // position, bookmark, offset
        b.updated = Date.now() / 1000;
        await putBook(b);
        return head === "chapters" ? { chapters: b.chapters }
             : head === "notes" ? { notes: b.notes }
             : head === "title" ? { title: b.title }
             : head === "series" ? { series: b.series }
             : head === "status" ? { status: b.status }
             : { [head]: b[head] };
      }
    }
    return { error: `The web reader has no ${url}.` };
  }

  window.SpineLocal = {
    api,
    canKeep, keepCopy, keptBlob, hasKept, dropCopy, askPersist, spaceLeft,
    heldAudio: id => attached.get(id) || null,
    /* A same-origin URL the worker answers with proper 206s, falling back
       to the blob when there is no worker yet.

       "direct" asks for the blob outright. That is the escape hatch for a
       browser whose media element never reaches the service worker at all:
       WebKit has a long history there, and a page-level fetch succeeding
       proves nothing, because it is the media load specifically that is
       routed differently. Rather than guess which browsers are affected,
       the reader tries the worker, and asks for this if the element says
       it could not load. */
    audioUrl: (id, mode) => {
      if (!audioUrls.has(id)) return "";
      return workerServed() && mode !== "direct"
        ? new URL(`spine-audio/${id}`, location.href).href
        : audioUrls.get(id);
    },
    reoffer: id => { const b = attached.get(id); if (b) tellWorker(id, b); return !!b; },
    hasAudio,
    addBundle,
    receiveByCode,
    attachAudio,
    looksLikeBundle,
    idForAudio,
    getBook,
    listBooks: allBooks,
  };
})();
