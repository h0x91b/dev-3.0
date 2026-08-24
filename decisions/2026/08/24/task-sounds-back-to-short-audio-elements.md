# Task sounds go back to `<audio>`, kept short enough to leave the media keys alone

## Context

Task completion and cancellation chimes were inaudible in packaged builds on
macOS, for more than one user, on both the stable and canary channels, while the
same code played fine from `bun run dev` and from a phone in remote mode.

`decisions/2026/08/23/gesture-only-audio-context-for-task-sounds.md` blamed a
gesture-less AudioContext and shipped a fix (PR #1506). That fix did not restore
the sound; the diagnosis was wrong.

## Investigation

Measured in one ordered run in the packaged app's own page, on the build that
already contained PR #1506:

1. A real click creating an `AudioContext` and starting an oscillator — silent.
2. An `<audio>` element with a generated WAV `data:` URL — audible.
3. The same Web Audio click again, now that a media element had played in that
   page — still silent.

So Web Audio produces no audible output in the Electrobun WKWebView under any
condition tried, and priming the page with a media element does not change that.
It reports `state: "running"`, advances `currentTime` by 0.901 s over 900 ms at
48 kHz and starts sources without error — Safari returns byte-identical numbers
and is audible, so nothing visible from JS distinguishes the two.

The earlier "a clicked button did play" observation was confounded: that page
also had a live `http://` iframe in it. `pointerdown` versus `click` is not the
axis either — a context built in a `click` handler is equally silent.

That leaves the path abandoned in #1192, an `<audio>` element, whose problem was
never sound but the macOS media keys: WebKit promotes a media element longer than
`MediaElementSession::isElementLongEnoughForMainContent` (0.95 s) to the system
Now Playing session, and the hardware Play/Pause then replayed our 1.3–1.5 s
chime instead of resuming Spotify (issue #1176).

Two levers were tested against live Spotify. `navigator.audioSession.type =
"ambient"` does **not** help: with the session explicitly ambient, a 1.5 s
element still took the keys. Duration does: a 0.85 s element played, and
Play/Pause afterwards controlled Spotify with no replay.

## Decision

`src/mainview/task-sounds.ts` plays through a fresh `<audio>` element per sound
and all Web Audio is gone. Both chimes were re-cut from 1.48 s / 1.28 s to
**0.82 s** with a 0.15 s fade-out (`ffmpeg -t 0.82 -af afade`), and
`NOW_PLAYING_THRESHOLD_SECONDS = 0.95` is exported so a test can guard it.

`task-sounds.test.ts` reads each shipped chime's duration out of its own MPEG
frame header — bitrate and sample rate from the bitstream, duration from the byte
count, independent of the tool that produced the file — and fails if any chime
reaches the threshold. Verified by running it against the pre-trim asset, which
measures 1.54 s and fails.

An element refused by autoplay policy (desktop Chrome in remote mode, #1018)
sets `autoplayBlocked`, queues the status in a `Set` and retries on the next
interaction; `playTaskCompletionSound` returns `false` while blocked so the
backend push still fans out, and the `Set` collapses that push echoing back into
one chime. The View → Debug probe reports `blocked` rather than implying success.

## Risks

The chimes are audibly shorter than the ones the user designed. The 0.95 s
threshold is a WebKit implementation detail with no API behind it: if WebKit
changes it, the media keys break again silently, and only the guard's comment
points at why the assets are short. Web Audio may well work again in a future
WebKit, but nothing here detects that.

## Alternatives considered

Keeping Web Audio and fixing gesture handling — this is what #1506 did, and it
demonstrably does not produce sound in this WKWebView. `<audio>` plus an ambient
audio session, keeping the full-length chimes — measured against live Spotify and
rejected: the keys were still taken. Detecting the muted context and falling back
to an element — impossible, since no Web Audio API reports audibility.
