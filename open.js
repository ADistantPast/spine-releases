/* Getting a book into the reader: the file picker, dropping onto the page,
 * and re-attaching audio to a book we already remember.
 *
 * Kept apart from app.js so the reader stays the same file the phone runs.
 * Everything here is about the one thing a web version has to solve that a
 * packaged app does not — it has no folder of its own to read from.
 */
(() => {
  "use strict";

  const pick = () => document.getElementById("filePick").click();

  /* What we are waiting for. A book whose audio we lost to a browser
   * clearing its storage needs the audio, not another whole bundle — and it
   * should reopen to the page you were on, so the id is remembered here. */
  let wantAudioFor = null;

  async function take(file) {
    if (!file) return;
    const big = file.size > 1.5e9;
    try {
      toast(big ? "Opening — a big book takes a moment…" : "Opening…");
      // attachAudio decides for itself whether this is a bundle, by looking
      // inside rather than at the name
      const book = await SpineLocal.attachAudio(file);
      wantAudioFor = null;
      await loadBook(book.id, "last");
      toast(`Opened ${book.title || "the book"}`);
    } catch (e) {
      wantAudioFor = null;
      toast(explain(e && e.message));
    }
  }

  const explain = code => ({
    "not-a-spinebook":
      "That file is not a Spine book. Export one from Spine with Export → Phone bundle.",
    "no-audio": "That book has no audio inside it.",
    "audio-compressed":
      "That bundle was packed in a way this reader cannot read.",
    "no-id": "That bundle is missing its book id.",
    "unknown-audio":
      "That audio does not belong to any book here. Open its .spinebook first.",
    "unsupported": "That zip was written by something other than Spine.",
  }[code] || "Could not open that file.");

  document.getElementById("filePick").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";        // so picking the same file twice still fires
    take(f);
  });

  document.addEventListener("click", e => {
    if (e.target.id === "blankPick") pick();
  });

  /* Drag and drop over the whole page. dragover has to be cancelled or the
     browser navigates to the file instead, which loses the app. */
  const veil = document.getElementById("dropveil");
  let depth = 0;
  const isFile = e => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", e => {
    if (!isFile(e)) return;
    e.preventDefault(); depth++; veil.classList.add("on");
  });
  addEventListener("dragover", e => { if (isFile(e)) e.preventDefault(); });
  addEventListener("dragleave", e => {
    if (!isFile(e)) return;
    if (--depth <= 0) { depth = 0; veil.classList.remove("on"); }
  });
  addEventListener("drop", e => {
    if (!isFile(e)) return;
    e.preventDefault(); depth = 0; veil.classList.remove("on");
    take(e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  /* A book we remember but whose audio is not loaded this session. The words,
     chapters, notes and your place are all still here — only the sound has to
     be handed back. */
  window.SpineNeedsAudio = id => {
    wantAudioFor = id;
    pick();
  };
})();
