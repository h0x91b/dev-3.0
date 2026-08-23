# Build the task-sound AudioContext only inside a user gesture

## Context

Task completion and cancellation chimes went silent on packaged builds, for more
than one user, while the same code played fine from `bun run dev` and from a
phone in remote mode. Nothing in the sound pipeline had changed for weeks.

## Investigation

The `View → Debug → Play Completed Sound` probe reported a fully healthy
pipeline — `context running`, both buffers decoded, empty queue, no console
warning — and was completely silent. In the packaged app's own page a Web Audio
oscillator advanced `ctx.currentTime` by 0.901 s over 900 ms at 48 kHz, so the
graph really rendered, and an `<audio>` element with a generated WAV data URL
played in the same document. Safari reported byte-identical numbers
(`running`, 48000, `outputLatency` 0.015625) and was audible, so the state
visible from JS cannot distinguish working from broken.

The discriminator was the gesture. Every silent attempt had no transient user
activation: a macOS menu item reaches the renderer as a push message, and Web
Inspector `eval` is not a gesture either. A button injected into that same
`views://` page and clicked for real played immediately. WebKit mutes an
AudioContext created without activation while still reporting `running` and
advancing `currentTime`.

Because `task-sounds.ts` cached the context in a module singleton that was never
closed, one gesture-less birth silenced the app for its whole session. The old
`installUnlockHandlers` made it unrecoverable: it removed its own listeners once
`resume()` reported `running`, which a muted context does.

Ruled out on the way: the settings gate, the inlined mp3 assets, the code
signature and entitlements, the release pipeline, system volume and output
device, audio-muting helper apps, the `views://` scheme (an http iframe in the
same window changed origin *and* gesture at once — a confounded comparison), and
every commit touching sound in the preceding five days.

## Decision

`src/mainview/task-sounds.ts`: the context is created only by
`createContextInGesture()`, called exclusively from the unlock handler bound to
`pointerdown` / `keydown` / `touchstart`. `playTaskSound` never constructs one —
without a context it adds the status to a pending `Set` and returns.
`playTaskCompletionSound` returns `false` when it could only queue, so the UI
does not claim ownership and the backend `taskSound` push still fans out; the
queue is a `Set` so that push echoing back cannot double the chime. The unlock
listeners are never removed, which is what lets a later click resume a context
WebKit interrupted.

`taskSoundDiagnostics()` now reports `unlocked`, and the menu probe says
`queued — no gesture yet` instead of implying success, because that probe can
never prove audible output: a menu click is not a page gesture by construction.

## Risks

The first completion after launch can arrive before the user clicks anywhere; it
now chimes on that first click instead of immediately. A context that WebKit
mutes *after* a legitimate gesture-born start is still undetectable — no Web
Audio API reports audibility — so the recovery path is limited to resuming a
suspended context on the next gesture.

## Alternatives considered

Rebuilding the context whenever it looks suspicious was rejected: "suspicious"
would be a heuristic, since a muted context is indistinguishable from a healthy
one through the API. Returning to an `<audio>` element was rejected because it
would reintroduce issue #1176 — on macOS WebKit promotes any media element
longer than 0.95 s to the system Now Playing session, and our 1.3–1.5 s chimes
stole the hardware media keys from Spotify.
