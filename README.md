# Spine

**An audiobook reader that shows you the words as you hear them.**

Point Spine at an audiobook and it listens to the whole thing once, writing down
every word and exactly when it is spoken. After that, playing the book gives you
the text on screen with the current word lit up — the way a lyric video follows
a song. You can read along, skim ahead, search the whole book for a half-remembered
phrase, and tap any word to jump to that moment.

Everything happens on your own computer. There is no account, no subscription and
no server — your books never leave the machine.

This repository is only where the downloads live. The source is private.

---

## Read a book right now, with nothing to install

**[Open the web reader →](https://adistantpast.github.io/spine-releases/)**

Drop a `.spinebook` onto that page and read it. It works in any browser — a
Mac, an iPhone, a Windows PC, a Chromebook — and there is nothing to install,
no account, and no upload. The file is read from your own device; there is no
server for it to go to.

It plays and reads books; it does not make them. Transcribing a new book is
what the Windows app below is for.

### Make it an app

The reader can install itself, with no app store and nothing to approve:

| | |
|---|---|
| **Mac, Safari** | **File → Add to Dock** |
| **Mac, Chrome or Edge** | the install icon in the address bar |
| **iPhone or iPad** | Share → **Add to Home Screen** |
| **Windows, Chrome or Edge** | the install icon in the address bar |

You get a real icon, its own window with no browser around it, and it opens
offline.

**Do this before you settle in with a book.** It is not decoration. Browsers
are allowed to clear a website's stored data when space runs short, and
Safari clears it after seven days of not visiting — but an installed app is
treated as software rather than a website and is left alone. Installing is
what makes the next part stick.

### Keep a book on the device

Open a book, then in **Library** tick **Keep offline** next to it.

Without this the reader remembers the book — the words, chapters, notes and
your place — but not the audio, because the audio is hundreds of megabytes
and it was only ever reading your file where it sat. So it would ask for the
file again each visit.

With it, the book opens on its own, offline, straight back to where you were.
Untick it whenever you want the space back; your place and notes stay.

---

## Download

| | |
|---|---|
| **Windows** | `Spine-Installer-<version>.exe` from [the latest release](../../releases/latest) |
| **Android** | `Spine-<version>.apk` from the same place |

The `Spine-Update-*.zip` files are not for downloading by hand — Spine fetches
those itself when a small update is available.

### Installing on Windows

Double-click the installer. It installs just for you, so there is no
administrator prompt.

Two things you are likely to hit the first time:

- **"Windows protected your PC."** Click **More info**, then **Run anyway**.
  This appears because the installer is not signed with a paid code-signing
  certificate, not because anything is wrong with it.
- **On Windows 10 you may be asked to install the WebView2 runtime.** Spine
  draws its window with it and will not open without it. The installer checks,
  and links you to Microsoft's free download. Windows 11 already has it.

### Installing on Android

Open the `.apk` and let Android install it. It will ask you to allow installing
apps from wherever you downloaded it — that permission only lets the file be
opened, and you can turn it back off afterwards.

---

## What you get

**Read along with the narrator.** Every word is highlighted as it is spoken.
Tap any word to start playing from there.

**Chapters, found by listening.** Spine picks up the narrator saying "Chapter
Four" or "Prologue" and builds a chapter list from it. It gets most of them, and
you can rename, delete or add your own — the chapter numbers sit along the
timeline where they actually fall, so you can see how far in you are.

**A scrub bar that browses.** Dragging it moves the page, not your place. You
can look ahead at what is coming, or back at something you missed, and
playback carries on from where it was. A small mark on the bar shows where the
audio actually is, and "Snap to playhead" brings you back.

**Notes and bookmarks.** Select any passage to attach a note; notes appear as
green marks on the timeline. One bookmark per book, in red, for the place you
want to return to.

**Search the whole book,** by chapter name or by anything anyone said.

**Your place is kept,** per book, automatically.

**A sleep timer** that keeps working with the screen off.

**A compact view** — one sentence at a time, large. On Windows it pops out into
a small window you can leave in a corner.

---

## The phone app

The Android app is a **player, not a transcriber**. Phones are not fast enough
to do the listening part in a reasonable time, so the work happens once on the
computer and the finished book is carried across.

1. On Windows, open the book and choose **Export → Phone bundle**. You get a
   single `.spinebook` file — the audio plus everything Spine worked out about it.
2. Copy that file to your phone.
3. In the phone app, tap **Import** and pick it.

Everything else works the same: reading along, chapters, notes, bookmarks,
search, resume. It also puts proper playback controls on your lock screen and
in the notification shade, and it vibrates gently as you cross a chapter while
scrubbing.

Hold the scrub bar for a second and a reel of chapter numbers comes up — drag
left or right to spin through the book, let go to land.

---

## Updates

Spine checks for updates when it starts, and you can ask it to check again at
any time by tapping the version line at the bottom of the Library.

There are two kinds:

- **A small update (about 40 KB)** — most of them. Spine downloads it, swaps the
  files and restarts itself. On the phone this happens without reinstalling
  anything.
- **A full update (about 1 GB)** — only when the engine underneath changes. This
  runs the installer again.

Both are checked against a SHA-256 hash before anything is replaced.

---

## What it needs

**Windows:** Windows 10 or 11, 64-bit. An NVIDIA graphics card makes the
one-time transcription many times faster, but it is not required — without one
Spine falls back to the processor and simply takes longer.

**Android:** Android 8 or newer.

**Internet, once.** The first time you transcribe a book, Spine downloads the
speech model it uses (a few GB). After that it is cached and everything works
offline, including playback and reading.

**Disk space.** The Windows app is large, around 2 GB installed, because the
speech engine and its GPU libraries ship inside it.

---

## Where your library is kept

`%LOCALAPPDATA%\Spine` on Windows — one file per book holding the words, the
chapters, your notes and your position. Your actual audio files are never
copied or moved; Spine only remembers where they are.

Uninstalling asks before deleting any of that, because transcribing a long book
again takes a while.

---

## If something goes wrong

Spine writes what it is doing to `%LOCALAPPDATA%\Spine\spine.log`. If it will
not open, or a book fails to transcribe, that file explains why and is the
useful thing to send on.

A few common ones:

- **It opens and immediately closes** — almost always the missing WebView2
  runtime. Install it from Microsoft and try again.
- **Transcribing is very slow** — it is running on the processor rather than the
  graphics card. The log says which. It still works; it just takes longer.
- **A file will not play** — Spine plays mp3, m4a, m4b, mp4, wav, flac, ogg and
  aac. Anything else needs converting first.

---

## A fair warning about the text

The words on screen are what a speech model heard, not the publisher's text. It
is very good, but it guesses at names and invented spellings, adds its own
punctuation, and now and then writes something during a silence that nobody
said. It is excellent for following along and for searching. It is not a
substitute for the ebook.
