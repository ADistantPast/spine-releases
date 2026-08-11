const $ = id => document.getElementById(id);
const audio = $("audio");

const PAGE_SECONDS = 12 * 60;   // long chapters get split so the DOM stays light
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SENTENCE_END = /[.!?]+["'”’)]?$/;

let book = null;
let pages = [];
let curPage = -1;
let segs = [];                  // book.segments, split at any mid-segment chapter mark
let lyric = [];                 // segs re-cut into sentences, for the compact view
let pw = { s: [], e: [], el: [] };     // words on the page now
let nowIdx = -1;
let liveSeg = null;
let lastWordTop = -1;
let follow = true;              // is the view tied to the playhead?
let browseT = 0;                // the time the bar and the reader are on
let autoScrollUntil = 0;
let speedIdx = 2;
let saveTimer = null;
let compact = false;
let lyricIdx = -1;
let notePopMode = null;         // {kind:"new", s, e} | {kind:"edit", idx}
let editingClock = false;       // the clock is a jump-to field while typing

/* ------------------------------------------------------------ helpers */

const clock = sec => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const short = sec => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}` : `0:${String(m).padStart(2, "0")}`;
};
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M4 6.5 H20 M9.5 6.5 V4.5 H14.5 V6.5" /><path d="M6.5 6.5 L7.5 20 H16.5 L17.5 6.5" /><path d="M10 10 V16.5 M14 10 V16.5" /></svg>';
// The series button's empty state — same stroke weight and viewBox as every
// other icon in the app, rather than the word "Series" doing double duty as
// both a label and the only clue that clicking it does anything.
const PLUS_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5 V19 M5 12 H19" /></svg>';

// Shown or hidden on the timeline. Line art at the same 24px viewBox and
// stroke weight as every other icon here, rather than the emoji that was
// standing in — an emoji renders as a full-colour glyph from the system font,
// which is the one thing in this row that never matched the palette. The
// hidden state gets its own struck-through eye rather than only being dimmer,
// since "faint" and "off" are hard to tell apart at 13px.
const EYE_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M2.6 12 C6 7.2 18 7.2 21.4 12 C18 16.8 6 16.8 2.6 12 Z" /><circle cx="12" cy="12" r="2.5" /></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M2.6 12 C6 7.2 18 7.2 21.4 12 C18 16.8 6 16.8 2.6 12 Z" /><circle cx="12" cy="12" r="2.5" /><path d="M4 20 L20 4" /></svg>';

const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* A tick you can feel. "tick" for one chapter crossed, "arm" when a
   press-and-hold engages, anything else for a plain press.

   The work happens natively — SpineNative.haptic() goes through the View,
   so it respects the phone's own touch-feedback setting and needs no
   VIBRATE permission (see MainActivity). navigator.vibrate() is not the
   fallback: it does nothing without that permission, and where it does
   work it is a raw motor buzz rather than a tick. A build of the app
   without the bridge method simply gets no haptics, which is fine. */
function haptic(kind) {
  const n = window.SpineNative;
  if (!n || !n.haptic) return;
  try { n.haptic(kind); } catch (e) { /* older companion build */ }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

/* There is no server here. shelf.js answers the same calls out of the
   book you opened and IndexedDB, which is what lets this be the phone's
   reader rather than a second one written from scratch. */
async function api(url, body) {
  return SpineLocal.api(url, body);
}

/* ------------------------------------------------------------ opening */

/* Opening a book is picking a file — or typing the code someone read out.
   This is one of the three places the web reader is deliberately allowed to
   differ from the phone copy (see the web reader notes in CLAUDE.md); the
   rest of this file has to stay the same in both. */
$("btnImport").onclick = () => {
  openDrawer("Add a book");
  /* The code goes first because it is the thing you came here to do — you
     have been read a code and you want to type it. Opening a file is the
     fallback, and the explanation belongs under both rather than wedged
     between them. */
  $("drawerBody").innerHTML = `
    <p class="hint">Type the code someone sent you</p>
    <div class="code-entry">
      <input id="codeIn" class="code-in" spellcheck="false" autocomplete="off"
             autocapitalize="off" placeholder="0jhyvy-A7K2-M9QX-P4LT-N3RB">
      <button class="btn" id="codeGo">Get the book</button>
    </div>
    <div id="recvBox"></div>
    <div class="row stack" id="addFromFile">
      <span class="row-n">Or open a file</span>
      <span class="row-sub">A .spinebook someone sent you. Whatever it has been
        renamed to along the way — the reader looks inside it.</span>
    </div>
    <p class="hint">Codes last a few hours. The book arrives encrypted and the
      code is what unlocks it, so the service carrying it never sees what it
      is holding. Nothing is uploaded from here.</p>`;

  $("addFromFile").onclick = () => $("filePick").click();

  const go = async () => {
    const code = $("codeIn").value.trim();
    if (!code) return;
    const box = $("recvBox");
    $("codeGo").disabled = true;
    box.innerHTML = `
      <p class="export-stage" id="recvStage">Fetching</p>
      <div class="working-bar"><div id="recvFill"></div></div>
      <p class="export-pct" id="recvPct">0%</p>`;
    try {
      const b = await SpineLocal.receiveByCode(code, f => {
        const pct = Math.round(Math.min(1, Math.max(0, f)) * 100);
        if ($("recvFill")) { $("recvFill").style.width = pct + "%"; $("recvPct").textContent = pct + "%"; }
      });
      closeDrawer();
      // A book that came from a code has no file behind it, so shelf.js
      // keeps a copy without being asked. Say so when it could not — the
      // book plays now and will be gone after a reload, and that is worth
      // knowing while the code still works.
      toast(b.keepFailed
        ? `Added ${b.title || "the book"} — but it could not be kept on this `
          + `device (${b.keepFailed}), so get it again before you close the tab.`
        : b.savedAs
          ? `Added ${b.title || "the book"}, and saved ${b.savedAs} to your downloads.`
          : `Added ${b.title || "the book"}`);
      await loadBook(b.id, "last");
    } catch (e) {
      if ($("recvBox")) $("recvBox").innerHTML = "";
      toast(e.message || "Could not fetch that book.");
    } finally {
      if ($("codeGo")) $("codeGo").disabled = false;
    }
  };
  $("codeGo").onclick = go;
  $("codeIn").onkeydown = e => { if (e.key === "Enter") go(); };
};

async function loadBook(id, startAt = "last") {
  const b = await api(`/api/book/${id}`);
  if (b.error) return toast(b.error);
  book = b;
  book.chapters = book.chapters || [];
  book.notes = book.notes || [];
  hiddenChapters = new Set();
  hiddenNotes = new Set();
  closeDrawer();

  $("title").textContent = b.title;
  $("blank").hidden = true;
  $("transport").hidden = false;
  positionJump();
  /* Only ever a real source. Assigning "" makes the browser resolve it
     against the page URL, fetch the HTML, fail to decode it and fire
     onerror — which reports "this file will not play". So a book waiting for
     its audio accused itself of being corrupt, and the honest message
     underneath it never got a word in. */
  /* Swapping src silently sets paused = true and fires no pause event, so
     nothing else here would notice the last book stopping. */
  wantPlaying = false;
  syncPlayButton();
  const src = SpineLocal.audioUrl(id);
  if (src) {
    audio.src = src;
  } else {
    audio.removeAttribute("src");
    audio.load();               // drop whatever the last book left behind
  }
  audio.playbackRate = SPEEDS[speedIdx];
  $("clockEnd").textContent = clock(b.duration);
  $("seek").max = Math.max(1, Math.floor(b.duration));

  buildPages();
  drawTicks();
  updateSubtitle();

  const t = startAt === "start" ? 0
    : startAt === "bookmark" && b.bookmark != null ? b.bookmark
    : (b.position || 0);
  renderBook(t);
  if (compact) renderLyric(t, true);
  seekWhenReady(t);
  browseT = t;
  lastMarkPct = -1;   // a new book means a new duration behind the same %
  updateTimeline(t);
  /* Light the word the book is sitting on, straight away.

     Nothing did. The highlight is only ever set by the playback loop or by a
     deliberate jump, so an opened book showed a correct playhead over unlit
     text until you pressed play. Quietly, because renderBook() has already
     scrolled to this moment and setNow aims a little higher up the page —
     doing both is a visible jolt on load. */
  // Math.max: at the very start nothing has been spoken yet and wordAt()
  // rightly answers "no word" — but the word you are *on* is the first one.
  setNow(Math.max(0, wordAt(t)), true);
  playUi();
  updateBookmarkUi();
  placeCarets();
  positionScrollRail();
  setSleep(0);          // a timer set for the last book shouldn't stop this one
  mediaChapter = -1;    // force the lock screen onto the new book
  pushMediaState();

  /* The words survive in the browser's storage; hundreds of megabytes of
     audio do not, and no browser promises to keep them. So a book can be
     here and silent, and the fix is to hand its file back rather than to
     start again. */
  if (b.missing) {
    toast("This book needs its audio — choose the file to carry on.");
    setTimeout(() => SpineNeedsAudio(b.id), 900);
  }
}

/* Where the book should open, applied once the audio can accept it.

   Assigning currentTime before the element has its metadata is silently
   discarded — there is no duration yet to seek within — so a book resumed
   from a saved position sat at 0:00:00 while the text was correctly lit at
   the real place. Remember the intended moment and apply it the instant the
   metadata lands. */
let pendingStart = null, pendingPlay = false;

function seekWhenReady(t, resume = false) {
  pendingStart = t;
  /* Assigned, never OR-ed: opening another book must clear a resume the
     last one left behind. */
  pendingPlay = resume;
  if (audio.readyState >= 1) applyPendingStart();   // already loaded: now
}

function applyPendingStart() {
  if (pendingStart === null || !book) return;
  const t = pendingStart;
  pendingStart = null;
  audio.currentTime = t;
  browseT = t;
  // the bar is only driven by the playback loop, which is not running
  // while the book sits paused at the place it reopened to
  $("seek").value = Math.floor(t);
  playUi();
  /* A reload that interrupted playback carries on by itself — see
     audio.onerror. Done here rather than beside the src assignment so the
     sound starts at the restored position, not at 0. */
  reloading = false;
  if (pendingPlay) { pendingPlay = false; startPlaying(); }
}
audio.addEventListener("loadedmetadata", applyPendingStart);

function updateSubtitle() {
  const n = book.chapters.length;
  $("subtitle").textContent =
    `${clock(book.duration)} · ${n} chapter${n === 1 ? "" : "s"}` +
    (book.language ? ` · ${book.language}` : "");
}

/* ------------------------------------------------------------ paging */

function splitSegmentsAtChapters(segments, chapters) {
  let out = segments;
  for (const c of chapters) {
    const t = c.t;
    const i = out.findIndex(s => s.s < t && t < s.e);
    if (i < 0) continue;
    const seg = out[i];
    const words = seg.w && seg.w.length ? seg.w : [{ s: seg.s, e: seg.e, w: seg.t }];
    const splitAt = words.findIndex(w => w.s >= t);
    if (splitAt <= 0) continue;      // the mark already lands at the segment start
    const mk = ws => ({
      s: ws[0].s, e: ws[ws.length - 1].e,
      t: ws.map(w => w.w).join("").trim(),
      w: ws,
    });
    out = [...out.slice(0, i), mk(words.slice(0, splitAt)), mk(words.slice(splitAt)),
           ...out.slice(i + 1)];
  }
  return out;
}

/* Whisper's segments are pause-shaped, not sentence-shaped — some run to a
   whole paragraph. The compact view wants one real sentence at a time, so
   re-cut on end punctuation using the word timings. (Same idea as
   _sentences() in app.py, which does this for chapter detection.) */
/* Same detection renderBook uses to gild a chapter's spoken opening in the
   reader — run once here, directly on the seg.w word objects, so the
   pop-out can gild them too. buildLyricLines() below buffers those same
   objects by reference rather than copying them, so a flag set here is
   still there once a sentence is split into .lw spans. renderBook keeps its
   own copy of this because it spreads into a fresh flat array every render
   and reading a mutated seg.w back out would be no simpler than just
   recomputing it — this is only for the view that has no other route to it. */
function markHeadWords() {
  const opensAt = new Map();
  for (const c of book.chapters) {
    const i = segs.findIndex(s => s.e > c.t);
    if (i >= 0 && !opensAt.has(i)) opensAt.set(i, c);
  }
  const flat = [];
  const segStart = [];
  for (let si = 0; si < segs.length; si++) {
    const words = segs[si].w && segs[si].w.length ? segs[si].w : [];
    segStart.push(flat.length);
    for (const w of words) flat.push(w);
  }
  for (const si of opensAt.keys()) {
    const at = segStart[si];
    const len = headingLength(flat, at);
    for (let k = 0; k < len; k++) {
      flat[at + k].head = true;
      flat[at + k].headEnd = k === len - 1;
    }
  }
}

function buildLyricLines() {
  lyric = [];
  lyricEls = null;          // sentences changed; the laid-out DOM is stale
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    lyric.push({
      s: buf[0].s, e: buf[buf.length - 1].e,
      t: buf.map(w => w.w).join("").trim(),
      w: buf.slice(),           // kept so the reading view can light each word
    });
    buf = [];
  };
  for (const seg of segs) {
    const words = seg.w && seg.w.length ? seg.w : [{ s: seg.s, e: seg.e, w: seg.t }];
    for (const w of words) {
      buf.push(w);
      if (SENTENCE_END.test(w.w.trim())) flush();
    }
  }
  flush();
}

function buildPages() {
  segs = splitSegmentsAtChapters(book.segments, book.chapters);
  markHeadWords();
  let bounds = book.chapters.map(c => c.t);
  if (!bounds.length || bounds[0] > 0.5) bounds.unshift(0);

  const starts = bounds.map(t => {
    const i = segs.findIndex(s => s.e > t);
    return i < 0 ? segs.length - 1 : i;
  });

  pages = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] - 1 : segs.length - 1;
    if (to < from) continue;
    let a = from;
    while (a <= to) {
      let b = a;
      while (b < to && segs[b + 1].e - segs[a].s < PAGE_SECONDS) b++;
      pages.push({
        from: a, to: b, chapter: k, opens: a === from,
        s: segs[a].s, e: segs[b].e
      });
      a = b + 1;
    }
  }
  buildLyricLines();
}

const pageAt = t => {
  for (let i = 0; i < pages.length; i++) if (t < pages[i].e) return i;
  return Math.max(0, pages.length - 1);
};

const posAt = (list, t) => {
  let lo = 0, hi = list.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].s <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
};

/* The words the narrator actually said to announce a chapter — "Chapter
   Eleven", "Prologue" — get set in gold at the head of their page. Same
   vocabulary the detector in app.py works from, so what's gilded is exactly
   what was matched on. A hand-placed mark lands mid-sentence with no such
   words, matches nothing, and is left alone. */
const HEAD_KEYWORD = /^(chapter|part|book|section|episode)$/i;
const HEAD_STANDALONE =
  /^(prologue|epilogue|introduction|foreword|afterword|preface|interlude|conclusion|dedication|acknowledgments?|credits|bloopers|outro|extras)$/i;
const NUM_WORDS = new Set(("one two three four five six seven eight nine ten eleven twelve " +
  "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty " +
  "sixty seventy eighty ninety first second third fourth fifth sixth seventh eighth ninth " +
  "tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth " +
  "nineteenth twentieth thirtieth fortieth fiftieth").split(" "));

const bare = s => (s || "").replace(/[^\w'’-]/g, "");
const isNumberWord = w =>
  !!w && (/^\d{1,3}$/.test(w) || /^[ivxlc]{1,7}$/i.test(w) || NUM_WORDS.has(w.toLowerCase()));

function headingLength(flat, i) {
  const first = bare(flat[i] && flat[i].w);
  if (!first) return 0;
  if (HEAD_STANDALONE.test(first)) return 1;
  if (!HEAD_KEYWORD.test(first)) return 0;
  let n = 1;
  for (let k = 0; k < 2; k++) {          // "Chapter twenty one"
    if (!isNumberWord(bare(flat[i + n] && flat[i + n].w))) break;
    n++;
  }
  return n;
}

/* Renders the entire book in one pass so the reader scrolls freely end to
   end. Timings are logged because "is 79k word elements too many?" is a
   measurable question, not a matter of opinion. */
function renderBook(jumpTo) {
  const t0 = performance.now();

  // which segment does each chapter open on
  const opensAt = new Map();
  for (const c of book.chapters) {
    const i = segs.findIndex(s => s.e > c.t);
    if (i >= 0 && !opensAt.has(i)) opensAt.set(i, c);
  }

  // one flat pass over every word: note runs need to see their neighbours
  const flat = [];
  const segStart = [];
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const words = seg.w && seg.w.length ? seg.w : [{ s: seg.s, e: seg.e, w: seg.t }];
    segStart.push(flat.length);
    for (const w of words) {
      /* A note with no extent — made at a moment rather than over a phrase —
         marks a point and highlights nothing. Without the n.e > n.s test it
         still overlapped whatever word was being spoken, so the word lit up
         *and* placeCarets() drew a bar against it: a line on a highlight,
         which is neither of the two things a note is meant to look like. */
      flat.push({ ...w, noteK: book.notes.findIndex(n => n.e > n.s && w.s < n.e && w.e > n.s) });
    }
  }
  flat.forEach((w, idx) => {
    if (w.noteK < 0) return;
    w.noteStart = !(idx > 0 && flat[idx - 1].noteK === w.noteK);
    w.noteEnd = !(idx < flat.length - 1 && flat[idx + 1].noteK === w.noteK);
  });
  // gild the spoken announcement at the head of each chapter
  for (const si of opensAt.keys()) {
    const at = segStart[si];
    const len = headingLength(flat, at);
    for (let k = 0; k < len; k++) {
      flat[at + k].head = true;
      flat[at + k].headEnd = k === len - 1;
    }
  }

  const out = [];
  let fi = 0;
  for (let si = 0; si < segs.length; si++) {
    const chapter = opensAt.get(si);
    if (chapter) out.push(`<p class="chapter-rule" id="ch-${si}">${esc(chapter.name)}</p>`);
    const seg = segs[si];
    const wordCount = (seg.w && seg.w.length) ? seg.w.length : 1;
    const spans = [];
    for (let n = 0; n < wordCount; n++) {
      const w = flat[fi++];
      let cls = "w";
      let na = "";
      let text = w.w;
      if (w.noteK >= 0) {
        cls += " noted" + (w.noteStart ? " noted-start" : "") + (w.noteEnd ? " noted-end" : "");
        na = ` data-note="${w.noteK}"`;
      }
      if (w.head) {
        cls += " head" + (w.headEnd ? " head-end" : "");
        if (w.headEnd) text = text.replace(/[.,;:]+\s*$/, "");
      }
      spans.push(`<span class="${cls}" data-s="${w.s}" data-e="${w.e}"${na}>${esc(text)}</span>`);
    }
    out.push(`<p class="seg" data-i="${si}">${spans.join("")}</p>`);
  }

  const built = performance.now();
  const page = $("page");
  page.innerHTML = out.join("");
  const painted = performance.now();

  pw = { s: [], e: [], el: [] };
  page.querySelectorAll(".w").forEach(el => {
    pw.s.push(parseFloat(el.dataset.s));
    pw.e.push(parseFloat(el.dataset.e));
    pw.el.push(el);
  });
  nowIdx = -1; liveSeg = null; lastWordTop = -1;
  readUpTo = -1; readMax = -1; readTarget = -1;   // a new DOM has no .read at all
  if (readTimer !== null) { cancelAnimationFrame(readTimer); readTimer = null; }

  const done = performance.now();
  console.log(`[spine] ${pw.el.length} words | build ${Math.round(built - t0)}ms `
    + `| innerHTML ${Math.round(painted - built)}ms | index ${Math.round(done - painted)}ms `
    + `| total ${Math.round(done - t0)}ms`);

  // the page has just been rebuilt, so any carets went with it
  placeCarets();

  if (jumpTo !== undefined) scrollToTime(jumpTo, "instant");
}

/* Put the moment at `t` near the top of the reader without re-rendering. */
function scrollToTime(t, behavior) {
  const i = wordAt(t);
  const el = pw.el[Math.max(0, i)];
  if (!el) return;
  const reader = $("reader");
  autoScrollUntil = performance.now() + 900;
  reader.scrollTo({
    top: reader.scrollTop + el.getBoundingClientRect().top
         - reader.getBoundingClientRect().top - reader.clientHeight * 0.32,
    behavior: behavior || "instant",
  });
}

/* ------------------------------------------------------------ the loop */

function wordAt(t) {
  let lo = 0, hi = pw.s.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pw.s[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/* Words behind the playhead are dimmed with .read. Keeping that true means
   touching every word between where the highlight was and where it now is —
   one class write per word while you listen, and twenty-two thousand of them
   when you press "next chapter". Measured at 18ms on a desktop for a
   five-chapter jump, and a phone is several times slower: that is the pause
   you feel on the button.

   Nobody can see more than a screenful, so the words around the new position
   are corrected at once and the rest converge over the following frames.

   Two pointers, because one is not enough and both earlier attempts proved
   it. A cancellable queue silently abandoned whatever it had not reached, so
   two quick taps of "previous chapter" left 3851 words wrongly dark. A
   single pointer plus an immediate visible window was worse in a subtler
   way: the window dirties words outside the pointer's range, so after five
   taps forward and five back, 2004 words stayed dim above a pointer that
   believed it had finished.

   So: readUpTo is the prefix that definitely has .read, readMax is the
   highest word that might. Convergence is both meeting readTarget, and it
   cannot lose ground whatever order the jumps arrive in. */
const READ_NOW = 500;          // corrected synchronously, around the playhead
const READ_PER_FRAME = 4000;   // the invisible remainder, per frame
let readUpTo = -1;             // 0..readUpTo definitely carry .read
let readMax = -1;              // nothing above this carries it
let readTarget = -1;
let readTimer = null;

const readSettled = () => readUpTo === readTarget && readMax === readTarget;

function markRead(target) {
  readTarget = Math.max(-1, Math.min(target, pw.el.length - 1));

  // the screenful you are actually looking at, before the next paint
  for (let j = Math.max(0, readTarget - READ_NOW); j <= readTarget; j++)
    pw.el[j]?.classList.add("read");
  if (readTarget > readMax) readMax = readTarget;
  for (let j = readTarget + 1; j <= Math.min(readMax, readTarget + READ_NOW); j++)
    pw.el[j]?.classList.remove("read");
  /* Those removals are above readTarget, so pull the prefix down to meet it.
     Without this the pointer can later resume adding from *above* a stretch
     the window already cleared and skip it forever — a gap of up to
     READ_NOW words, which is exactly what twelve random jumps produced.
     Safe because readUpTo > readTarget means 0..readTarget were already
     dimmed, so shortening the prefix claims nothing untrue. */
  if (readUpTo > readTarget) readUpTo = readTarget;

  stepRead(READ_NOW);
  if (!readSettled() && readTimer === null)
    readTimer = requestAnimationFrame(pumpRead);
}

function pumpRead() {
  readTimer = null;
  stepRead(READ_PER_FRAME);
  if (!readSettled()) readTimer = requestAnimationFrame(pumpRead);
}

function stepRead(budget) {
  while (budget-- > 0) {
    if (readMax > readTarget) {
      pw.el[readMax--]?.classList.remove("read");
      if (readUpTo > readMax) readUpTo = readMax;
    } else if (readUpTo < readTarget) {
      pw.el[++readUpTo]?.classList.add("read");
      if (readUpTo > readMax) readMax = readUpTo;
    } else break;
  }
}

/* quiet: light the word but do not scroll to it — for when the page has
   already been placed and a second scroll would only shift it. */
function setNow(i, quiet) {
  if (nowIdx >= 0 && pw.el[nowIdx]) pw.el[nowIdx].classList.remove("now");

  markRead(i);

  nowIdx = i;
  const el = pw.el[i];
  if (!el) return;
  el.classList.add("now");

  const seg = el.parentElement;
  if (seg !== liveSeg) {
    liveSeg?.classList.remove("live");
    seg.classList.add("live");
    liveSeg = seg;
  }

  if (!follow || quiet) return;
  const reader = $("reader");
  const r = el.getBoundingClientRect(), rr = reader.getBoundingClientRect();
  if (Math.abs(r.top - lastWordTop) < 4) return;   // same line, no scroll
  lastWordTop = r.top;
  const delta = r.top - (rr.top + rr.height * 0.40);
  if (Math.abs(delta) > 8) {
    autoScrollUntil = performance.now() + 800;     // so we don't read our own
    // smooth is for line-to-line drift; catching up across screens that way
    // animates the entire distance and feels like it is crawling
    const far = Math.abs(delta) > reader.clientHeight * 1.2;
    reader.scrollBy({ top: delta, behavior: far ? "instant" : "smooth" });
  }
}

// the words of the sentence currently being read, so the playhead word can
// be lit without rebuilding the whole line list every frame
let lyricWordEls = [];
let lyricWordIdx = -1;

let lyricEls = null;

/* Sentences are laid out once and advancing only moves classes and the
   scroll offset. Re-rendering a window of lines on every sentence — what
   this replaced — cannot be made smooth: replacing innerHTML destroys the
   old elements and builds new ones already at their final size and opacity,
   so the CSS transitions have no previous value to animate from, and every
   line's text jumps up a position at once.

   Only a window is left *in layout* though. Measured on the real book
   (7,481 sentences) advancing sentence by sentence: every line laid out gave
   29.1 ms average and 64 frames over 20 ms; windowed gave 8.3 ms and zero,
   identical to idle. The cost is the element count, not which property
   animates — swapping the font-size transition for a composited
   transform:scale changed nothing, since a growing line still reflows a
   container with thousands of children. ±40 means re-windowing lands roughly
   every 20 sentences, minutes apart at reading pace. */
const LYRIC_WIN = 40;     // lines kept in layout either side of the current one
const LYRIC_DRIFT = 20;   // how close to the edge we get before re-windowing
let lyricWin = null;

function windowLyric(idx) {
  const lo = Math.max(0, idx - LYRIC_WIN);
  const hi = Math.min(lyric.length - 1, idx + LYRIC_WIN);
  if (lyricWin) {
    // Only touch the difference. Both passes test against the *other* range
    // rather than assuming the windows overlap: after a seek they can be
    // disjoint, and an earlier version's ranges then overlapped so the show
    // pass re-revealed what the hide pass had just hidden, growing the
    // window to 500+ lines instead of recentring it.
    for (let i = lyricWin.lo; i <= lyricWin.hi; i++)
      if (i < lo || i > hi) lyricEls[i].style.display = "none";
    for (let i = lo; i <= hi; i++)
      if (i < lyricWin.lo || i > lyricWin.hi) lyricEls[i].style.display = "";
  } else {
    for (let i = 0; i < lyricEls.length; i++)
      lyricEls[i].style.display = (i >= lo && i <= hi) ? "" : "none";
  }
  lyricWin = { lo, hi };
}

function buildLyricDom() {
  const box = $("lyricLines");
  box.innerHTML = lyric.map((l, i) =>
    `<p class="lyric-line" data-i="${i}" data-s="${l.s}">${esc(l.t)}</p>`).join("");
  lyricEls = [...box.children];
  lyricWin = null;
  lyricIdx = -1;
  lyricWordEls = [];
  lyricWordIdx = -1;
}

/* `force` re-runs the swap even when the sentence index has not changed.

   It exists because callers used to force a redraw by setting lyricIdx = -1
   first — and lyricIdx is also how this function finds the sentence it has to
   take "now" *off*. Zeroing it skipped that cleanup entirely, so the previous
   sentence kept the class, stayed scaled up, and kept its word spans. Two big
   sentences at once, every time you tapped one, whether playing or paused. */
function renderLyric(t, force) {
  if (!lyric.length) return;
  if (!lyricEls || lyricEls.length !== lyric.length) buildLyricDom();

  const idx = posAt(lyric, t);
  if (idx !== lyricIdx || force) {
    if (!lyricWin || idx - lyricWin.lo < LYRIC_DRIFT || lyricWin.hi - idx < LYRIC_DRIFT)
      windowLyric(idx);
    if (lyricIdx >= 0) {
      lyricEls[lyricIdx - 1]?.classList.remove("near");
      lyricEls[lyricIdx + 1]?.classList.remove("near");
      const prev = lyricEls[lyricIdx];
      if (prev) {
        prev.classList.remove("now");
        prev.textContent = lyric[lyricIdx].t;   // drop its word spans again
      }
    }
    lyricEls[idx - 1]?.classList.add("near");
    lyricEls[idx + 1]?.classList.add("near");

    const el = lyricEls[idx];
    if (el) {
      el.classList.add("now");
      // only the sentence being read is split into words — the faded
      // neighbours never light up, so spans there would be dead weight
      if (lyric[idx].w)
        el.innerHTML = lyric[idx].w.map(w => {
          const cls = w.head ? " head" + (w.headEnd ? " head-end" : "") : "";
          const text = w.headEnd ? w.w.replace(/[.,;:]+\s*$/, "") : w.w;
          return `<span class="lw${cls}" data-s="${w.s}" data-e="${w.e}">${esc(text)}</span>`;
        }).join("");
      lyricWordEls = [...el.querySelectorAll(".lw")];
    } else {
      lyricWordEls = [];
    }
    lyricWordIdx = -1;
    lyricIdx = idx;
    centreLyric("smooth");
  }
  setLyricWord(t);
}

function setLyricWord(t) {
  if (!lyricWordEls.length) return;
  let lo = 0, hi = lyricWordEls.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parseFloat(lyricWordEls[mid].dataset.s) <= t) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (found === lyricWordIdx) return;
  lyricWordEls[lyricWordIdx]?.classList.remove("now");
  lyricWordEls[found]?.classList.add("now");
  lyricWordIdx = found;
}

$("lyricView").onclick = e => {
  const line = e.target.closest(".lyric-line");
  if (!line || line.dataset.s === undefined) return;
  playFrom(parseFloat(line.dataset.s));
};

/* scrollIntoView doesn't reliably drive an overflow:hidden container, so
   work the offset out and scroll the box directly */
function centreLyric(behavior) {
  const box = $("lyricView");
  const el = $("lyricLines").querySelector(".now");
  if (!el) return;
  const top = el.offsetTop - (box.clientHeight - el.offsetHeight) / 2;
  // Sentence to sentence is a short, smooth drift. A seek is not: it can be
  // thousands of pixels, and animating the whole distance left the line
  // visibly off-centre for a second or more (measured 506px out half a
  // second after a jump, only settling by ~2s). Same rule setNow() uses in
  // the reader — smooth for the drift, instant once it's more than a screen.
  const far = Math.abs(top - box.scrollTop) > box.clientHeight * 1.2;
  box.scrollTo({ top, behavior: far ? "instant" : (behavior || "instant") });
}

// the pop-out resizes the window underneath us, and the scroll offset that
// centred the line at the old size is meaningless at the new one
window.addEventListener("resize", () => {
  if (compact) centreLyric();
  positionScrollRail();
  // whether the chapter numbers fit on one row is purely a question of
  // width, so it has to be re-asked whenever the window changes — on a
  // Fold that is every time the phone is opened or closed
  if (book) fitTickLabels();
});

/* The on-screen keyboard covering whatever it opens over.

   Android without windowSoftInputMode="adjustResize" just overlays the
   keyboard on the page rather than shrinking it — fixed since 1.0.10, but
   the web reader has no manifest to set. iOS Safari never resizes the
   layout viewport for a keyboard at all, on any setting; that is a
   permanent WebKit property, not a bug to work around once. visualViewport
   is the one signal both agree on: its height drops by roughly the
   keyboard's height wherever one has actually opened, so the body is
   resized to match it — the same effect adjustResize gets natively, done
   here for browsers that will not do it themselves.

   The note popover and the typed-timecode clock used to be repositioned
   from here too, computed against "how tall is the visible area right
   now." That depended on visualViewport actually shrinking when the
   keyboard opened, and on a real device (Google's keyboard specifically)
   it didn't hold — still reported covered, still off-centre. Both are
   pinned near the *top* of the screen now (see their own CSS), which needs
   no information about the keyboard at all, so there is nothing left for
   this function to recompute for them.

   120px is comfortably above a URL bar hiding on scroll (40-60px) and
   comfortably below any real keyboard (200px+), so an ordinary scroll does
   not trigger this. */
const vv = window.visualViewport;
function applyKeyboardInset() {
  if (!vv) return;
  const short = vv.height < window.innerHeight - 120;
  document.body.style.height = short ? `${vv.height}px` : "";
}
if (vv) {
  vv.addEventListener("resize", applyKeyboardInset);
  vv.addEventListener("scroll", applyKeyboardInset);
}

/* ------------------------------------------------------- scroll rail */
// The native scrollbar is only 16px, too thin to keep a finger on while
// dragging. This is a wider invisible strip laid over its edge; pointer
// capture keeps tracking the drag even once the finger wanders back toward
// the centre of the screen, which a bare native scrollbar won't do.
const scrollRail = $("scrollRail");
let railDragging = false, railStartY = 0, railStartScroll = 0;

function positionScrollRail() {
  if (compact || !book) { scrollRail.style.display = "none"; return; }
  const r = $("reader").getBoundingClientRect();
  scrollRail.style.display = "block";
  scrollRail.style.top = `${r.top}px`;
  scrollRail.style.height = `${r.height}px`;
}

scrollRail.addEventListener("pointerdown", e => {
  const reader = $("reader");
  const max = reader.scrollHeight - reader.clientHeight;
  if (max <= 0) return;
  railDragging = true;
  scrollRail.setPointerCapture(e.pointerId);
  railStartY = e.clientY;
  railStartScroll = reader.scrollTop;
  e.preventDefault();
});
scrollRail.addEventListener("pointermove", e => {
  if (!railDragging) return;
  const reader = $("reader");
  const max = reader.scrollHeight - reader.clientHeight;
  const rect = scrollRail.getBoundingClientRect();
  const scale = max / (rect.height || 1);
  const top = Math.max(0, Math.min(max, railStartScroll + (e.clientY - railStartY) * scale));
  // scrollTo(behavior:"instant"), never `scrollTop = ...`: .reader carries
  // scroll-behavior:smooth, which a plain scrollTop assignment inherits. Each
  // move then queued its own eased animation, so the page crawled along
  // behind the finger and only landed on the target after letting go — it
  // read as "the drag does nothing until I release". "instant" is also the
  // only value that overrides the stylesheet here; "auto" defers to it.
  reader.scrollTo({ top, behavior: "instant" });
  e.preventDefault();
});
const endRailDrag = () => { railDragging = false; };
scrollRail.addEventListener("pointerup", endRailDrag);
scrollRail.addEventListener("pointercancel", endRailDrag);

function frame() {
  if (book && !audio.paused) {
    const t = audio.currentTime;
    // Driven by the playhead, never by the browse position: the lit chapter
    // number answers "where does this carry on from", not "what am I
    // looking at".
    updateTimeline(t);
    playUi();
    // The bar tracks the playhead only while following. Once you have
    // scrubbed or scrolled away it is yours until you snap back, or
    // playback would drag the thumb out from under your thumb.
    if (follow && !cpOpen) {
      browseT = t;
      $("seek").value = Math.floor(t);
    }
    if (compact) {
      // Only while following — renderLyric() recentres the view on every
      // sentence change, which is exactly the drag-you-back behaviour the
      // reader avoids by keeping setNow() (word colour only) separate from
      // scrollToTime() (the thing that actually moves the page).
      if (follow) renderLyric(t);
    } else {
      const i = wordAt(t);
      if (i !== nowIdx) setNow(i);
    }
    checkSleep();
    syncOnChapter(t);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ------------------------------------------------------------ timeline */

const chapterAt = t => {
  let ci = 0;
  book.chapters.forEach((c, k) => { if (c.t <= t + 0.01) ci = k; });
  return ci;
};

const tickLabel = name => {
  const m = /^chapter\s+(\d+)/i.exec(name);
  return m ? m[1] : name.slice(0, 2).toUpperCase();
};

// individually hidden marks, kept by timestamp (stable across re-sorts) —
// a per-book, session-only declutter, not saved.
let hiddenChapters = new Set();
let hiddenNotes = new Set();

function drawTicks() {
  const box = $("ticks");

  // Only the marks that actually get a tick, so the every-other-one
  // stagger below counts what's on screen rather than what's in the list —
  // "Start"/"End" and anything hidden would otherwise throw the alternation
  // out of step and put two labels side by side at the same height.
  const shown = book.chapters.filter(c =>
    !/^(start|end)$/i.test(c.name) && !hiddenChapters.has(c.t));

  const chapterHtml = shown.map((c, i) => {
    const pct = book.duration ? c.t / book.duration * 100 : 0;
    return `<div class="tick${i % 2 ? " alt" : ""}" style="left:${pct}%" data-seek="${c.t}">
              <span class="tick-n">${tickLabel(c.name)}</span></div>
            <div class="tick-label">${esc(c.name)}</div>`;
  }).join("");

  const noteHtml = book.notes.map((n, k) => {
    if (hiddenNotes.has(n.s)) return "";
    const pct = book.duration ? n.s / book.duration * 100 : 0;
    return `<div class="tick note" style="left:${pct}%" data-seek="${n.s}" data-note-k="${k}"></div>
            <div class="tick-label">${esc(n.text)}</div>`;
  }).join("");

  box.innerHTML = chapterHtml + noteHtml;
  fitTickLabels();
  fitTickLabelsSoon();
  /* Clicking a mark takes the page to it. Browse, not seek: the timeline is
     the instrument for looking around, and jumping to a chapter to see what
     is in it should not cost you the place you were listening from. Tap a
     word once you are there to actually play from it. */
  box.querySelectorAll(".tick").forEach(el => el.onclick = () => {
    stopFollowing();
    browseTo(parseFloat(el.dataset.seek), "instant");
    if (el.dataset.noteK !== undefined)
      openNotePop({ kind: "edit", idx: +el.dataset.noteK });
  });
}

/* Do any two numbers on the same row actually touch? Grouped by row so a
   staggered layout is judged one row at a time. */
function labelsCollide(pad) {
  const rows = new Map();
  for (const el of $("ticks").querySelectorAll(".tick:not(.note) .tick-n")) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const key = Math.round(r.top);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(r);
  }
  for (const list of rows.values()) {
    list.sort((a, b) => a.left - b.left);
    for (let i = 1; i < list.length; i++)
      if (list[i].left < list[i - 1].right + pad) return true;
  }
  return false;
}

/* Measure, don't guess. The first version compared track width against a
   chapter count with a hand-picked threshold, which staggered a desktop bar
   that had plenty of room — the numbers only need about 14px each, not the
   38px that was assumed. Label width depends on the font, the window and
   whether the labels are "7" or "PR", so the only honest test is to lay them
   out flat and look. Escalate a step at a time: flat, then every other one
   dropped to a second row, then hide the chapter marks entirely. */

/* 6px, not a hairline: two numbers that merely fail to overlap still read as
   one smudged number. Real chapters are not evenly spaced — they bunch — so
   this has to hold for the tightest pair on the bar, not the average. */
const TICK_GAP = 6;
// One size down, tried before giving up entirely. A narrow phone folded to
// its cover screen has a fraction of the track width an unfolded one does —
// two clock readouts and the thumb inset already claim a fixed chunk of it,
// so a busy book can run out of room for stagger alone well before it runs
// out of room altogether. Measured on a 344px-wide cover screen with 20
// chapters: normal size staggered still collides; dropping to 7px/4px gap
// does not, on either row. Smaller numbers beat no numbers.
const TICK_GAP_TIGHT = 4;

/* Hide only the numbers that actually run into the one before them, keeping
   every mark and as many numbers as genuinely fit.

   The escalation above is all-or-nothing, and that is the wrong shape for a
   real book: chapters are not evenly spaced, so two short ones back to back
   put their numbers on top of each other while the other twenty have room to
   spare — and one such pair was enough to drop every number in the book.
   Walking each row left to right and dropping only what overlaps costs one
   pass over labels already measured. */
function fitTickLabels() {
  const tl = $("timeline");
  tl.classList.remove("stagger", "tight", "nonums");

  if (labelsCollide(TICK_GAP)) {
    tl.classList.add("stagger");
    if (labelsCollide(TICK_GAP)) {
      tl.classList.add("tight");
      // Still colliding at the smallest size: drop every number and keep
      // every mark.
      //
      // Two decisions, both the owner's and both learned the hard way. The
      // marks never go — the old .dense hid the whole tick, and the mark is
      // the navigation while the number is only a convenience. And the
      // numbers go all together: an intermediate version dropped just the
      // two that overlapped, which is tidier arithmetic and reads as a bug,
      // because a row of numbers with gaps in it looks broken rather than
      // deliberate. On a phone held upright this is the ordinary state, and
      // a bare row of marks is what it looked like before and should again.
      if (labelsCollide(TICK_GAP_TIGHT)) tl.classList.add("nonums");
    }
  }
  // The chapter numbers are absolutely positioned above the track, so they
  // add no height of their own — the transport has to make room for them or
  // they end up flush against the reader's last line (measured: the topmost
  // label sat on exactly the same pixel as the transport's top edge). CSS
  // can't look upwards from .timeline, so mirror the state onto the bar.
  // Keyed off a label actually surviving, since thinning can in principle
  // leave a row with only one.
  const anyLabel = [...$("ticks").querySelectorAll(".tick:not(.note) .tick-n")]
    .some(n => n.getBoundingClientRect().width > 0);
  const tp = $("transport");
  tp.classList.toggle("has-ticks", anyLabel);
  tp.classList.toggle("two-rows", tl.classList.contains("stagger"));
}

/* Measuring straight after innerHTML can read a pre-font layout: the tick
   labels are set in a system mono that may resolve a frame late, so the first
   measurement can use the fallback's narrower metrics and conclude everything
   fits — then the real face arrives and the numbers overlap. Re-check on the
   next frame and again once fonts report ready. */
function fitTickLabelsSoon() {
  requestAnimationFrame(() => { if (book) fitTickLabels(); });
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(() => { if (book) fitTickLabels(); });
}

let mediaChapter = -1;

function updateTimeline(t) {
  const ci = chapterAt(t);
  const cur = book.chapters[ci];
  document.querySelectorAll(".tick:not(.note)").forEach(el =>
    el.classList.toggle("on", !!cur && Math.abs(parseFloat(el.dataset.seek) - cur.t) < 0.01));
  // the lock screen shows the chapter, so it has to follow along — but only
  // on an actual change, not sixty times a second
  if (ci !== mediaChapter) {
    mediaChapter = ci;
    pushMediaState();
  }
}

/* --------------------------------------------- chapter picker (press-hold)

   Chapter ticks on a phone are a few pixels wide, and a busy book hides them
   altogether (.dense). So: hold a finger still on the scrub track and a reel
   of chapter numbers comes up over the page — drag left toward chapter one,
   right toward the end, lift to go there, with a tick under the thumb at
   every chapter. It is a way to move through a book without looking at it.

   Two things this has to share with the native range input underneath:

   - Before the hold arms, the slider stays live. A hold is not the only
     thing a finger on the track might mean, and a small deliberate scrub
     has to keep scrubbing while the timer runs.
   - Once it arms, the slider must stop dead, or two things fight over the
     same finger. Touch gives the element that got pointerdown an implicit
     pointer capture, so taking capture here is what ends the browser's own
     drag of the thumb; pointer-events:none on top of that is belt and
     braces. Listening on #track rather than #seek is what makes that
     possible — the events still reach us after the slider goes deaf. */

const CP_HOLD_MS = 1000;   // a deliberate hold, but not a wait
const CP_SLOP = 12;        // px of drift allowed before it counts as a scrub
const CP_EDGE = 44;        // hold this near a screen edge and it keeps stepping
const CP_EDGE_MS = 340;    // first step: slow enough to stop on the one you want
const CP_EDGE_MIN_MS = 130;// ...winding up to this if you keep holding
const CP_EDGE_STEP = 35;   // taken off the wait each time

let cpOpen = false;
let cpPending = false;     // finger down, hold timer running, not armed yet
let cpPrevBrowse = 0;      // where we were looking before the reel opened
let cpIdx = 0;             // chapter under the centre of the reel
let cpBase = 0;            // chapter the finger started from
let cpOriginX = 0, cpOriginY = 0;
let cpStep = 48;           // px of travel per chapter
let cpPointer = null;
let cpArmTimer = null, cpEdgeTimer = null, cpEdgeDir = 0;

/* Two letters for anything that isn't a numbered chapter — the same rule the
   timeline ticks use, so "PR" means Prologue in both places. Three would
   overflow the cell now that the lit one is drawn at 59px. The full name is
   spelled out under the reel regardless. */
const cpLabel = name => tickLabel(name);

function cpCancelArm() { clearTimeout(cpArmTimer); cpArmTimer = null; cpPending = false; }

function openChapterPick() {
  // one chapter is not something you can spin through
  if (!book || book.chapters.length < 2) return;
  cpOpen = true;
  cpPending = false;
  cpPrevBrowse = browseT;
  cpStopEdge();
  // Start from the chapter you are looking at, not the one playing — if you
  // have already browsed elsewhere, spinning should carry on from there.
  cpIdx = cpBase = chapterAt(browseT);
  stopFollowing();
  document.body.classList.add("picking");

  try { $("track").setPointerCapture(cpPointer); } catch (e) { /* gone already */ }
  $("seek").style.pointerEvents = "none";

  const reel = $("cpReel");
  reel.innerHTML = book.chapters
    .map(c => `<div class="cp-item">${esc(cpLabel(c.name))}</div>`).join("");

  /* Cover the whole book in about one thumb-throw where that's comfortable,
     but never let a detent get so tight that tremor trips it, nor so wide
     that a short book needs a swipe across the screen for one chapter. */
  const usable = Math.max(120, window.innerWidth - 48);
  cpStep = Math.min(64, Math.max(24, usable / (book.chapters.length - 1)));

  // Place the reel with transitions off, or it slides in from wherever it
  // was left last time instead of simply being there.
  reel.style.transition = "none";
  renderChapterPick();
  void reel.offsetHeight;              // flush, so the next move animates
  reel.style.transition = "";

  $("chapterPick").classList.add("show");
  haptic("arm");
}

function renderChapterPick() {
  const reel = $("cpReel"), items = reel.children;
  if (!items.length) return;
  /* Sizes step down from the middle — small, medium, big, medium, small.
     CSS cannot say "two cells from the lit one", so the rings are labelled
     here and the sizes live in the stylesheet. Only five elements change
     class per detent, whatever the book's length. */
  for (const el of items) el.classList.remove("on", "n1", "n2");
  items[cpIdx].classList.add("on");
  for (const d of [-2, -1, 1, 2]) {
    items[cpIdx + d]?.classList.add(Math.abs(d) === 1 ? "n1" : "n2");
  }
  // The reel is centred on the screen, so shifting it by how far the chosen
  // cell sits from the reel's own middle puts that cell under the centre.
  // Measured, not assumed: the cell width is set in CSS and is the same
  // number as the finger travel per detent.
  const w = items[0].offsetWidth || 74;
  const off = (items.length / 2 - cpIdx - 0.5) * w;
  reel.style.transform = `translate(-50%,-50%) translateX(${off}px)`;
  const c = book.chapters[cpIdx];
  $("cpName").textContent = `${c.name} · ${clock(c.t)}`;
}

function cpSetIdx(i) {
  i = Math.max(0, Math.min(book.chapters.length - 1, i));
  if (i === cpIdx) return;
  cpIdx = i;
  renderChapterPick();
  haptic("tick");
  // The page behind the reel moves to the chapter under the centre, so the
  // numbers are never the only thing you have to go on. Browse only — the
  // playhead stays exactly where it was.
  browseTo(book.chapters[i].t, "instant");
}

function cpMoveTo(x) {
  cpSetIdx(cpBase + Math.round((x - cpOriginX) / cpStep));

  /* Run your finger to either edge and it keeps counting on its own, slowly
     at first and winding up the longer you hold — so one detent at a time is
     easy to stop on, and forty of them do not need forty seconds. Without
     this a book with more chapters than fit in one thumb-throw cannot be
     crossed end to end without lifting off, and "drag left toward chapter
     one" should mean chapter one even from chapter forty. */
  const dir = x < CP_EDGE ? -1 : x > window.innerWidth - CP_EDGE ? 1 : 0;
  // only restart on a change of direction: a finger resting against the edge
  // still jitters, and restarting the ramp on every twitch keeps it slow
  if (dir !== cpEdgeDir) {
    cpStopEdge();
    cpEdgeDir = dir;
    if (dir) cpEdgeStep(dir, CP_EDGE_MS);
  }
}

function cpStopEdge() { clearTimeout(cpEdgeTimer); cpEdgeTimer = null; cpEdgeDir = 0; }

function cpEdgeStep(dir, wait) {
  cpEdgeTimer = setTimeout(() => {
    const before = cpIdx;
    cpSetIdx(cpIdx + dir);
    cpBase += cpIdx - before;   // keep finger position and index in step, so
                                // the next move doesn't undo the stepping
    if (cpIdx === before) return cpStopEdge();   // ran out of book
    cpEdgeStep(dir, Math.max(CP_EDGE_MIN_MS, wait - CP_EDGE_STEP));
  }, wait);
}

function endChapterPick(commit) {
  cpCancelArm();
  cpStopEdge();
  if (cpPointer !== null) {
    try { $("track").releasePointerCapture(cpPointer); } catch (e) {}
    cpPointer = null;
  }
  if (!cpOpen) return;
  cpOpen = false;
  $("seek").style.pointerEvents = "";
  $("chapterPick").classList.remove("show");
  document.body.classList.remove("picking");
  // Letting go leaves you reading that chapter; it does not start playing
  // it. Tap a word to move the playhead. Abandoning puts back whatever you
  // were looking at before the reel opened.
  if (!commit) browseTo(cpPrevBrowse, "instant");
}

(() => {
  const track = $("track");

  track.addEventListener("pointerdown", e => {
    scrubChapter = -1;
    // A mouse held still on a slider means nothing; this is a touch gesture.
    if (!book || cpOpen || e.pointerType === "mouse") return;
    cpPointer = e.pointerId;
    cpOriginX = e.clientX; cpOriginY = e.clientY;
    cpCancelArm();
    cpPending = true;
    cpArmTimer = setTimeout(openChapterPick, CP_HOLD_MS);
  });

  track.addEventListener("pointermove", e => {
    if (cpPointer === null || e.pointerId !== cpPointer) return;
    if (!cpOpen) {
      // Still deciding. Distance from where the finger landed, not from the
      // last event: a slow drift would never trip a per-event threshold.
      if (Math.hypot(e.clientX - cpOriginX, e.clientY - cpOriginY) > CP_SLOP)
        cpCancelArm();
      return;
    }
    cpMoveTo(e.clientX);
    e.preventDefault();
  });

  track.addEventListener("pointerup", () => endChapterPick(true));
  track.addEventListener("pointercancel", () => endChapterPick(false));
})();

/* ------------------------------------------------------------ transport */

/* The bar browses. Only a deliberate jump moves the playhead.

   Dragging the scrub bar used to seek, which made "glance at what is
   coming" and "give up my place" the same gesture. Now the bar, the reader
   and the chapter picker move a *browse* position, and audio.currentTime
   moves only when you tap a word or press a transport control. The small
   mark on the track is where playback really is; the big thumb is where you
   are looking. They sit on top of each other until you go wandering. */

const clampT = t => Math.max(0, Math.min(book.duration - 0.1, t || 0));

/** A deliberate jump: the playhead really moves, and the view comes along. */
function playFrom(t) {
  if (!book) return;
  t = clampT(t);
  audio.currentTime = t;
  follow = true;
  lastWordTop = -1;
  showJump(false);
  browseTo(t, "instant");   // NB "instant": "auto" would defer to
                            // .reader{scroll-behavior:smooth} and animate.
  updateTimeline(t);
  setNow(wordAt(t));
  if (compact) renderLyric(t, true);
  playUi();
  savePosition();
}

/** Look somewhere else without disturbing playback. */
function browseTo(t, behavior) {
  if (!book) return;
  browseT = clampT(t);
  $("seek").value = Math.floor(browseT);
  scrollToTime(browseT, behavior || "instant");
}

/** Stop following the playhead — the view is the reader's now. */
function stopFollowing() {
  if (!follow) return;
  follow = false;
  showJump(true);
}

/** The readouts tied to the playhead rather than to where you are looking. */
function playUi() {
  if (!book) return;
  if (!editingClock) $("clockNow").textContent = clock(audio.currentTime);
  positionPlayMark();
}

/* The play mark moves every frame while playing, so it is worth not
   writing a style for sub-pixel changes nobody can see. */
let lastMarkPct = -1;
function positionPlayMark() {
  const el = $("playMark");
  if (!el || !book || !book.duration) return;
  const pct = audio.currentTime / book.duration * 100;
  if (Math.abs(pct - lastMarkPct) < 0.02) return;
  lastMarkPct = pct;
  el.style.left = `${pct}%`;
}

/* ------------------------------------------------- system media controls */

/* Drives the native media notification — the lock screen, the Now Bar and
   the home-screen media card — through SpineNative (see PlaybackService.kt).

   The standard navigator.mediaSession API was tried first and does nothing
   in a WebView: it accepts every call, and `dumpsys media_session` still
   reported "have 0 sessions" with audio confirmed playing. Chrome builds
   that notification in the browser process, which a WebView has no
   equivalent of, so the session has to be created on the Android side.

   The page stays the single source of truth for the playhead: these push
   state out, and SpineMedia below takes commands back in. */
window.SpineMedia = {
  play: () => startPlaying(),
  pause: () => stopPlaying(),
  nextChapter: () => $("nextCh").click(),
  prevChapter: () => $("prevCh").click(),
  forward: () => playFrom(audio.currentTime + 30),
  back: () => playFrom(audio.currentTime - 30),
  seekTo: ms => playFrom((+ms || 0) / 1000),
};

function pushMediaState() {
  const n = window.SpineNative;
  if (!n || !n.updateMedia || !book) return;
  const ch = book.chapters[chapterAt(audio.currentTime)];
  try {
    n.updateMedia(
      book.title || "Spine",
      ch ? ch.name : "",
      Math.round(audio.currentTime * 1000),
      Math.round((book.duration || 0) * 1000),
      !audio.paused,
      audio.playbackRate
    );
  } catch (e) {
    // an older build of the app without the bridge — the page still works
  }
}

audio.addEventListener("play", pushMediaState);
audio.addEventListener("pause", pushMediaState);
audio.addEventListener("ratechange", pushMediaState);
audio.addEventListener("seeked", pushMediaState);

/* Tap the elapsed clock to type a timecode — h:mm:ss, m:ss or plain
   seconds. Edited in place, the same way chapter names and the title are. */
/* Editing in place put the field right where the transport bar sits, at
   the bottom of the screen — exactly what an on-screen keyboard covers
   first. .clock-editing pins it near the top instead (see its CSS); a
   prior version computed a centred position from visualViewport here,
   which needed the keyboard to actually shrink that value to hold, and on
   a real device it didn't. Top-anchoring needs nothing computed. */
$("clockNow").onclick = () => {
  if (!book || editingClock) return;
  editingClock = true;
  const el = $("clockNow");
  el.contentEditable = "true";
  el.classList.add("clock-editing");
  el.focus();
  document.getSelection().selectAllChildren(el);
};
function commitClock(cancel) {
  if (!editingClock) return;          // committed already, or never started
  const el = $("clockNow");
  editingClock = false;
  el.contentEditable = "false";
  el.classList.remove("clock-editing");
  if (cancel) return playUi();
  const parts = el.textContent.trim().split(":").map(x => parseInt(x, 10));
  if (parts.length && parts.length <= 3 && parts.every(n => Number.isFinite(n))) {
    playFrom(parts.reduce((total, n) => total * 60 + n, 0));
  } else {
    toast("Use h:mm:ss");
    playUi();
  }
}
// commit from Enter directly rather than leaning on blur to fire — a
// soft keyboard dismissing doesn't always take focus with it
$("clockNow").onkeydown = e => {
  if (e.key === "Enter") { e.preventDefault(); commitClock(false); e.target.blur(); }
  else if (e.key === "Escape") { commitClock(true); e.target.blur(); }
};
$("clockNow").onblur = () => commitClock(false);

/* Play is the one button that gets a haptic. The rest don't: a tick under
   every tap stops meaning anything, and this is the press you make without
   looking. */
/* What the reader asked for, which is not the same as what the element is
   doing. Assigning audio.src runs the media load algorithm, which sets
   audio.paused to true and rejects any pending play() — and fires NO pause
   event. So the element cannot answer "did they want this playing?" across a
   reload, and a button that reads audio.paused goes on showing the pause
   glyph over a silent book. Measured on the web reader: press play into a
   restarted service worker's 503 and the press is eaten whole, which is the
   "I have to unpause twice". */
let wantPlaying = false;
/* True from the moment a recovery reassigns audio.src until the new
   source is ready. Reassigning src fires a pause, and by then the UA has
   already cleared audio.error — so 'are we mid-reload?' cannot be
   inferred from the element and has to be stated. Measured: without
   this, onpause clears the intent and the resume never happens. */
let reloading = false;

function syncPlayButton() {
  $("playPause").textContent = wantPlaying ? "❚❚" : "▶";
}

function startPlaying() {
  wantPlaying = true;
  syncPlayButton();
  const p = audio.play();
  /* play() rejects, and unhandled it reaches nothing but the console.
     AbortError is our own reload (or a pause) taking the source out from
     under it — expected, and already has a plan. Anything else means the
     press did not take, so the button must stop claiming otherwise. */
  if (p && p.catch) p.catch(err => {
    /* AbortError: our own reload took the source out from under it.
       NotSupportedError: the source failed to load — which the audio error
       handler is already recovering from, and which clears the intent itself
       if it runs out of retries. Clearing here instead would throw the press
       away before the recovery could carry it, which is the whole bug.
       Anything else — an autoplay refusal, say — genuinely did not take. */
    if (err.name === "AbortError" || err.name === "NotSupportedError") return;
    wantPlaying = false;
    syncPlayButton();
  });
}

function stopPlaying() {
  wantPlaying = false;
  syncPlayButton();
  audio.pause();
}

$("playPause").onclick = () => {
  haptic("press");
  /* Reads the intent, not audio.paused: a press while a play() is still in
     flight is "stop", not a second play() stacked on the first. */
  wantPlaying ? stopPlaying() : startPlaying();
};
audio.onplay = () => {
  wantPlaying = true;
  syncPlayButton();
  /* Play does not drag the view back. It is a request to hear this, not a
     request to stop reading whatever you had scrolled off to — and with the
     bar browsing rather than seeking, being somewhere else is an ordinary
     place to be. If you were still following, the page keeps up with the
     voice exactly as before; if you were not, the snap pill is already up
     and waiting. Either way playback carries on from the playhead, which
     scrolling never moved. */
  if (follow) {
    lastWordTop = -1;
    scrollToTime(audio.currentTime, "instant");
  }
  startSaving();
};
audio.onpause = () => {
  /* Not while a reload is in flight: that pause is ours, and letting it
     erase the intent is exactly how the resume goes silent. */
  if (!reloading && !audio.error) { wantPlaying = false; syncPlayButton(); }
  playUi(); stopSaving(); savePosition();
};
/* Two things can go wrong here that are not the file's fault, so the reader
   works through them before accusing it of anything.

   One: a service worker is allowed to be stopped whenever the browser feels
   like it, and comes back holding no audio — it answers 503 and the element
   errors. Hand the book over again and ask for the same URL.

   Two: the media element may never reach the service worker at all. That is
   a browser-by-browser question with a long and unhappy history in WebKit,
   and it cannot be settled by probing, because a page fetch takes a
   different route than a media load. So the second attempt asks for the
   blob directly, which needs no worker. Only if that fails too is there
   really something wrong with the audio. */
let audioRetry = 0;
audio.addEventListener("loadeddata", () => { audioRetry = 0; });
audio.onerror = () => {
  if (!book || !SpineLocal.hasAudio(book.id)) return;  // the missing-audio path speaks
  const again = mode => {
    const src = SpineLocal.audioUrl(book.id, mode);
    if (!src) return false;              // never "" — see loadBook
    audioRetry++;
    // A failed load resets the element, so the place to come back to is the
    // last one saved rather than whatever currentTime reads now.
    const at = audio.currentTime || book.position || 0;
    /* Assigning src runs the load algorithm, which sets paused = true and
       rejects the pending play() without firing pause — nothing here would
       ever see playback stop. Carry the intent across the reload; without it
       the press that met the 503 is eaten and you press play a second
       time. */
    const resume = wantPlaying;
    reloading = true;      // before src: the pause it fires is ours
    audio.src = src;
    seekWhenReady(at, resume);
    return true;
  };
  if (audioRetry === 0 && SpineLocal.reoffer && SpineLocal.reoffer(book.id) && again()) return;
  if (audioRetry <= 1 && again("direct")) return;
  reloading = false;
  wantPlaying = false;
  syncPlayButton();
  toast("This file will not play. It may be a format the player cannot decode.");
};

$("back30").onclick = () => playFrom(audio.currentTime - 30);
$("fwd30").onclick = () => playFrom(audio.currentTime + 30);
/* Chapter steps count from what you are *looking* at, not from where the
   voice is. While following they are the same thing, so nothing changes in
   the ordinary case — but once you have read ahead they are not, and
   counting from the playhead made these buttons yank the page backwards:
   reading in chapter 4 with the voice still in chapter 1, "next chapter"
   went to chapter 2. Measured exactly that — scrollTop 3119 back to 583.
   It reads as the text refusing to leave the playhead.

   They still commit: playFrom() moves the real playhead, the scrub mark and
   the lock-screen state to wherever you land, so this is navigation rather
   than browsing. Stepping the view without the audio is what scrolling and
   the scrub bar are already for. */
$("prevCh").onclick = () => {
  const ci = chapterAt(browseT);
  const back = browseT - book.chapters[ci].t < 3 ? ci - 1 : ci;
  playFrom(book.chapters[Math.max(0, back)].t);
};
$("nextCh").onclick = () => {
  const next = book.chapters[chapterAt(browseT) + 1];
  playFrom(next ? next.t : book.duration - 1);
};
/* One tick per chapter the thumb passes, so the bar can be read by feel
   with a thumb sitting on top of it instead of by eye. -1 means "no
   reading yet" — the first move of a drag must not tick. */
let scrubChapter = -1;
$("seek").oninput = e => {
  if (!book) return;
  /* A finger resting on the track is waiting for the chapter reel, not
     scrubbing. Put the thumb back where it was and ignore the drift —
     otherwise the few pixels a still finger wanders are worth twenty
     minutes of book, and the page lurches away right before the reel
     opens. Once the hold is cancelled or armed, this stops applying. */
  if (cpPending || cpOpen) { e.target.value = Math.floor(browseT); return; }

  const t = +e.target.value;
  stopFollowing();
  browseTo(t, "instant");
  const ci = chapterAt(t);
  if (scrubChapter >= 0 && ci !== scrubChapter) haptic("tick");
  scrubChapter = ci;
};
$("seek").onchange = () => { scrubChapter = -1; };

/* The label moves on every tap; the audio pipeline hears one change once you
   stop tapping. Cycling eight speeds with a finger meant eight rate changes
   in half a second, each one a re-buffer, and each one firing ratechange at
   the sleep timer and the lock screen too. Nothing downstream benefits from
   seeing the speeds you passed through on the way. */
let speedApply = null;
$("speed").onclick = () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $("speed").textContent = `${SPEEDS[speedIdx]}X`;
  clearTimeout(speedApply);
  speedApply = setTimeout(() => { audio.playbackRate = SPEEDS[speedIdx]; }, 180);
};

/* ------------------------------------------------------------ sleep timer */

/* Cycles like the speed button rather than opening a menu — it's the same
   kind of control and the tray has no room for a popover.
   Counted against audio.currentTime, not wall-clock: a timer set for twenty
   minutes should mean twenty minutes of *book*. A setTimeout would keep
   running while paused and cut the night short, and would drift against
   playback speed — at 1.5x, twenty minutes of listening is only about
   thirteen minutes of clock. "End of chapter" is the one people actually
   reach for, so it sits at the front. */
const SLEEP_OPTIONS = [
  { label: "Timer", mins: 0 },        // off
  { label: "Chapter", mins: -1 },     // stop at the next chapter mark
  { label: "10m", mins: 10 },
  { label: "20m", mins: 20 },
  { label: "30m", mins: 30 },
  { label: "45m", mins: 45 },
  { label: "1h", mins: 60 },
];
let sleepIdx = 0;
let sleepUntil = null;      // book time (seconds) at which to stop

function sleepLabel() {
  const opt = SLEEP_OPTIONS[sleepIdx];
  if (!sleepUntil) return opt.label;
  const left = Math.max(0, sleepUntil - audio.currentTime);
  if (left >= 3600) return `${Math.ceil(left / 3600)}h`;
  if (left >= 60) return `${Math.ceil(left / 60)}m`;
  return `${Math.ceil(left)}s`;
}

function setSleep(i) {
  sleepIdx = i % SLEEP_OPTIONS.length;
  const opt = SLEEP_OPTIONS[sleepIdx];
  let noChapterLeft = false;
  if (!book || opt.mins === 0) {
    sleepUntil = null;
  } else if (opt.mins === -1) {
    const next = book.chapters
      .map(c => c.t)
      .filter(t => t > audio.currentTime + 1)
      .sort((a, b) => a - b)[0];
    noChapterLeft = next === undefined;
    sleepUntil = noChapterLeft ? book.duration : next;
  } else {
    sleepUntil = audio.currentTime + opt.mins * 60;
  }
  $("sleep").classList.toggle("on", !!sleepUntil);
  $("sleep").textContent = sleepLabel();
  pushSleepDeadline();
  if (!sleepUntil) return;
  // Say which it actually is. Falling back to the end of the book without
  // mentioning it looks like the timer was ignored — the button jumps
  // straight to a countdown of hours when you asked for one chapter.
  toast(opt.mins !== -1 ? `Stopping in ${opt.label}`
        : noChapterLeft ? "No chapter after this one — stopping at the end of the book"
        : "Stopping at the next chapter");
}

$("sleep").onclick = () => setSleep(sleepIdx + 1);

/* checkSleep() used to run only inside the requestAnimationFrame loop, which
   is exactly the wrong place: the browser stops that loop when the window is
   hidden — on a phone, the moment the screen goes off — so the timer that is
   supposed to stop playback while you fall asleep never fired. timeupdate is
   driven by the audio pipeline instead of the render loop, so it keeps
   arriving while the screen is dark and playback continues. The interval is a
   second line of defence for anything that throttles timeupdate too. */
audio.addEventListener("timeupdate", () => checkSleep());
setInterval(() => { if (!audio.paused) checkSleep(); }, 1000);

/* And a third: hand the deadline to the foreground service, which Android
   keeps alive for the whole of playback even when it has frozen this page
   entirely. Wall-clock, so playback speed has to be divided out — twenty
   minutes of book at 1.5x is a thirteen-minute wait. Re-sent on anything that
   changes the arithmetic. */
function pushSleepDeadline() {
  const n = window.SpineNative;
  if (!n || !n.setSleepTimer) return;
  if (sleepUntil === null || audio.paused) { try { n.setSleepTimer(-1); } catch (e) {} return; }
  const left = Math.max(0, (sleepUntil - audio.currentTime) / (audio.playbackRate || 1));
  try { n.setSleepTimer(Math.round(left * 1000)); } catch (e) {}
}
["play", "pause", "ratechange", "seeked"].forEach(ev =>
  audio.addEventListener(ev, pushSleepDeadline));

/* Called from the playback loop. Fading out beats cutting off mid-word —
   the whole point is that you're falling asleep to it. */
function checkSleep() {
  if (sleepUntil === null || audio.paused) return;
  const left = sleepUntil - audio.currentTime;
  if (left > 0) {
    const want = sleepLabel();
    if ($("sleep").textContent !== want) $("sleep").textContent = want;
    audio.volume = left < 8 ? Math.max(0.05, left / 8) : 1;
    return;
  }
  audio.pause();
  audio.volume = 1;
  sleepUntil = null;
  sleepIdx = 0;
  $("sleep").classList.remove("on");
  $("sleep").textContent = SLEEP_OPTIONS[0].label;
  pushSleepDeadline();          // cancel the native backstop too
  toast("Sleep timer finished.");
}


// no window to resize on a phone — this is a plain layout toggle, unlike
// the desktop's pop-out (which also asks pywebview to shrink the window)
$("btnPop").onclick = $("btnPopExit").onclick = () => {
  compact = !compact;
  $("app").classList.toggle("compact", compact);
  $("transport").classList.remove("expanded");   // the reading view opens clean
  $("btnPop").title = compact ? "Back to the full page" : "Reading view";
  /* Both directions snap to the playhead, on the owner's explicit call —
     this used to carry whatever you had browsed ahead to across the switch.

     It also fixes a real bug rather than only changing a preference: going
     the other way, back to the page, used to do nothing at all here. While
     paused the highlight loop is not running, so the reader kept whichever
     word was lit when you left it, and the lit word and the playhead
     disagreed until something else happened to repaint. That is the
     "sometimes it doesn't update" — it was every time you left the reading
     view paused, and never when playing. */
  snapToPlayhead("instant");
  positionScrollRail();
};

$("page").onclick = e => {
  const w = e.target.closest(".w");
  if (!w) return;
  if (w.dataset.note !== undefined) {
    openNotePop({ kind: "edit", idx: +w.dataset.note });
    return;
  }
  playFrom(parseFloat(w.dataset.s));
};

/* Reading away from the playhead used to time out after 3.5 s and snap you
   back. That fought anyone deliberately reading ahead, and now that the bar
   browses rather than seeks, wandering off is a normal thing to be doing
   rather than an accident. Following resumes when you ask for it — the pill
   below is always there to ask with. */
function cpOpenSafe() { return cpOpen; }

/* What time is the reader currently looking at? Read by hit-testing the
   point scrollToTime() aims for, so scrolling back to a spot reports the
   time that would have put it there. A hit test is O(1); binary-searching
   91k word spans by offsetTop on every scroll event is not. */
function timeAtViewTop() {
  const reader = $("reader");
  const r = reader.getBoundingClientRect();
  const y = r.top + r.height * 0.32;
  const x = r.left + r.width * 0.5;
  const timeOf = node => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const w = el && el.closest && el.closest(".w[data-s]");
    return w ? parseFloat(w.dataset.s) : null;
  };
  /* caretRangeFromPoint snaps to the nearest text, which matters because the
     aim point lands in the gap between two paragraphs about as often as it
     lands on a word — elementFromPoint just returns .page there and tells
     you nothing. */
  if (document.caretRangeFromPoint) {
    const t = timeOf(document.caretRangeFromPoint(x, y)?.startContainer);
    if (t !== null) return t;
  }
  // and if even that misses, walk down the page a line at a time
  for (let dy = 0; dy <= 72; dy += 12) {
    for (const fx of [0.5, 0.3, 0.7]) {
      const t = timeOf(document.elementFromPoint(r.left + r.width * fx, y + dy));
      if (t !== null) return t;
    }
  }
  return null;
}

/* Scrolling is looking, and the thumb is where you are looking — so the bar
   has to come with the page. Coalesced onto a frame: scroll fires far more
   often than there are frames to draw, and each pass costs a hit test. */
let barSyncQueued = false;
function syncBarToView() {
  if (barSyncQueued || !book) return;
  barSyncQueued = true;
  /* A beat, not a frame. content-visibility:auto means the paragraphs you
     just scrolled onto are not laid out yet in the same frame as the scroll,
     and a hit test against unlaid-out content finds nothing — which read as
     "the thumb ignores scrolling" until it was measured. The delay doubles
     as the throttle: scroll fires far more often than this needs to run. */
  setTimeout(() => {
    barSyncQueued = false;
    if (!book || follow || cpOpenSafe()) return;
    const t = timeAtViewTop();
    if (t === null) return;
    browseT = clampT(t);
    $("seek").value = Math.floor(browseT);   // never scrollToTime here: that would
         // scroll the page we are reading the position from
  }, 50);
}

/* "The user is scrolling" has to actually mean the user.

   A scroll event on its own is not evidence of one. Coming back to a
   backgrounded Android WebView fires one — from the scroll position being
   restored, or from the window-inset listener re-padding the content — and
   so do rotating the phone and unfolding the Fold. Every one of those used
   to switch following off, and the result reads as the book losing sync:
   frame() goes on lighting the correct word, but setNow() returns before
   the scroll when follow is false, so the highlight is right and the page
   simply never moves. Reported as having to pause and resume to get the
   text back to the voice.

   autoScrollUntil already covers the scrolls this app causes itself. This
   covers the ones nobody caused at all. A real gesture leaves a mark within
   a few hundred milliseconds of the scroll it produces; a fling keeps firing
   touchmove until the finger leaves, and the coast afterwards only has to be
   inside the window for the first event, since following is already off by
   then. A mouse merely crossing the window is not a gesture, which is why
   pointermove only counts with a button held. */
const USER_SCROLL_GRACE = 1200;
let lastUserInput = 0;
const markUserInput = e => {
  if (e.type === "pointermove" && !e.buttons) return;
  lastUserInput = performance.now();
};
for (const ev of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart", "touchmove"])
  addEventListener(ev, markUserInput, { passive: true, capture: true });

$("reader").addEventListener("scroll", () => {
  const now = performance.now();
  if (now < autoScrollUntil) return;
  if (now - lastUserInput > USER_SCROLL_GRACE) return;
  stopFollowing();
  syncBarToView();
}, { passive: true });

/* Shown whenever the view has drifted off the playhead, playing or paused.
   Paused matters: with the bar browsing, "look somewhere, then get back"
   is the whole gesture, and there would otherwise be no way back. */
/* The pill sits a fixed gap above the transport, whatever height that is.
   It was pinned at a hard-coded offset, which was about right on a desktop
   bar and overlapped the phone's taller one — and stayed put when the phone's
   tray slid up, so the two collided. Measured instead: a ResizeObserver keeps
   it glued through the tray's animation without a timer, and there is no
   number to get wrong on a layout nobody has thought about yet. */
function positionJump() {
  const tp = $("transport"), pill = $("jumpNow");
  if (!tp || !pill) return;
  const h = tp.hidden ? 0 : tp.getBoundingClientRect().height;
  pill.style.bottom = `${Math.round(h + 18)}px`;
}
if (window.ResizeObserver) new ResizeObserver(positionJump).observe($("transport"));
window.addEventListener("resize", positionJump);
// ResizeObserver only reports during the rendering steps, which a page
// that is not being drawn does not always run — so the moments the bar
// actually changes height say so explicitly too.
$("transport").addEventListener("transitionend", positionJump);
positionJump();

function showJump(on) {
  const el = $("jumpNow");
  if (!el) return;
  el.classList.toggle("show", !!(on && book));
}

function snapToPlayhead(behavior) {
  if (!book) return;
  follow = true;
  lastWordTop = -1;
  showJump(false);
  browseT = audio.currentTime;
  $("seek").value = Math.floor(browseT);
  if (compact) { renderLyric(audio.currentTime, true); return; }
  /* Back on the page: scroll AND move the lit word. scrollToTime works out
     which word it is only to know what to scroll to — it never touches the
     highlight, so on its own this left whichever word was lit before still
     lit. While playing the frame loop corrects that within about 16ms and you
     never see it; while paused nothing does, and the wrong word just sits
     there. Same order playFrom() uses: scroll, then light. */
  scrollToTime(audio.currentTime, behavior || "smooth");
  setNow(wordAt(audio.currentTime));
}
$("jumpNow").onclick = () => snapToPlayhead();

/* Snap to the voice whenever the page comes back into view.

   Reported twice: leave the Android app, come back, and the text is no
   longer with the audio. The scroll-detector fix stopped `follow` being
   switched off by a phantom scroll, but that only keeps following *armed* —
   the page still does not move until the playhead crosses into the next
   word, and setNow() only scrolls on a change. After a spell in the
   background the right word is already lit, far below the viewport, and
   nothing has changed for it to react to.

   So say it outright rather than infer it. Coming back is a moment where
   you want to be shown where you are, and so is opening a book, and so is
   switching between the reader and the pop-out. Instant, not smooth: after
   a gap the distance is screens, and animating it reads as the page
   crawling. */
function snapOnReturn() {
  if (!book) return;
  follow = true;
  browseT = audio.currentTime;
  snapToPlayhead("instant");
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) setTimeout(snapOnReturn, 60);
});
addEventListener("pageshow", () => setTimeout(snapOnReturn, 60));


/* ------------------------------------------------- transport swipe tray */

/* On a phone the transport shows only the five arrows; the rest of the
   controls sit behind a swipe up (or a tap on the handle). */
(() => {
  const tp = $("transport"), grab = $("grab");
  let startY = null;
  const setOpen = on => { tp.classList.toggle("expanded", on); positionJump(); };

  grab.addEventListener("click", () => setOpen(!tp.classList.contains("expanded")));

  /* The whole bar is the gesture target, not just the handle — the handle is
     a 16px strip and aiming a thumb at it while walking is not realistic.
     The one exception is the scrub track: a swipe that starts on the slider
     has to stay a scrub, or opening the tray would drag the playhead across
     the book. .grab also carries an invisible taller hit area in CSS, so the
     strip above the handle counts without the handle itself getting bigger. */
  tp.addEventListener("touchstart", e => {
    if (e.target.closest("#seek")) { startY = null; return; }
    startY = e.touches[0].clientY;
  }, { passive: true });
  tp.addEventListener("touchend", e => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy < -24) setOpen(true);
    else if (dy > 24) setOpen(false);
  }, { passive: true });
})();

/* ------------------------------------------------------------ position */

function startSaving() {
  stopSaving();
  saveTimer = setInterval(savePosition, 5000);
}
function stopSaving() { clearInterval(saveTimer); saveTimer = null; }
function savePosition() {
  if (!book) return;
  book.position = audio.currentTime;
  api(`/api/position/${book.id}`, { t: audio.currentTime });
}
window.addEventListener("beforeunload", savePosition);

/* Tap sets the bookmark here; hold half a second and you go to it. One
   button for both because they are the same thought — "the place I want to
   come back to" — and the tray has no room for a second one. */
const BM_HOLD_MS = 500;
let bmHoldTimer = null, bmJumped = false;

/* A bookmark and a note are points in time. On the timeline they are marks;
   in the text they were nothing at all — so a note that happened to cover no
   word left no trace on the page, and the bookmark was invisible while
   reading. Both get a thin caret sitting between the words where they fall.

   Rebuilt rather than moved, because the page is rebuilt whenever the book
   is, and there are only ever a handful of these. */
/* Half the width of a space, in the reading face at its current size.

   The caret is inserted between two word spans, and each span carries its
   own leading space — so its origin is the left edge of the gap, not the
   middle of it, and the bar lands hard against the word before. Nudging it
   by half a space centres it. Measured rather than guessed at: the figure
   depends on the typeface and the size, both of which change between the
   desktop, the phone and the pop-out. */
function halfSpaceNudge(page) {
  const probe = t => {
    const s = document.createElement("span");
    s.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    s.textContent = t;
    page.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return w;
  };
  // "a a" minus "aa" — a lone space in a hidden span is not reliable
  const space = probe("a a") - probe("aa");
  return space > 0 ? space / 2 - 1 : 0;   // less half the 2px bar
}

function placeCarets() {
  document.querySelectorAll("#page .caret").forEach(el => el.remove());
  if (!book || !pw.el.length) return;
  const page = $("page");
  page.style.setProperty("--caret-nudge", `${halfSpaceNudge(page).toFixed(2)}px`);

  const drop = (t, cls, label) => {
    const i = wordAt(t);
    const el = pw.el[Math.max(0, i)];
    if (!el || !el.parentElement) return;
    const c = document.createElement("span");
    c.className = "caret " + cls;   // the bar itself is drawn in CSS
    c.title = label;
    el.after(c);
  };

  if (book.bookmark != null) drop(book.bookmark, "bm", `Bookmark · ${clock(book.bookmark)}`);

  /* Exactly the notes that light no word, decided by the same test
     renderBook uses — the two drifting apart is what put a bar on top of a
     highlight. A note over a phrase is already visible as the phrase. */
  (book.notes || []).forEach(n => {
    if (!(n.e > n.s)) drop(n.s, "nt", n.text || "Note");
  });
}

function updateBookmarkUi() {
  const btn = $("btnBookmark"), mark = $("bookMark");
  const at = book && book.bookmark != null ? book.bookmark : null;
  btn.classList.toggle("set", at !== null);
  btn.title = at !== null
    ? `Bookmarked at ${clock(at)} — hold to go there, tap to move it here`
    : "Save a bookmark to resume from later";
  if (!mark) return;
  mark.hidden = at === null;
  if (at !== null && book.duration) mark.style.left = `${at / book.duration * 100}%`;
}

$("btnBookmark").addEventListener("pointerdown", () => {
  bmJumped = false;
  clearTimeout(bmHoldTimer);
  if (!book || book.bookmark == null) return;
  bmHoldTimer = setTimeout(() => {
    bmJumped = true;                       // so the click that follows is not a set
    haptic("arm");
    playFrom(book.bookmark);
    toast(`Went to your bookmark at ${clock(book.bookmark)}`);
  }, BM_HOLD_MS);
});
["pointerup", "pointercancel", "pointerleave"].forEach(ev =>
  $("btnBookmark").addEventListener(ev, () => clearTimeout(bmHoldTimer)));

$("btnBookmark").onclick = async () => {
  if (bmJumped) { bmJumped = false; return; }   // that press was a jump
  if (!book) return;
  const t = audio.currentTime;
  const r = await api(`/api/bookmark/${book.id}`, { t });
  book.bookmark = r.bookmark;
  updateBookmarkUi();
  placeCarets();
  toast(`Bookmarked at ${clock(t)}`);
};

/* ------------------------------------------------------------ marks */

$("btnMark").onclick = async () => {
  if (!book) return;
  const t = audio.currentTime;
  book.chapters = [...book.chapters, { t, name: "New mark", auto: false }];
  await saveChapters();
  openChapters(t);
  toast(`Marked at ${clock(t)}`);
};

async function saveChapters() {
  const r = await api(`/api/chapters/${book.id}`, { chapters: book.chapters });
  book.chapters = r.chapters;
  buildPages(); drawTicks(); updateSubtitle();
  renderBook(audio.currentTime);
}

/* ------------------------------------------------------------------ notes */

/* Pinned near the top of the screen in CSS (see .note-pop) rather than
   positioned from here. A prior version centred it against whatever
   visualViewport reported as visible, which needed the keyboard to
   actually shrink that value to work — on a real device (Google's
   keyboard) it didn't, and the popover came back still covered, still
   off-centre. Top-anchoring needs no keyboard information at all, so
   there's nothing left to compute per-open. */
function openNotePop(mode) {
  notePopMode = mode;
  const pop = $("notePop"), text = $("notePopText");
  text.value = mode.kind === "edit" ? book.notes[mode.idx].text : "";
  $("notePopDelete").hidden = mode.kind !== "edit";
  pop.hidden = false;
  text.focus();
}
function closeNotePop() { $("notePop").hidden = true; notePopMode = null; }

$("notePopCancel").onclick = closeNotePop;
$("notePopSave").onclick = async () => {
  const txt = $("notePopText").value.trim();
  if (!txt) return closeNotePop();
  const notes = [...book.notes];
  if (notePopMode.kind === "edit") notes[notePopMode.idx] = { ...notes[notePopMode.idx], text: txt };
  else notes.push({ s: notePopMode.s, e: notePopMode.e, text: txt });
  await saveNotes(notes);
  closeNotePop();
};
$("notePopDelete").onclick = async () => {
  const notes = book.notes.filter((_, k) => k !== notePopMode.idx);
  await saveNotes(notes);
  closeNotePop();
};

async function saveNotes(notes) {
  const r = await api(`/api/notes/${book.id}`, { notes });
  book.notes = r.notes;
  renderBook();
  drawTicks();
}

function noteFromCurrentSelection() {
  if (compact || !$("notePop").hidden) return;
  const picked = selectedWordRange();
  if (!picked) return;
  window.getSelection()?.removeAllRanges();
  openNotePop({ kind: "new", ...picked });
}

$("page").addEventListener("mouseup", noteFromCurrentSelection);

/* A mouse reports mouseup at the exact moment a selection finishes, but a
   touch does not: dragging the little handles that adjust a touch
   selection fires selectionchange with no mouseup, no touchend and no
   pointerup at all on some combination of iOS Safari and Android Chrome —
   documented independently by multiple people trying to solve exactly
   this, not a guess. selectionchange is the one event both agree on, so
   this is the actual mobile equivalent of the listener above, not
   decoration alongside it — without it, selecting a phrase by touch and
   letting go does nothing until you separately remember the note button.

   Debounced because selectionchange fires on every pixel of the drag, and
   gated on a finger still being down so it cannot fire the popover open
   while a handle is mid-drag under the thumb — it only acts once the
   selection has actually stopped changing. */
let selDebounce = null, selPointerDown = false;
$("page").addEventListener("pointerdown", () => { selPointerDown = true; }, { passive: true });
addEventListener("pointerup", () => {
  selPointerDown = false;
  clearTimeout(selDebounce);
  noteFromCurrentSelection();
}, { passive: true });
document.addEventListener("selectionchange", () => {
  if (compact) return;
  clearTimeout(selDebounce);
  selDebounce = setTimeout(() => { if (!selPointerDown) noteFromCurrentSelection(); }, 300);
});

/* Note what you selected, or note where you are.

   Selecting words and then reaching for the button is the obvious way to
   make a note about a phrase, and it used to be ignored — the button always
   took the whole sentence being spoken, so a note meant to sit on one word
   lit up a paragraph. A selection wins; failing that it marks the word
   actually being read, not the sentence around it. */
$("btnNoteHere").onclick = () => {
  if (!book) return;
  const picked = selectedWordRange();
  if (picked) return openNotePop({ kind: "new", ...picked });
  const w = pw.el[nowIdx];
  const s = w ? parseFloat(w.dataset.s) : audio.currentTime;
  const e = w ? parseFloat(w.dataset.e) : audio.currentTime;
  openNotePop({ kind: "new", s, e });
};

/* The words the reader has selected, as a time range — or null. Shared by
   the button and the popover that appears on releasing a selection. */
function selectedWordRange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const page = $("page");
  if (!page.contains(range.commonAncestorContainer)) return null;

  // A selection dragged through text puts its ends inside word spans, and
  // this is all it takes.
  const edge = n => n && (n.nodeType === 1 ? n : n.parentElement)?.closest?.(".w[data-s]");
  let first = edge(range.startContainer);
  let last = edge(range.endContainer);

  /* But a double-click, a triple-click, or select-all put the boundary
     *between* elements instead, where there is no word to find — and the
     note then silently fell back to whatever was playing. Ask the range
     which words it actually touches.

     Scoped to the paragraphs it crosses, not the page: the whole book is
     91k word spans in one element, and asking each of them would be a
     visible pause on a selection. */
  if (!first || !last) {
    const segs = [...page.children].filter(sg => range.intersectsNode(sg));
    const words = segs.flatMap(sg => [...sg.querySelectorAll(".w[data-s]")])
                      .filter(w => range.intersectsNode(w));
    if (!words.length) return null;
    first = first || words[0];
    last = last || words[words.length - 1];
  }

  const s = parseFloat(first.dataset.s), e = parseFloat(last.dataset.e);
  return e > s ? { s, e } : null;
}

/* ------------------------------------------------------------ drawers */

const drawer = $("drawer"), scrim = $("scrim");
function openDrawer(title) {
  $("drawerTitle").textContent = title;
  $("drawerBody").classList.remove("lib");
  drawer.classList.add("open");
  scrim.classList.add("open");
}
function closeDrawer() { drawer.classList.remove("open"); scrim.classList.remove("open"); }
$("drawerClose").onclick = closeDrawer;
scrim.onclick = closeDrawer;

$("btnChapters").onclick = () => openChapters();

function openChapters(focusT) {
  if (!book) return toast("Import a book first.");
  openDrawer("Chapters");
  const body = $("drawerBody");
  body.innerHTML =
    `<p class="hint">Rename anything, delete what is wrong, and use <b>Mark here</b>
      in the player to add your own. Chapters are detected on the computer,
      before export — reopen there if you want different ones.</p>` +
    book.chapters.map((c, k) => {
      const onTimeline = !/^(start|end)$/i.test(c.name);
      const eye = onTimeline
        ? `<button class="row-eye${hiddenChapters.has(c.t) ? " off" : ""}"
             data-eye="${c.t}" title="Show or hide this on the timeline">${hiddenChapters.has(c.t) ? EYE_OFF_ICON : EYE_ICON}</button>`
        : "";
      return `
      <div class="row${c.auto ? "" : " mine"}" data-k="${k}">
        ${eye}
        <span class="row-t">${clock(c.t)}</span>
        <span class="row-n" data-k="${k}">${esc(c.name)}</span>
        <button class="row-go" data-go="${c.t}">go</button>
        <button class="row-x" data-del="${k}">✕</button>
      </div>`;
    }).join("");

  body.querySelectorAll("[data-eye]").forEach(b => b.onclick = () => {
    const t = parseFloat(b.dataset.eye);
    if (hiddenChapters.has(t)) hiddenChapters.delete(t); else hiddenChapters.add(t);
    b.classList.toggle("off");
    drawTicks();
  });

  body.querySelectorAll("[data-go]").forEach(b =>
    b.onclick = () => playFrom(parseFloat(b.dataset.go)));

  body.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    book.chapters.splice(+b.dataset.del, 1);
    await saveChapters();
    openChapters();
  });

  body.querySelectorAll(".row-n").forEach(n => {
    n.onclick = () => {
      n.contentEditable = "true";
      n.focus();
      document.getSelection().selectAllChildren(n);
    };
    n.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); n.blur(); } };
    n.onblur = async () => {
      n.contentEditable = "false";
      const name = n.textContent.trim();
      if (name && name !== book.chapters[+n.dataset.k].name) {
        book.chapters[+n.dataset.k].name = name;
        await saveChapters();
      }
      openChapters();
    };
  });

  if (focusT !== undefined) {
    const k = book.chapters.findIndex(c => Math.abs(c.t - focusT) < 0.5);
    const n = body.querySelector(`.row-n[data-k="${k}"]`);
    if (n) n.click();
  }
}

$("btnNotes").onclick = () => openNotes();

function openNotes() {
  if (!book) return toast("Import a book first.");
  openDrawer("Notes");
  const body = $("drawerBody");
  if (!book.notes.length) {
    body.innerHTML = `<p class="hint">Nothing marked yet. Select text in the reader
      — or use the notebook button in reading mode — to add one.</p>`;
    return;
  }
  body.innerHTML = book.notes.map((n, k) => `
    <div class="row" data-k="${k}">
      <button class="row-eye${hiddenNotes.has(n.s) ? " off" : ""}"
        data-eye="${n.s}" title="Show or hide this on the timeline">${hiddenNotes.has(n.s) ? EYE_OFF_ICON : EYE_ICON}</button>
      <span class="row-t">${clock(n.s)}</span>
      <span class="row-n">${esc(n.text)}</span>
      <button class="row-go" data-go="${n.s}">go</button>
      <button class="row-x" data-del="${k}">✕</button>
    </div>`).join("");
  body.querySelectorAll("[data-eye]").forEach(b => b.onclick = () => {
    const s = parseFloat(b.dataset.eye);
    if (hiddenNotes.has(s)) hiddenNotes.delete(s); else hiddenNotes.add(s);
    b.classList.toggle("off");
    drawTicks();
  });
  body.querySelectorAll("[data-go]").forEach(b =>
    b.onclick = () => { playFrom(parseFloat(b.dataset.go)); closeDrawer(); });
  body.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    const notes = book.notes.filter((_, k) => k !== +b.dataset.del);
    await saveNotes(notes);
    openNotes();
  });
}

/* ---------------------------------------------------------------- library */

/* Series that are folded shut. Kept in localStorage rather than in the book
   files: it is a per-device viewing preference, not a fact about the book, and
   it has no business travelling inside a phone bundle. */
const SERIES_SHUT = "spine.shutSeries";
const shutSeries = () => new Set(JSON.parse(localStorage.getItem(SERIES_SHUT) || "[]"));
const setShut = set => localStorage.setItem(SERIES_SHUT, JSON.stringify([...set]));

/* How the shelf is sorted, and — when it is sorted by hand — the order it was
   put in. Both live in localStorage for the same reason the folded-shut set
   above does: this is how you like looking at your own shelf on this device.
   Deliberately not in the book files, so nothing new travels in a bundle and
   this device's arrangement stays this device's. */
const LIB_SORT = "spine.libSort";
const LIB_ORDER = "spine.bookOrder";
const libSort = () => localStorage.getItem(LIB_SORT) || "recent";
const setLibSort = m => localStorage.setItem(LIB_SORT, m);
const libOrder = () => {
  try { return JSON.parse(localStorage.getItem(LIB_ORDER) || "[]"); } catch (e) { return []; }
};
const setLibOrder = ids => localStorage.setItem(LIB_ORDER, JSON.stringify(ids));

/* /api/library already arrives most-recently-played first, so "recent" is
   simply the order it came in and needs no work. */
function sortLibrary(items) {
  const mode = libSort();
  if (mode === "title")
    // numeric so "Book 2" sorts before "Book 10" rather than after it
    return [...items].sort((a, b) => (a.title || "").localeCompare(
      b.title || "", undefined, { numeric: true, sensitivity: "base" }));
  if (mode === "manual") {
    const at = new Map(libOrder().map((id, i) => [id, i]));
    /* A book you have never placed sorts above the ones you have, keeping its
       recently-played position among the other unplaced ones — a freshly
       imported book landing at the bottom of a long shelf is a book you will
       not find. Array.sort is stable, so returning 0 preserves that. */
    return [...items].sort((a, b) => {
      const ai = at.has(a.id) ? at.get(a.id) : -1;
      const bi = at.has(b.id) ? at.get(b.id) : -1;
      if (ai === bi) return 0;
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
  }
  return items;
}

let libraryItems = [];
let libraryQuery = "";
let dragBookId = null;       // the book a *mouse* is dragging, if any

/* A book being carried by a finger. Declared here, above renderLibrary, so
   the guard that drops a carried row when the list re-renders has real
   bindings to read. See "picking a book up with a finger" below. */
let rdRow = null;            // the row being carried, once the hold has armed
let rdArm = null;            // the row a finger is resting on, before it arms
let rdPointer = null;
let rdTimer = null, rdRaf = 0;
let rdX = 0, rdY = 0;                              // last finger position
let rdFromX = 0, rdFromY = 0, rdFromScroll = 0;    // where the gesture began
let rdMinDy = 0, rdMaxDy = 0;                      // how far it may be carried
let rdTarget = null;         // where it would land right now
let rdMark = "";             // ...as a string, so a tick only fires on a change
let rdEndedAt = 0;           // a lift must not also read as a tap on the row
let rdWasDraggable = false;

/* Where you are with a book. "Start" used to live in this slot; clicking the
   row already starts from the beginning of what you have not heard, so the
   button was spending a thumb's width saying something the row already said.

   Unlabelled reads "Status" in the same grey as its neighbours — a book you
   have not filed is the ordinary case and should not shout. Completed is the
   only one that gets a colour, because it is the only one you scan a shelf
   looking for. */
const STATUSES = [
  ["reading",   "Reading"],
  ["paused",    "Paused"],
  ["completed", "Completed"],
  ["dropped",   "Dropped"],
  ["",          "No status"],
];
const statusLabel = s => (STATUSES.find(x => x[0] === s) || ["", "Status"])[1];

const closeStatusMenu = () =>
  document.querySelectorAll(".status-menu").forEach(m => m.remove());

function statusBtnHtml(b) {
  const s = b.status || "";
  return `<button class="row-go status-btn${s ? " on s-" + s : ""}" data-status="${b.id}"
                  title="Where you are with this book">${esc(s ? statusLabel(s) : "Status")}</button>`;
}

function libRowHtml(b) {
  return `
      <div class="row stack lib-row" data-open="${b.id}">
        <span class="row-sub">${clock(b.position)} of ${clock(b.duration)} ·
          ${b.chapters} chapters${b.missing ? " · audio missing" : ""}</span>
        <div class="lib-head">
          <span class="row-n">${esc(b.title)}</span>
          <button class="row-go trash icon-btn" data-del-book="${b.id}" title="Remove from the library">${TRASH_ICON}</button>
        </div>
        <div class="lib-actions">
          ${statusBtnHtml(b)}
          <button class="row-go" data-open-at="${b.id}|last">Last Time</button>
          ${b.bookmark != null
            ? `<button class="row-go" data-open-at="${b.id}|bookmark">Bookmark · ${clock(b.bookmark)}</button>`
            : ""}
          <button class="row-go series-btn${b.series ? "" : " series-btn-empty"}" data-series="${b.id}"
                  title="Group this book into a series">${b.series ? esc(b.series) : PLUS_ICON}</button>
        </div>
      </div>`;
}

function renderLibrary() {
  // A re-render replaces the very row a finger is holding. Let go of it first.
  if (rdRow || rdArm) rdReset();
  const q = libraryQuery.trim().toLowerCase();
  const match = b => !q || (b.title || "").toLowerCase().includes(q)
                        || (b.series || "").toLowerCase().includes(q);
  /* Sorted before grouping, deliberately: the groups are built by walking
     this list in order, so a series ends up sitting wherever its first book
     landed and the whole thing follows from one sort. */
  const items = sortLibrary(libraryItems.filter(match));

  if (!libraryItems.length) {
    $("libList").innerHTML = `<p class="hint">Nothing here yet. Use the Import button (top right) to bring in a Phone bundle exported from Spine on your computer.</p>`;
    return;
  }
  if (!items.length) {
    $("libList").innerHTML = `<p class="hint">Nothing matches “${esc(libraryQuery)}”.</p>`;
    return;
  }

  /* Grouped in the library's own recently-played order: a series sits where
     its most recent book would have sat, so whatever you were last listening
     to stays near the top whether or not it belongs to a series. */
  const groups = [];
  const bySeries = new Map();
  for (const b of items) {
    if (!b.series) { groups.push({ solo: b }); continue; }
    let g = bySeries.get(b.series);
    if (!g) { g = { series: b.series, books: [] }; bySeries.set(b.series, g); groups.push(g); }
    g.books.push(b);
  }

  const shut = shutSeries();
  // A search should show what it found rather than make you open folders.
  const forceOpen = !!q;

  $("libList").innerHTML = groups.map(g => {
    if (g.solo) return libRowHtml(g.solo);
    const open = forceOpen || !shut.has(g.series);
    const started = g.books.filter(b => b.position > 30).length;
    return `
      <div class="series">
        <button class="series-head${open ? " open" : ""}" data-toggle="${esc(g.series)}">
          <span class="series-caret">${open ? "▾" : "▸"}</span>
          <span class="series-name">${esc(g.series)}</span>
          <span class="series-count">${g.books.length} book${g.books.length === 1 ? "" : "s"}${started ? ` · ${started} started` : ""}</span>
        </button>
        <div class="series-books" data-sname="${esc(g.series)}"${open ? "" : " hidden"}>${g.books.map(libRowHtml).join("")}</div>
      </div>`;
  }).join("");

  wireLibrary();
}

/* The suggestion list a series <input> offers, rebuilt from whatever
   series already exist in the library rather than kept as its own list —
   there's nothing here to fall out of sync with, since it's a name every
   book already carries a copy of. Created once and refreshed in place. */
function refreshSeriesOptions() {
  let list = document.getElementById("seriesOptions");
  if (!list) {
    list = document.createElement("datalist");
    list.id = "seriesOptions";
    document.body.appendChild(list);
  }
  const names = [...new Set(libraryItems.map(b => b.series).filter(Boolean))].sort();
  list.innerHTML = names.map(n => `<option value="${esc(n)}">`).join("");
}

/* ------------------------------------------------- dragging books about

   Two things at once, because they are the same gesture: dropping a book
   between two others reorders the shelf, and dropping it onto a series
   header — or among that series' own books — puts it in that series without
   going near the text field.

   Membership only ever gets *added* this way. Dragging a book out of a
   series and into open space does not clear its series: it stays where it
   belongs and its group moves instead, since a grouped book cannot be shown
   outside its own group. Clearing is what the text field is for, and a drag
   that silently un-filed a book would be a bad way to find that out. */

const clearDropMarks = () => {
  const list = $("libList");
  if (!list) return;          // the drawer has moved on to Chapters or Notes
  list.querySelectorAll(".drop-above,.drop-below,.drop-into")
      .forEach(el => el.classList.remove("drop-above", "drop-below", "drop-into"));
};

/* Where the shelf currently *looks* like it is, as ids. Taken from the whole
   library rather than what is on screen, so a first drag while sorted by
   recency captures that order for everything and only then applies the move
   — and so a drag while a search is filtering the list does not throw away
   the position of everything the filter is hiding. */
function moveBook(id, targetId, after) {
  const ids = sortLibrary(libraryItems).map(b => b.id).filter(x => x !== id);
  let at = targetId ? ids.indexOf(targetId) : -1;
  if (at < 0) at = ids.length; else if (after) at += 1;
  ids.splice(at, 0, id);
  setLibOrder(ids);
}

/* Commit a drop: the new position, and the series it was dropped into if it
   was dropped into one. Switches the sort to by-hand, because a shelf that
   silently re-sorted itself out from under a drag would make the drag look
   broken. */
async function dropBook(id, { targetId = null, after = false, series } = {}) {
  const wasSorted = libSort();
  moveBook(id, targetId, after);
  setLibSort("manual");
  const item = libraryItems.find(b => b.id === id);
  if (series !== undefined && item && item.series !== series) {
    const r = await api(`/api/series/${id}`, { series });
    item.series = r.series;
  }
  const sel = $("libSort");
  if (sel) sel.value = "manual";
  renderLibrary();
  if (wasSorted !== "manual") toast("Sorted by your order now.");
}

/* --- the mouse path: HTML5 drag-and-drop, for a laptop with a pointer --- */
function wireLibraryDrag() {
  const body = $("libList");

  body.querySelectorAll(".lib-row").forEach(row => {
    row.draggable = true;
    row.ondragstart = e => {
      /* Never start a drag out of a field being typed in — the title and the
         series field are both edited in place inside this row. */
      if (e.target.closest("input, [contenteditable='true']")) { e.preventDefault(); return; }
      dragBookId = row.dataset.open;
      /* A named type, never "Files". The window-level veil that catches a
         .spinebook dragged in from the desktop keys off "Files" being
         present, and rearranging a shelf must not raise it. */
      e.dataTransfer.setData("application/x-spine-book", dragBookId);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    };
    row.ondragend = () => { dragBookId = null; clearDropMarks(); row.classList.remove("dragging"); };

    row.ondragover = e => {
      if (!dragBookId || row.dataset.open === dragBookId) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const below = e.clientY > r.top + r.height / 2;
      clearDropMarks();
      row.classList.add(below ? "drop-below" : "drop-above");
    };
    row.ondrop = e => {
      if (!dragBookId || row.dataset.open === dragBookId) return;
      e.preventDefault();
      e.stopPropagation();          // or the list-level drop fires too
      const r = row.getBoundingClientRect();
      const below = e.clientY > r.top + r.height / 2;
      const id = dragBookId;
      dragBookId = null;
      // dropped among a series' own books, so it joins that series
      const inSeries = row.closest(".series-books");
      dropBook(id, {
        targetId: row.dataset.open, after: below,
        series: inSeries ? inSeries.dataset.sname : undefined,
      });
    };
  });

  // the header itself: joins the series and goes to the top of it
  body.querySelectorAll(".series-head").forEach(head => {
    head.ondragover = e => {
      if (!dragBookId) return;
      e.preventDefault();
      clearDropMarks();
      head.classList.add("drop-into");
    };
    head.ondrop = e => {
      if (!dragBookId) return;
      e.preventDefault();
      e.stopPropagation();
      const id = dragBookId;
      dragBookId = null;
      const name = head.dataset.toggle;
      const first = libraryItems.find(b => b.series === name && b.id !== id);
      dropBook(id, { targetId: first ? first.id : null, after: false, series: name });
    };
  });

  // past the last row: drop at the end
  body.ondragover = e => { if (dragBookId) e.preventDefault(); };
  body.ondrop = e => {
    if (!dragBookId) return;
    e.preventDefault();
    const id = dragBookId;
    dragBookId = null;
    dropBook(id, { targetId: null });
  };
}

/* ------------------------------------------ picking a book up with a finger

   HTML5 drag-and-drop is a mouse gesture. A finger produces no dragstart at
   all, so the shelf above simply is not draggable on a phone. This is the
   same two jobs as one thumb gesture, built the way the chapter picker is:
   press and hold, feel it arm, drag, lift to drop.

   It sits alongside the mouse path rather than replacing it — the same file
   serves a phone and a touchscreen laptop — and the two never meet, because
   this one returns on the first line for a mouse. Everything it commits goes
   through moveBook/dropBook, so there is one idea of what the order is.

   Half a second rather than the chapter picker's full one: on the scrub track
   a *short* hold is a legitimate scrub, so the timer there has to outlast it.
   A press on a library row that is not a tap has no other meaning, and a
   second per book is a long time when you are arranging a shelf. */

const RD_HOLD_MS = 500;   // past a tap, short of a wait
const RD_SLOP = 12;       // px of tremor tolerated before it counts as a scroll
const RD_EDGE = 72;       // this near the top or bottom of the list and it scrolls
const RD_EDGE_PX = 10;    // ...by this much a frame

function rdPlace() {
  if (!rdRow) return;
  /* The scroll delta is in here so the row stays under a still finger while
     the list auto-scrolls beneath it. */
  let dy = (rdY - rdFromY) + ($("drawerBody").scrollTop - rdFromScroll);
  /* Clamped to the list's own bounds, and this is not tidiness. A transformed
     box counts toward a scroller's scrollable overflow, so a row carried past
     the last one makes the drawer scrollable further than the shelf actually
     goes — measured at 2,922px of invented space and 2,903px of scrolling
     into nothing — and the instant the row comes back the browser clamps
     scrollTop and the whole list jumps (384px, measured). With the clamp: no
     extra overflow at all, scrolling stops at the true end, no jump. */
  dy = Math.max(rdMinDy, Math.min(rdMaxDy, dy));
  rdRow.style.transform = `translateY(${dy}px)`;
}

function rdAim() {
  if (!rdRow) return;
  /* .lifting carries pointer-events:none, which is what lets this see the row
     underneath the finger rather than the one being carried. */
  const el = document.elementFromPoint(rdX, rdY);
  const list = $("libList");
  let key = "";
  clearDropMarks();
  rdTarget = null;
  if (el && list && list.contains(el)) {
    const head = el.closest(".series-head");
    const row = el.closest(".lib-row");
    if (head) {
      head.classList.add("drop-into");
      rdTarget = { head: head.dataset.toggle };
      key = "into:" + head.dataset.toggle;
    } else if (row && row !== rdRow) {
      const r = row.getBoundingClientRect();
      const below = rdY > r.top + r.height / 2;
      row.classList.add(below ? "drop-below" : "drop-above");
      const grp = row.closest(".series-books");
      rdTarget = { id: row.dataset.open, after: below, series: grp ? grp.dataset.sname : undefined };
      key = row.dataset.open + (below ? "|b" : "|a");
    }
  }
  // one tick per slot crossed, and none for staying put — same as the picker
  if (key !== rdMark) { rdMark = key; if (key) haptic("tick"); }
}

/* Hold near either end of the drawer and it keeps scrolling on its own. Not
   optional, for the same reason the chapter picker's edge repeat is not: a
   shelf of any length does not fit in one thumb-throw, and "carry this book
   to the top" has to mean the top from anywhere.

   scrollTop is assigned directly, which is safe here and would not be on
   .reader — .drawer-body carries no scroll-behavior:smooth. */
function rdEdgeScroll() {
  rdRaf = 0;
  if (!rdRow) return;
  const sc = $("drawerBody"), r = sc.getBoundingClientRect();
  const dir = rdY < r.top + RD_EDGE ? -1 : rdY > r.bottom - RD_EDGE ? 1 : 0;
  if (dir) {
    const was = sc.scrollTop;
    sc.scrollTop = was + dir * RD_EDGE_PX;
    if (sc.scrollTop !== was) { rdPlace(); rdAim(); }
  }
  rdRaf = requestAnimationFrame(rdEdgeScroll);
}

function rdReset() {
  clearTimeout(rdTimer); rdTimer = null;
  cancelAnimationFrame(rdRaf); rdRaf = 0;
  if (rdArm) { rdArm.draggable = rdWasDraggable; rdArm = null; }
  if (rdRow) {
    try { rdRow.releasePointerCapture(rdPointer); } catch (e) { /* finger gone */ }
    rdRow.classList.remove("lifting");
    rdRow.style.transform = "";
    rdRow.draggable = rdWasDraggable;
    rdRow = null;
    rdEndedAt = performance.now();
  }
  rdPointer = null; rdTarget = null; rdMark = "";
  clearDropMarks();
}

function rdLift() {
  const row = rdArm;
  rdTimer = null; rdArm = null;
  if (!row || !row.isConnected) return;
  rdRow = row;
  rdTarget = null; rdMark = "";
  rdFromScroll = $("drawerBody").scrollTop;
  /* Measured before the transform exists, and valid for the whole gesture:
     dy already carries the scroll delta, so these stay true however far the
     list scrolls underneath. */
  const r = row.getBoundingClientRect(), lb = $("libList").getBoundingClientRect();
  rdMinDy = lb.top - r.top;
  rdMaxDy = lb.bottom - r.bottom;
  row.classList.add("lifting");
  /* Touch gives the element that got pointerdown an implicit capture; taking
     it explicitly keeps the moves coming to this row whatever the finger
     passes over, exactly as the chapter picker takes it on #track. */
  try { row.setPointerCapture(rdPointer); } catch (e) { /* finger gone */ }
  haptic("arm");
  rdPlace();
}

function rdDrop() {
  const t = rdTarget, id = rdRow && rdRow.dataset.open;
  rdReset();
  if (!t || !id) return;            // released over nothing: nothing moves
  if (t.head !== undefined) {
    const first = libraryItems.find(b => b.series === t.head && b.id !== id);
    return dropBook(id, { targetId: first ? first.id : null, after: false, series: t.head });
  }
  dropBook(id, { targetId: t.id, after: t.after, series: t.series });
}

function wireLibraryTouchDrag() {
  $("libList").querySelectorAll(".lib-row").forEach(row => {
    row.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse") return;      // a mouse has its own drag
      if (rdRow || rdArm) return;                 // one finger at a time
      /* Never out of a field being typed in, and never off one of the row's
         own buttons: resting a thumb on Status, Last Time, the series field
         or the trash for half a second must not pick the shelf up. */
      if (e.target.closest("input, textarea, button, [contenteditable='true']")) return;
      /* ...and not while anything in the list is mid-edit. Committing that
         edit re-renders the list out from under the gesture. */
      if ($("libList").querySelector("[contenteditable='true'], .series-btn.editing")) return;
      rdArm = row; rdPointer = e.pointerId;
      rdX = rdFromX = e.clientX; rdY = rdFromY = e.clientY;
      /* Windows Chrome will start its own HTML5 drag from a long press on a
         draggable element, which would fight this one for the same finger.
         Off for the length of this gesture only; a mouse never reaches here. */
      rdWasDraggable = row.draggable;
      row.draggable = false;
      rdTimer = setTimeout(rdLift, RD_HOLD_MS);
    });

    row.addEventListener("pointermove", e => {
      if (e.pointerId !== rdPointer) return;
      rdX = e.clientX; rdY = e.clientY;
      if (!rdRow) {
        // still waiting to arm: real movement means this was a scroll
        if (Math.hypot(rdX - rdFromX, rdY - rdFromY) > RD_SLOP) rdReset();
        return;
      }
      rdPlace();
      rdAim();
      if (!rdRaf) rdRaf = requestAnimationFrame(rdEdgeScroll);
    });

    row.addEventListener("pointerup", e => {
      if (e.pointerId !== rdPointer) return;
      if (rdRow) rdDrop(); else rdReset();
    });
    /* The system took the gesture — a call, a notification, or the browser
       deciding this was a scroll after all. Put it back untouched. */
    row.addEventListener("pointercancel", e => {
      if (e.pointerId !== rdPointer) return;
      rdReset();
    });
  });
}

function wireLibrary() {
  const body = $("libList");

  wireLibraryDrag();
  wireLibraryTouchDrag();

  body.querySelectorAll("[data-toggle]").forEach(h => h.onclick = e => {
    e.stopPropagation();
    const name = h.dataset.toggle;
    const set = shutSeries();
    if (set.has(name)) set.delete(name); else set.add(name);
    setShut(set);
    renderLibrary();
  });

  body.querySelectorAll("[data-open-at]").forEach(btn =>
    btn.onclick = e => {
      e.stopPropagation();
      const i = btn.dataset.openAt.indexOf("|");
      loadBook(btn.dataset.openAt.slice(0, i), btn.dataset.openAt.slice(i + 1));
    });
  body.querySelectorAll("[data-open]").forEach(r =>
    r.onclick = () => loadBook(r.dataset.open));

  /* Rename in place, the same way chapter names and the series field work.
     The row's own click opens the book, so this has to stop propagation or
     every rename would also start playback. */
  body.querySelectorAll(".lib-row .row-n").forEach(el => el.onclick = async e => {
    e.stopPropagation();
    if (el.isContentEditable) return;
    const id = el.closest("[data-open]").dataset.open;
    const cur = el.textContent.trim();
    el.contentEditable = "true";
    el.focus();
    document.getSelection().selectAllChildren(el);
    const commit = async save => {
      el.contentEditable = "false";
      const name = el.textContent.trim().slice(0, 200);
      if (!save || !name || name === cur) { el.textContent = cur; return; }
      const r = await api(`/api/title/${id}`, { title: name });
      const item = libraryItems.find(b => b.id === id);
      if (item) item.title = r.title;
      if (book && book.id === id) $("title").textContent = r.title;   // header too
      renderLibrary();
    };
    el.onblur = () => commit(true);
    el.onkeydown = ev => {
      if (ev.key === "Enter") { ev.preventDefault(); el.blur(); }
      if (ev.key === "Escape") { ev.preventDefault(); el.onblur = null; commit(false); }
    };
  });

  /* Keeping a copy. Offered per book rather than done for you: it is
     hundreds of megabytes, and it is the reader's disk. On Safari there are
     no file handles to remember, so this is the only way a book opens on a
     second visit without being handed the file again. */
  body.querySelectorAll("[data-keep]").forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const id = btn.dataset.keep;
    if (btn.classList.contains("on")) {
      await SpineLocal.dropCopy(id);
      btn.classList.remove("on");
      btn.textContent = "Keep offline";
      return toast("Copy removed. The book and your place are still here.");
    }
    const blob = SpineLocal.heldAudio(id);
    if (!blob) return toast("Open the book first, then keep a copy of it.");

    const room = await SpineLocal.spaceLeft();
    if (room && room.quota && blob.size > room.quota - room.used)
      return toast("Not enough room on this device for a copy.");

    btn.disabled = true;
    try {
      await SpineLocal.askPersist();
      await SpineLocal.keepCopy(id, blob, f => {
        btn.textContent = `Keeping ${Math.round(f * 100)}%`;
      });
      btn.classList.add("on");
      btn.textContent = "Kept";
      toast("Kept — this book will open on its own next time.");
    } catch (err) {
      btn.textContent = "Keep offline";
      toast("Could not keep a copy: " + ((err && err.message) || "out of room"));
    }
    btn.disabled = false;
  });

  /* No dialog and no separate list of series to maintain by hand. It is
     still a plain text field (typing a new name still makes a new series,
     clearing it still takes the book out), but it is an <input> with a
     native <datalist> of every series already in the library, so putting
     a second book into a series you already made means picking it rather
     than retyping it and risking a typo that quietly splits it into two. */
  refreshSeriesOptions();
  /* A little menu under the button rather than a cycling click: four states
     is too many to cycle through to reach the one you want, and cycling
     hides what the options even are. Built and thrown away per open, and
     positioned fixed against the button so the drawer's own scrolling
     cannot leave it stranded halfway up the list. */
  body.querySelectorAll("[data-status]").forEach(btn => btn.onclick = e => {
    e.stopPropagation();          // the row itself opens the book
    closeStatusMenu();
    const id = btn.dataset.status;
    const cur = (libraryItems.find(b => b.id === id) || {}).status || "";
    const menu = document.createElement("div");
    menu.className = "status-menu";
    menu.innerHTML = STATUSES.map(([v, label]) =>
      `<button class="status-opt${v === cur ? " on" : ""}${v ? " s-" + v : ""}" data-v="${v}">${label}</button>`
    ).join("");
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const h = menu.getBoundingClientRect().height;
    // flip above the button when there is no room below it
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.getBoundingClientRect().width - 8))}px`;
    menu.style.top = (r.bottom + h + 8 < innerHeight) ? `${r.bottom + 4}px` : `${r.top - h - 4}px`;

    menu.querySelectorAll("[data-v]").forEach(opt => opt.onclick = async ev => {
      ev.stopPropagation();
      const want = opt.dataset.v;
      closeStatusMenu();
      if (want === cur) return;
      const res = await api(`/api/status/${id}`, { status: want });
      const item = libraryItems.find(b => b.id === id);
      if (item) item.status = res.status;
      renderLibrary();
    });
    // one dismissal path for clicking anywhere else, added next tick so this
    // very click does not immediately close what it just opened
    setTimeout(() => document.addEventListener("click", closeStatusMenu, { once: true }), 0);
  });

  body.querySelectorAll("[data-series]").forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    const id = btn.dataset.series;
    const cur = (libraryItems.find(b => b.id === id) || {}).series || "";
    const input = document.createElement("input");
    input.className = "row-go series-btn editing";
    input.setAttribute("list", "seriesOptions");
    input.maxLength = 120;
    input.value = cur;
    /* The button stays in the row, holding its own space, and is only made
       invisible — the editor floats over it (see .series-btn.editing).
       Replacing it outright removed its width from a right-aligned row, so
       every other button slid sideways to take up the slack. */
    btn.classList.add("editing-src");
    btn.after(input);
    input.focus();
    input.select();
    /* The row's own click opens the book. The button this replaced carried
       the stopPropagation itself, so editing was safe; a fresh <input> has
       no handler, and without this, clicking the field — or its datalist
       arrow — loads the book and shuts the drawer mid-edit. */
    input.onclick = ev => ev.stopPropagation();
    let done = false;   // change fires on a datalist pick *and* again on blur
    const commit = async save => {
      if (done) return;
      done = true;
      const name = input.value.trim().slice(0, 120);
      if (!save || name === cur) return renderLibrary();
      const r = await api(`/api/series/${id}`, { series: name });
      const item = libraryItems.find(b => b.id === id);
      if (item) item.series = r.series;
      renderLibrary();
    };
    // picking from the dropdown is a finished answer, and it fires change
    // rather than blur — without this the pick just sits there looking unsaved
    input.onchange = () => commit(true);
    input.onblur = () => commit(true);
    input.onkeydown = ev => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") {
        ev.preventDefault();
        input.onblur = input.onchange = null;
        commit(false);
      }
    };
  });

  // two-step rather than a native confirm(): one tap arms it, the next
  // removes, and it disarms itself if you walk away
  body.querySelectorAll("[data-del-book]").forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "Sure?";
        btn.classList.add("danger");
        clearTimeout(btn._t);
        btn._t = setTimeout(() => {
          btn.dataset.armed = "";
          btn.innerHTML = TRASH_ICON;
          btn.classList.remove("danger");
        }, 4000);
        return;
      }
      const id = btn.dataset.delBook;
      await api(`/api/forget/${id}`, {});
      if (book && book.id === id) {      // it was the open one — clear the view
        book = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        $("page").innerHTML = "";
        $("blank").hidden = false;
        $("transport").hidden = true;
        $("title").textContent = "Spine";
        $("subtitle").textContent = "Nothing open";
      }
      toast("Removed from the library.");
      libraryItems = libraryItems.filter(x => x.id !== id);
      renderLibrary();
    };
  });
}

/* Two listeners on the drawer rather than on the rows, because both have to
   survive the list being re-rendered, and because a non-passive touchmove on
   anything bigger than this would tax scrolling everywhere — the reader in
   particular. #drawerBody outlives every render; only its contents change. */
$("drawerBody").addEventListener("touchmove", e => {
  /* What actually stops the list scrolling under a carried book. touch-action
     cannot: the browser fixes a gesture's scroll behaviour when the finger
     lands, long before the hold arms, and changing it mid-gesture does
     nothing. This works because the finger was still while the timer ran, so
     no scroll has begun and this move is still cancellable. */
  if (rdRow) e.preventDefault();
}, { passive: false });

$("drawerBody").addEventListener("click", e => {
  /* Arm the grab, think better of it, and lift straight up: the touch never
     moved, so the browser fires a click, and the row's own click opens the
     book. Everything else about that gesture was correctly a no-op. */
  if (performance.now() - rdEndedAt < 400) { e.stopPropagation(); e.preventDefault(); }
}, true);

$("btnLibrary").onclick = async () => {
  openDrawer("Library");
  // openDrawer only shows the panel — it doesn't touch drawerBody, so without
  // this the previous drawer's content (Chapters, Notes, or a stale Library
  // list) stays on screen for the length of this fetch.
  $("drawerBody").innerHTML = `<p class="hint">Loading…</p>`;
  libraryItems = await api("/api/library");
  $("drawerBody").innerHTML =
    `<label class="lib-find"><input id="libFind" type="search"
        placeholder="Search titles and series" autocomplete="off"></label>
     <div class="lib-sort">
       <label for="libSort">Sort</label>
       <select id="libSort">
         <option value="recent">Recently played</option>
         <option value="title">Title</option>
         <option value="manual">My order</option>
       </select>
       <span class="lib-sort-hint fine">Drag to reorder, or onto a series to file it</span>
       <span class="lib-sort-hint coarse">Hold a book to pick it up</span>
     </div>
     <div id="libList"></div>`;
  const find = $("libFind");
  find.value = libraryQuery;
  find.oninput = () => { libraryQuery = find.value; renderLibrary(); };
  const sort = $("libSort");
  sort.value = libSort();
  sort.onchange = () => { setLibSort(sort.value); renderLibrary(); };
  renderLibrary();

  /* Which build this is, and where it lives. A dev copy and an installed one
     are indistinguishable once open, and launching the wrong one is an easy
     way to spend an afternoon wondering why a fix did not take. */
  try {
    const a = await api("/api/about");
    $("drawerBody").classList.add("lib");
    const foot = document.createElement("p");
    foot.className = "lib-foot";
    foot.textContent = `Spine ${a.version} · ${a.kind}`;
    foot.title = `${a.path}
Click to check for an update`;
    /* Tap it to ask again. The startup check runs once, so anything released
       while the app was already open stays invisible until the next cold
       start — which reads as the updater being broken rather than merely
       early. */
    foot.onclick = async () => {
      if (foot.dataset.busy) return;
      foot.dataset.busy = "1";
      const was = foot.textContent;
      foot.textContent = "Checking…";
      let u = null;
      try { u = await api("/api/update/check", {}); } catch (e) { /* older build */ }
      foot.textContent = was;
      delete foot.dataset.busy;
      if (!u || u.state === "offline") return toast("Could not reach the update server.");
      if (u.state !== "available") return toast(`Spine ${a.version} is the latest.`);
      offerUpdate(u);
    };
    $("drawerBody").appendChild(foot);
  } catch (e) { /* older build without the endpoint — no footer, no harm */ }
};


/* ------------------------------------------------------------ find */

let findTimer = null;
$("find").oninput = e => {
  clearTimeout(findTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return;
  findTimer = setTimeout(() => runFind(q), 220);
};

function runFind(q) {
  if (!book) return;
  const needle = q.toLowerCase();
  const chapterHits = book.chapters
    .map((c, k) => ({ c, k }))
    .filter(x => x.c.name.toLowerCase().includes(needle))
    .slice(0, 40);
  const textHits = [];
  for (const s of book.segments) {
    const i = s.t.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    textHits.push({ t: s.s, snip: s.t, at: i });
    if (textHits.length >= 150) break;
  }

  openDrawer(`Found ${chapterHits.length + textHits.length}`);
  const mark = (text, at) =>
    esc(text.slice(0, at)) + "<mark>" + esc(text.substr(at, q.length)) +
    "</mark>" + esc(text.slice(at + q.length));

  $("drawerBody").innerHTML =
    (chapterHits.length
      ? `<p class="hint">Chapters</p>` + chapterHits.map(x => `
          <div class="row hit-row" data-t="${x.c.t}">
            <span class="row-t">${clock(x.c.t)}</span>
            <span class="row-n">${esc(x.c.name)}</span>
          </div>`).join("")
      : "") +
    (textHits.length
      ? `<p class="hint">In the text</p>` + textHits.map(h => `
          <div class="row hit-row" data-t="${h.t}">
            <span class="row-t">${clock(h.t)}</span>
            <span class="row-n">${mark(h.snip, h.at)}</span>
          </div>`).join("")
      : `<p class="hint">No match for "${esc(q)}".</p>`);

  $("drawerBody").querySelectorAll("[data-t]").forEach(r =>
    r.onclick = () => { playFrom(parseFloat(r.dataset.t)); closeDrawer(); });
}

/* ------------------------------------------------------------ title */

$("title").ondblclick = () => {
  if (!book) return;
  const h = $("title");
  h.contentEditable = "true"; h.focus();
  document.getSelection().selectAllChildren(h);
};
$("title").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } };
$("title").onblur = async e => {
  e.target.contentEditable = "false";
  const t = e.target.textContent.trim();
  if (book && t && t !== book.title) {
    const r = await api(`/api/title/${book.id}`, { title: t });
    book.title = r.title;
  }
  e.target.textContent = book ? book.title : "Spine";
};

/* ------------------------------------------------------------ keys */

document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA/.test(e.target.tagName) ||
    e.target.isContentEditable;
  if (e.key === "Escape") { closeDrawer(); $("notePop").hidden = true; e.target.blur?.(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault(); $("find").focus(); return;
  }
  if (typing || !book) return;

  if (e.key === " ") { e.preventDefault(); $("playPause").click(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); $("back30").click(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); $("fwd30").click(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); $("prevCh").click(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); $("nextCh").click(); }
  else if (e.key.toLowerCase() === "m") $("btnMark").click();
  else if (e.key.toLowerCase() === "s") $("speed").click();
});

/* pick up where the last session ended */
(async () => {
  try {
    const items = await api("/api/library");
    const last = Array.isArray(items) ? items.find(b => !b.missing) : null;
    if (last) {
      await loadBook(last.id);
    } else {
      $("blank").hidden = false;
    }
  } catch (e) {
    $("blank").hidden = false;
  }
})();

/* ------------------------------------------------------------ updates */

/* Two paths, the same as the desktop.

   A small one: the interface is served out of filesDir once patched, so new
   files there and a reload is the whole update. ~34 KB, no prompt, nothing
   to confirm.

   A big one: anything Kotlin changed, so the APK itself has to be replaced.
   Android cannot do that quietly — that is a platform rule, not an obstacle
   to route around. The most this can do is fetch the APK and open the
   system installer, which asks you itself. Android relaunches the app once
   you confirm, so there is no restart step to build on that side. */
(async () => {
  await new Promise(r => setTimeout(r, 2500));
  let u;
  try { u = await api("/api/update"); } catch (e) { return; }
  if (!u || u.state !== "available") return;
  if (sessionStorage.getItem("spine.skipUpdate") === u.version) return;
  offerUpdate(u);
})();

/* Put the banner up for a release we know about. Split out so the automatic
   check and the "check now" tap on the version line show the same thing — a
   re-check that found something must not be silent just because it was asked
   for by hand. */
function offerUpdate(u) {
  const small = !!u.canPatch;
  $("updateTitle").textContent = `Spine ${u.version} is available`;
  $("updateNotes").textContent = (u.notes || []).join(" · ");
  $("updateGo").textContent = "Update";
  $("update").hidden = false;

  $("updateLater").onclick = () => {
    sessionStorage.setItem("spine.skipUpdate", u.version);
    $("update").hidden = true;
  };

  $("updateGo").onclick = async () => {
    const btn = $("updateGo");
    btn.disabled = true;
    btn.textContent = small ? "Updating…" : "Downloading…";
    const r = await api(small ? "/api/update/web" : "/api/update/apk", {});
    if (r.error) {
      btn.disabled = false;
      btn.textContent = "Update";
      return toast(r.error);
    }
    $("update").hidden = true;
    if (!r.reload) return toast("Follow the prompt to finish installing.");
    // Save where we were first: the reload throws the page away, and the
    // position auto-save only runs every five seconds.
    savePosition();
    btn.textContent = "Restarting…";
    setTimeout(() => location.reload(), 400);
  };
}


/* Makes this openable from a home screen and openable offline. Registered
   last so a browser without it still runs everything above.

   The shell is served cache-first, which is what lets it open with no
   network — and it means the page you are looking at goes on being the old
   one after a release, even once the new worker has quietly installed
   underneath it. Bumping VERSION in sw.js is only half the job: it gets the
   *next* load right and leaves this one stale. That is not a hypothetical,
   it is how the code box appeared to be missing from a site that was
   serving it correctly.

   So: when a new worker takes over, reload once. `controllerchange` fires
   exactly then, and the guard is because a reload that races the handover
   would fire it again. The very first load also fires it — the page starts
   uncontrolled and the fresh worker claims it — and there is nothing stale
   to replace in that case, so it is skipped. */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => {
    const wasControlled = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!wasControlled || reloading) return;
      // Never pull the page out from under someone mid-book. A reload would
      // resume from the saved position, but it would still stop the voice
      // in the middle of a sentence for a cosmetic update — and the next
      // time they open it they get the new version regardless.
      if (typeof audio !== "undefined" && audio && !audio.paused) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ---------------------------------------------------- syncing your place
 *
 * A dot in the bar's top-right: verdigris and slowly pulsing when what is
 * here has been sent, oxide and pulsing faster when it has not, red when the
 * record has gone from the service. Tapping it opens the panel; tapping
 * anywhere else closes it.
 *
 * Nothing happens on a timer. Pressing the dot is the whole mechanism, so
 * between presses the service hears nothing at all — see the sync section of
 * app.py for why that was the point.
 */
let syncInfo = { };

function syncWhen(t) {
  if (!t) return "never";
  const d = new Date(t * 1000), now = Date.now() / 1000;
  const mins = Math.round((now - t) / 60);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago, ${clock}`;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `today at ${clock}`
                 : `${d.toLocaleDateString()} at ${clock}`;
}

async function refreshSync() {
  const wrap = $("syncWrap");
  if (!wrap) return;
  /* A backend that has no /api/sync yet hides the dot rather than offering a
     button that errors. Android's LocalServer does not serve these routes
     yet; the moment it does, the dot appears with no other change. */
  try {
    syncInfo = await syncApi("/api/sync");
    if (!syncInfo || syncInfo.error) throw new Error("no sync here");
  } catch (e) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const state = !syncInfo.code ? "" : syncInfo.lost ? "lost"
              : syncInfo.dirty ? "dirty" : "ok";
  wrap.className = "sync" + (state ? " " + state : "");
  $("syncLabel").textContent = !syncInfo.code ? "Sync"
    : syncInfo.lost ? "Code lost" : syncInfo.dirty ? "Unsynced" : "Synced";
}

/* The two lines that change while the panel is open. Kept apart from the
   markup because they are written again on their own — re-rendering the
   whole panel after every sync flickers, and wipes whatever is half-typed
   in the name field. */
function syncWhenLine(s) {
  if (s.busy) return "Syncing…";
  if (s.lost) return "The record is gone from the service.";
  return `Last synced ${esc(syncWhen(s.last))}${s.lastBy ? " by " + esc(s.lastBy) : ""}.`;
}

function syncCountLine(s) {
  if (s.shared === undefined) return "";
  return s.shared
    ? `Sharing ${s.shared} book${s.shared === 1 ? "" : "s"} with your other devices.`
    : "Nothing shared yet — press sync, or check the other device is on this same code.";
}

/* Which panel this is, rather than what it says: a code appearing or the
   record going missing changes the shape and needs a real redraw. Anything
   else is two lines of text. */
const syncShape = s => `${!!s.code}|${!!s.lost}`;
let syncDrawn = "";

function paintSync() {
  const pop = $("syncPop");
  if (!pop || pop.hidden) return;
  if (syncShape(syncInfo) !== syncDrawn) return openSyncPop();
  const w = pop.querySelector(".sync-when");
  if (w) w.innerHTML = syncWhenLine(syncInfo);
  const c = pop.querySelector(".sync-count");
  if (c) c.textContent = syncCountLine(syncInfo);
}

function syncPopHtml() {
  const s = syncInfo;
  if (!s.code) return `
    <p class="hint">Keep your place in step across your devices. One code,
      shared between them; nothing is sent until you press this.</p>
    <div class="sync-row">
      <button class="btn" id="syncNew">Start a code</button>
      <button class="btn ghost" id="syncJoinBtn">I have one</button>
    </div>
    <div id="syncJoinBox" hidden>
      <input id="syncJoinCode" placeholder="0000-0000-0000-0000-0000-0000-00"
             spellcheck="false" autocomplete="off">
      <div class="sync-row"><button class="btn" id="syncJoinGo">Join</button></div>
    </div>`;

  return `
    <p class="hint">This device is called</p>
    <input id="syncDevice" value="${esc(s.device || "")}" placeholder="Desktop"
           maxlength="40" spellcheck="false">
    <p class="sync-when">${syncWhenLine(s)}</p>
    ${s.lost ? "" : `<p class="sync-count">${syncCountLine(s)}</p>`}
    ${s.lost
      ? `<div class="sync-row"><button class="btn" id="syncRebuild">Start a new record</button></div>
         <p class="hint">Your positions are kept here and carry over. The other
           devices will need the new code.</p>`
      : `<div class="sync-row">
           <button class="btn" id="syncGo">Sync now</button>
           <button class="btn ghost" id="syncForget">Forget</button>
           <button class="btn ghost" id="syncJoinBtn">Another code</button>
         </div>
         <div id="syncJoinBox" hidden>
           <input id="syncJoinCode" placeholder="0000-0000-0000-0000-0000-0000-00"
                  spellcheck="false" autocomplete="off">
           <div class="sync-row"><button class="btn" id="syncJoinGo">Join</button></div>
         </div>`}
    <p class="hint">Your code</p>
    <p class="sync-code">${esc(s.code)}</p>
    <div id="syncPairs"></div>`;
}

function openSyncPop() {
  const pop = $("syncPop");
  pop.innerHTML = syncPopHtml();
  pop.hidden = false;
  syncDrawn = syncShape(syncInfo);

  $("syncNew")?.addEventListener("click", async () => {
    const r = await syncApi("/api/sync/new", {});
    if (r.error) return toast(r.error);
    await refreshSync(); openSyncPop();
  });
  $("syncJoinBtn")?.addEventListener("click", () => { $("syncJoinBox").hidden = false; });
  $("syncJoinGo")?.addEventListener("click", async () => {
    const r = await syncApi("/api/sync/join", { code: $("syncJoinCode").value });
    if (r.error) return toast(r.error);
    await refreshSync(); openSyncPop();
  });
  $("syncDevice")?.addEventListener("change", e => {
    const v = e.target.value.trim();
    // A code pasted into the name box. It is the first field in the panel
    // and looks like where a code goes, so this happens — and saving it
    // silently leaves the device called "01KZ-NC90-…" and the code
    // untouched, with nothing on screen explaining either.
    if (v.replace(/[^0-9A-Za-z]/g, "").length === 26 && /^[0-9A-Za-z-]+$/.test(v)) {
      e.target.value = syncInfo.device || "";
      $("syncJoinBox").hidden = false;
      $("syncJoinCode").value = v;
      return toast("That looks like a sync code — press Join to use it.");
    }
    syncApi("/api/sync/name", { name: v });
  });
  $("syncForget")?.addEventListener("click", async () => {
    await syncApi("/api/sync/forget", {}); await refreshSync(); closeSyncPop();
  });
  $("syncRebuild")?.addEventListener("click", async () => {
    const r = await syncApi("/api/sync/rebuild", {});
    if (r.error) return toast(r.error);
    toast(`New code made, carrying ${r.carried} books.`);
    await refreshSync(); openSyncPop();
  });
  $("syncGo")?.addEventListener("click", runSync);
}

/* The sync itself, from the dot or from the button in the panel. Guarded by
   syncBusy: pressing the dot starts one, and pressing "Sync now" a moment
   later must not start a second against the same record — the two would
   race for the same ETag and one of them would be told to try again. */
let syncBusy = false;

async function runSync() {
  if (syncBusy) return;
  syncBusy = true;
  $("syncWrap").className = "sync busy";
  $("syncLabel").textContent = "Syncing";
  syncInfo.busy = true;
  paintSync();
  let r;
  try { r = await syncApi("/api/sync/now", {}); }
  finally { syncBusy = false; syncInfo.busy = false; }
  await refreshSync();
  paintSync();
  if (!r || r.error) return toast((r && r.error) || "Could not sync.");
  if (r.forgotten) return;   // Forget was pressed while this was in flight
  if (r.lost) return toast("The sync record has gone.");
  const n = (r.pulled || []).length;
  toast(n ? `Brought ${n} book${n > 1 ? "s" : ""} up to date.` : "Everything is in step.");
  renderPairs(r.unmatched || []);
}

/* Books the other device has that nothing here answers to. Suggested by
   duration, because two rips of one audiobook agree to within a second while
   a title is editable and shared across a series. */
function renderPairs(list) {
  const box = $("syncPairs");
  if (!box || !list.length) { if (box) box.innerHTML = ""; return; }
  box.innerHTML = `<div class="sync-pair">
    <p class="hint">On your other device, but not matched here</p>
    ${list.map((u, i) => `
      <p class="sync-when">${esc(u.name || "Untitled")}</p>
      <select data-slot="${esc(u.slot)}">
        <option value="">Not one of mine — ask again</option>
        <option value="__drop">Not one of mine — remove it</option>
        ${(u.suggest || []).map(s =>
          `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("")}
        ${libraryItems.filter(b => !(u.suggest || []).some(s => s.id === b.id))
          .map(b => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join("")}
      </select>`).join("")}
  </div>`;
  box.querySelectorAll("select").forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    const row = sel.previousElementSibling;   // the name above it
    if (sel.value === "__drop") {
      const r = await syncApi("/api/sync/drop", { slot: sel.dataset.slot });
      if (r && r.error) return toast(r.error);
      if (row) row.remove();
      sel.remove();
      if (!box.querySelector("select")) box.innerHTML = "";
      return toast("Removed from the shared record.");
    }
    await syncApi("/api/sync/pair", { id: sel.value, slot: sel.dataset.slot });
    toast("Paired. It will follow from now on.");
  });
}

const closeSyncPop = () => { const p = $("syncPop"); if (p) p.hidden = true; };

/* One press: the panel opens on what is already known, and the sync it
   promises starts behind it.

   It used to await /api/sync before drawing anything — half a second on a
   real library — and then only open a panel, leaving the actual syncing to
   a second press on a button inside it. Both halves were reported: the
   press felt slow, and a code was made and never used because pressing the
   dot appeared to do nothing. */
$("syncDot").onclick = e => {
  e.stopPropagation();
  if (!$("syncPop").hidden) return closeSyncPop();
  openSyncPop();                     // instant, from what the dot already knows
  refreshSync().then(() => {
    if ($("syncPop").hidden) return;
    paintSync();                     // the fresh reading, without a rebuild
    if (syncInfo.code && !syncInfo.lost) runSync();
  });
};
// anywhere else dismisses it, which is the whole of its dismiss behaviour
document.addEventListener("click", e => {
  if (!$("syncPop").hidden && !e.target.closest("#syncWrap")) closeSyncPop();
});
addEventListener("load", refreshSync);

/* A sync when a chapter ends, and when you press the dot. Nothing else.

   Chapters are the right boundary: two or three an hour on an audiobook,
   against a dozen for pausing, and it is the moment your place in the book
   genuinely settles. A timer was rejected because a schedule hands a host a
   log of when you listen; this is quiet enough to keep most of that while
   meaning the other device is usually already right before you pick it up.

   The first chapter seen after opening a book does not sync — that would
   fire on every open, which is a timer wearing a different hat. */
let syncedChapter = -1;

async function quietSync() {
  // syncBusy as well as its own flag: the dot now starts a sync when it is
  // pressed, and a chapter ending a second later must not start a second
  // one against the same record — they would race for the same ETag and one
  // would be told to try again, for nothing.
  if (!syncInfo.code || syncInfo.lost || quietSync.busy || syncBusy) return;
  quietSync.busy = true;
  try { await syncApi("/api/sync/now", {}); await refreshSync(); }
  catch (e) { /* offline is not worth interrupting a book for */ }
  quietSync.busy = false;
}

function syncOnChapter(t) {
  if (!book || !syncInfo.code) return;
  const chs = book.chapters || [];
  if (chs.length < 2) return;
  let i = -1;
  for (let k = 0; k < chs.length; k++) if (chs[k].t <= t) i = k;
  if (i === syncedChapter) return;
  if (syncedChapter !== -1) quietSync();   // crossed one, rather than arrived
  syncedChapter = i;
}

/* ------------------------------------------- sync where the server has none
 *
 * The desktop answers /api/sync itself, and the web reader answers it in
 * shelf.js. Android does neither: its page talks to LocalServer, which has
 * no such route. So the page does it, and — this is the part that makes it
 * small — it needs no storage of its own. Everything it wants is already a
 * route the phone serves: /api/library carries every book's position,
 * duration and positionAt, /api/position writes one back, and
 * /api/syncslot remembers a pairing.
 *
 * Native was never necessary here, unlike sharing. A bundle is hundreds of
 * megabytes and has to be handled where the storage is; a sync record is a
 * few hundred bytes and jsonblob answers Access-Control-Allow-Origin:*, so
 * the page can fetch and PUT it directly.
 *
 * syncApi() prefers the backend and falls back to this. It decides once:
 * a server without the route makes api() throw, which is unambiguous, and
 * after that there is no point asking again.
 */
const SYNC_AT = "https://jsonblob.com/api/jsonBlob/{id}";
const SYNC_NEW = "https://jsonblob.com/api/jsonBlob";
const SYNC_LS = "spine.sync";
const SYNC_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SYNC_NEAR = 3.0;          // two rips of one book agree within a second

let syncBackend = null;         // null unknown, true theirs, false ours

async function syncApi(path, body) {
  if (syncBackend !== false) {
    try {
      const r = await api(path, body);
      if (r && typeof r === "object") { syncBackend = true; return r; }
    } catch (e) { /* no such route here */ }
    syncBackend = false;
  }
  return localSync(path, body);
}

const lsSync = () => { try { return JSON.parse(localStorage.getItem(SYNC_LS)) || {}; }
                       catch (e) { return {}; } };
const lsSave = s => localStorage.setItem(SYNC_LS, JSON.stringify(s));
const lsDevice = () => (lsSync().device || "").trim() || "This device";

function lsCode(uuid) {
  let n = BigInt("0x" + uuid.replace(/-/g, "")), out = "";
  for (let i = 0; i < 26; i++) { out = SYNC_B32[Number(n & 31n)] + out; n >>= 5n; }
  return out.match(/.{1,4}/g).join("-");
}
function lsBlob(code) {
  const clean = (code || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (clean.length !== 26) throw new Error("That sync code is not the right length.");
  let n = 0n;
  for (const raw of clean) {
    const ch = { I: "1", L: "1", O: "0", U: "0" }[raw] || raw;
    const v = SYNC_B32.indexOf(ch);
    if (v < 0) throw new Error('"' + raw + '" is not part of a Spine code.');
    n = (n << 5n) | BigInt(v);
  }
  const h = n.toString(16).padStart(32, "0").slice(-32);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
}

/* Conditional writes, as in app.py and shelf.js: the tag from the read is
   sent back with the write, so a stale read is refused rather than allowed
   to overwrite a fresher one. Losing the race asks for another press, which
   is the honest answer — the other device's reading is as real as ours. */
let lsTag = "";
async function lsGet(id) {
  const r = await fetch(SYNC_AT.replace("{id}", id));
  if (r.status === 404 || r.status === 410) { const e = new Error("lost"); e.lost = true; throw e; }
  if (r.status === 429) throw new Error("The sync service is asking us to slow down. Try again in a minute.");
  if (!r.ok) throw new Error("The sync service answered " + r.status + ".");
  lsTag = r.headers.get("ETag") || "";
  return r.json();
}
async function lsPut(id, payload) {
  const headers = { "Content-Type": "application/json" };
  if (lsTag) headers["If-Match"] = lsTag;
  const r = await fetch(SYNC_AT.replace("{id}", id), {
    method: "PUT", headers, body: JSON.stringify(payload) });
  if (r.status === 412 || r.status === 429)
    throw new Error("Another device synced while this one was working. Press sync again.");
  if (!r.ok) throw new Error("The sync service answered " + r.status + ".");
}
async function lsNew(books) {
  const r = await fetch(SYNC_NEW, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, books: books || {} }) });
  const id = (r.headers.get("Location") || "").replace(/\/$/, "").split("/").pop();
  if (!id) throw new Error("The sync service did not give us a place to put it.");
  return id;
}

async function localSync(path, body) {
  const s = lsSync();
  const rest = path.replace("/api/sync", "").replace(/^\//, "");
  const shelf = await api("/api/library");
  const slots = {};
  for (const b of shelf) slots[b.syncSlot || b.id] = b;

  if (!rest) {
    const dirty = shelf.some(b => (b.positionAt || 0) > (s.last || 0));
    return { code: s.id ? lsCode(s.id) : null, device: s.device || "",
             last: s.last || 0, lastBy: s.lastBy || "", lost: !!s.lost,
             dirty: !!s.id && dirty, books: shelf.length,
             // from the mirror, so the phone can say it too — zero here on a
             // device that has pushed books is two devices on two codes
             shared: Object.keys(s.mirror || {}).length };
  }
  if (rest === "name") {
    const was = (s.device || "").trim();
    s.device = String(body.name || "").trim().slice(0, 40);
    lsSave(s);
    const now = lsDevice();
    // Entries keep the name that wrote them, which is right for another
    // device and wrong for this one under an old name — the panel then goes
    // on crediting a name you have just renamed away from. Cosmetic, so a
    // failure here never fails the rename itself.
    if (s.id && was && was !== now) {
      try {
        const books = (await lsGet(s.id)).books || {};
        const hits = Object.keys(books).filter(k => (books[k].by || "") === was);
        if (hits.length) {
          hits.forEach(k => { books[k].by = now; });
          await lsPut(s.id, { v: 1, books });
          s.mirror = books;
          if ((s.lastBy || "") === was) s.lastBy = now;
          lsSave(s);
        }
      } catch (e) { /* renamed here, and the next sync relabels the rest */ }
    }
    return { device: now };
  }
  if (rest === "forget") { localStorage.removeItem(SYNC_LS); return { ok: true }; }
  if (rest === "new") {
    try { lsSave({ id: await lsNew(), last: 0, device: s.device || "" });
          return { code: lsCode(lsSync().id) }; }
    catch (e) { return { error: e.message }; }
  }
  if (rest === "join") {
    try { const id = lsBlob(body.code); await lsGet(id);
          lsSave({ id, last: 0, device: s.device || "" }); return { code: lsCode(id) }; }
    catch (e) { return { error: e.lost ? "There is nothing at that code any more." : e.message }; }
  }
  if (rest === "rebuild") {
    try { s.id = await lsNew(s.mirror || {}); s.lost = false; lsSave(s);
          return { code: lsCode(s.id), carried: Object.keys(s.mirror || {}).length }; }
    catch (e) { return { error: e.message }; }
  }
  if (rest === "drop") {
    if (!s.id || !body.slot) return { error: "Nothing to remove." };
    try {
      const books = (await lsGet(s.id)).books || {};
      if (!(body.slot in books)) return { ok: true, gone: true };
      delete books[body.slot];
      await lsPut(s.id, { v: 1, books });
      s.mirror = books; lsSave(s);
      return { ok: true };
    } catch (e) {
      return { error: e.lost ? "The sync record is gone from the service." : e.message };
    }
  }
  if (rest === "pair") {
    await api("/api/syncslot/" + body.id, { slot: body.slot || "" });
    return { ok: true };
  }
  if (rest === "now") {
    if (!s.id) return { error: "No sync code yet." };
    const now = Math.floor(Date.now() / 1000);
    let remote;
    try { remote = (await lsGet(s.id)).books || {}; }
    catch (e) {
      if (!e.lost) return { error: e.message };
      s.lost = true; lsSave(s);
      return { lost: true, carried: Object.keys(s.mirror || {}).length,
               error: "The sync record is gone from the service." };
    }

    const who = lsDevice(), pulled = [];
    for (const slot of Object.keys(slots)) {
      const b = slots[slot];
      const mine = { name: b.title || "", pos: +(b.position || 0),
                     dur: +(b.duration || 0), at: b.positionAt || 0, by: who };
      const theirs = remote[slot];
      /* Newest wins, per book. Not furthest: going back to re-hear a chapter
         is deliberate and must not be undone by a stale reading. */
      if (theirs && (theirs.at || 0) > mine.at) {
        await api("/api/position/" + b.id, { t: +(theirs.pos || 0) });
        pulled.push(b.title || slot);
        // the write stamps its own positionAt, so this device is now the
        // most recent writer — which is true, and keeps the record honest
        remote[slot] = { ...theirs, at: Math.floor(Date.now() / 1000), by: who };
      } else {
        if (!theirs || mine.at > (theirs.at || 0)) remote[slot] = mine;
      }
    }
    for (const b of shelf) if (b.syncSlot && b.syncSlot !== b.id) delete remote[b.id];

    try { await lsPut(s.id, { v: 1, books: remote }); }
    catch (e) { return { error: e.message }; }

    // Forgotten, or paired to another code, while this ran — the dot starts
    // a sync when it is pressed, so "press the dot, press Forget" is the
    // ordinary way to use the panel. Saving our copy of the state here put
    // the forgotten code straight back. Same guard as app.py's.
    if ((lsSync().id || "") !== s.id) return { ok: true, forgotten: true, pulled, pushed: [] };

    const all = Object.keys(remote).map(k => remote[k]);
    s.last = Math.max.apply(null, [now].concat(all.map(e => e.at || 0)));
    s.mirror = remote;
    s.lost = false;
    s.lastBy = (all.slice().sort((a, c) => (c.at || 0) - (a.at || 0))[0] || {}).by || who;
    lsSave(s);

    const free = shelf.filter(b => !b.syncSlot);
    const unmatched = Object.keys(remote).filter(k => !slots[k]).map(slot => {
      const e = remote[slot];
      return { slot, name: e.name || "", pos: e.pos || 0, dur: e.dur || 0,
               suggest: free
                 .filter(b => e.dur && Math.abs((b.duration || 0) - e.dur) <= SYNC_NEAR)
                 .slice(0, 4).map(b => ({ id: b.id, title: b.title, duration: b.duration })) };
    });
    return { ok: true, last: s.last, by: s.lastBy, pulled, pushed: [], unmatched };
  }
  return { error: "No such sync route." };
}
