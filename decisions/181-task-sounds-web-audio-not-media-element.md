# 181 — Task sounds play through Web Audio, never an `<audio>` element

## Context
Issue #1176: on macOS, after dev3 played the task-completion chime, the hardware
media keys stopped controlling the user's audio app (Spotify). Pressing
Play/Pause replayed the dev3 chime instead of resuming the music.

## Investigation
WebKit promotes an `<audio>` element to the system "Now Playing" session — the
media-key target — once its duration passes 0.95s
(`isElementLongEnoughForMainContent` in `MediaElementSession.cpp`, the threshold
added for WebKit bug 263750 "Slack.com audible notifications steal NowPlaying
status"). Our chimes are 1.512s and 1.320s, so they sat just above the exemption.
Pausing or resetting the element does not help: the NowPlaying eligibility check
never looks at whether the element is currently playing.

Verified with a two-`WKWebView` probe (a long-playing reference player plus the
chime page) driving a synthesized `NX_KEYTYPE_PLAY` event:
- `<audio>` chime → the key replayed the chime, the reference player was ignored.
- Web Audio chime → the key paused the reference player, the chime did not replay.

An `AudioContext` is only NowPlaying eligible when the page sets
`navigator.audioSession.type = "playback"` (`AudioContext::isNowPlayingEligible`),
which we never do — and it activates the audio session as ambient sound, so it
also stops interrupting other players. Chrome behaves the same way (WebAudio is
`kAmbient`), so remote browser mode gets the same guarantee.

## Decision
`src/mainview/task-sounds.ts` decodes both chimes once into `AudioBuffer`s and
plays them through a lazily created, long-lived `AudioContext`
(`AudioBufferSourceNode` → `GainNode` for the per-sound volume, graph
disconnected on `ended`). No `HTMLAudioElement` is ever constructed. The context
is created on the first gesture or first sound rather than at import, so Chrome
does not log its "AudioContext was not allowed to start" warning.

This replaces the element-priming mechanism of decision 147: an unlocked
`AudioContext` stays unlocked, so the delayed, push-driven plays that priming
existed for (remote desktop Chrome, sound arriving seconds after the click) work
without a per-element user-activation trick. The gesture-unlock queue survives in
a simpler form: a sound that arrives while the context is suspended is queued and
flushed when a gesture resumes it.

## Risks
Sounds are silent until `decodeAudioData` finishes (a few ms for a 36 KB MP3,
pre-warmed on the first gesture) instead of streaming from the element. Web Audio
is required — there is no `<audio>` fallback, by design, since a fallback would
reintroduce the bug on exactly the platform that has it. A browser without
`AudioContext` plays nothing and logs a warning.

## Alternatives considered
- Trim the MP3s below the 0.95s exemption: fragile — the exemption is bypassed
  whenever the app already registered as the NowPlaying application
  (`registeredAsNowPlayingApplication` in `canShowControlsManager`), and it would
  not stop the chime from interrupting other players.
- Tear the element down after `ended` (`pause` + `removeAttribute("src")` +
  `load()`): does release the session (WebKit's own layout test asserts it), but
  it leaves a window where dev3 owns the keys and fights the priming design.
- `navigator.mediaSession.playbackState = "none"`: no effect in WebKit, and on
  desktop Chrome touching `playbackState` makes even a short blip a media-key
  target.
- Play the sound in the bun process (`afplay`): rejected for the same reasons as
  decision 030 — macOS-only and no sound for remote browser clients.
