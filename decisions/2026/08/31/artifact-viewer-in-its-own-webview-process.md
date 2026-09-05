# Render the artifact viewer in an `<electrobun-webview>`, not an iframe

> **Superseded on 2026-09-05 by `decisions/2026/09/05/artifact-viewer-back-in-the-page.md`:**
> the separate webview host, the transport picker and the overlay-mask machinery
> were all deleted. The artifact is a sandboxed `srcdoc` iframe again on every
> platform. The measurements below still stand as measurements — the process
> isolation was real — but nothing in the code does this any more, and the
> containment it bought is gone.

## Context

Three hard UI freezes on 2026-08-30 (10:48, 13:51, 16:46), all with an artifact
open. The backend stayed alive each time; only the renderer's JS thread died,
which is why CSS animations kept running on the compositor while nothing
responded to input. A live `sample` of the wedged WebContent process on
2026-08-31 11:39 put 4006 of 4006 main-thread samples in one stack —
`DOMTimer::fired → ScheduledAction::execute → JSC::profiledCall → JIT` — at
2.9 GB physical footprint. One specific artifact reproduces it every time.

A `srcDoc` sandboxed iframe shares the process **and the main thread** with the
host page in WebKit, so a runaway artifact takes the whole app window with it.
Investigation and the ruled-out candidates live on task `ed02d027` (Seq 1755);
this record covers only the containment.

## Investigation

The whole change rests on one claim from Electrobun's docs — "each webview runs
in a separate browser process" — so it was measured before anything was written.
A `bun run dev --qa` build with a temporary `<electrobun-webview>` whose document
runs a `setTimeout` callback that never returns and allocates arrays forever:

- A new `com.apple.WebKit.WebContent` process appeared for it (PID-set diff).
- `sample` of that process: **1630 of 1630** main-thread samples in
  `DOMTimer::fired → ScheduledAction::execute → JSC::profiledCall → JIT` — the
  captured signature, byte for byte.
- The app window's own WebContent process at the same moment: 0.0% CPU, main
  thread parked in `-[NSRunLoop run]`, RSS flat at 82 MB.
- `renderer-watchdog` logged no "heartbeat lost" for the ~2 minutes the child was
  wedged and growing to 7.3 GB. It reports within 8s, so its silence is the
  positive evidence that the host's JS thread kept beating.

Three things the vendor docs get wrong in 1.18.1, each found the same way and
each load-bearing here:

| Doc says | Measured |
|---|---|
| `preload` is a script path | It is inline JS source (`toCString(customPreload)`) |
| `__electrobunSendToHost` is available in preload scripts | Absent in a **sandboxed** child; only `__electrobunEventBridge` is, and hand-writing its `host-message` envelope works |
| `toggleHiddenMirrorMode`, `syncScreenshot`, `callAsyncJavaScript` exist | They do not. `toggleHidden`, `addMaskSelector`, `syncDimensions`, `executeJavascript` do |

Also measured: preload and page scripts share one JS world (so a preload hides
nothing from artifact code — no worse than today's injected scripts, but no
better either), and a 12 MB `html` attribute costs 11 ms to set and 407 ms to
`dom-ready`, which is what artifacts with inlined data-URL assets need.

## Decision

`TaskArtifactViewer` no longer renders a frame itself. It renders
`components/ArtifactFrame.tsx`, which is one of two hosts behind one imperative
handle (`post`) and one callback (`onMessage`):

- **`webview`** — `<electrobun-webview sandbox html=…>`, built imperatively
  because `sandbox` and the initial `html` are read once in the tag's own
  `connectedCallback`; inserting it bare would give an unsandboxed webview with
  Electrobun's RPC bridges to the backend.
- **`frame`** — the sandboxed `srcdoc` iframe, unchanged.

`utils/artifactTransport.ts` picks: `webview` on desktop macOS, `frame` in remote
mode, off macOS, and whenever the custom element is not registered. Linux builds
ship `bundleCEF: false` and the tag needs CEF; Windows (WebView2) is simply
unmeasured. Both would fail as a blank viewer — worse than the freeze the webview
would have contained — so they keep the iframe until someone measures them. **The
freeze is therefore still reachable on Linux and Windows.**

`utils/artifactChannel.ts` is the one message channel, injected into the composed
document ahead of every other injected script. The find protocol, save-image and
`window.dev3` all talk through it and never learn which transport they got. Out:
`parent.postMessage` or the event-bridge envelope. In: a `message` event or an
`executeJavascript` call on `receive()`.

`utils/artifactOverlayMasks.ts` keeps the app visible over the native layer. The
webview is not part of the page — the OS paints it above the whole window, so
`z-index` and `overflow` mean nothing to it — and the tag's answer is masks. Which
rectangles is computed at runtime from every fixed-position element that overlaps
the viewer, rather than by tagging two dozen modal components by hand: an overlay
nobody remembered to tag is exactly the bug this must not have. In-viewer chrome
that is not fixed (the find bar) carries `data-dev3-artifact-overlay` itself.

`ArtifactFrame` also polls at 200 ms to force a position sync when an overlay
appears (the tag only re-sends masks when its **own** rect changes) and to
`toggleHidden` when the viewer is laid out to zero — the tag's sync ignores a
zero rect and would otherwise leave a live native layer parked over the app.

**This contains the blast radius; it does not fix the runaway loop.** The
underlying bug on Seq 1755 stays open.

## Risks

- Masks are the one part not yet measured on a real native layer. If they turn
  out not to punch through in WKWebView, the fallback is to `toggleHidden` while
  a blocking overlay intersects — a one-line policy change in the same effect,
  at the cost of the artifact blinking out under a toast.
- Everything the artifact document does now crosses a process boundary. The
  compose-time work is unchanged, but `executeJavascript` is fire-and-forget:
  a message sent before `dom-ready` would evaluate against no document, so
  `ArtifactFrame` queues until then.
- Artifacts already on disk listen for the theme with a plain
  `window.addEventListener("message")` — that is what the shipped template's
  `app.js` does, and those files are never rewritten. The channel therefore
  re-posts anything the host delivers into the child's own window, or the theme
  would silently stop following for every report ever published. Covered by a
  test that fails when the re-post is removed.

## Alternatives considered

- **Keep the iframe and fix the loop.** Necessary, and still open, but it fixes
  one artifact: any future one can freeze the app the same way.
- **Load the artifact from `file://` instead of an HTML string.** Relative assets
  would resolve natively and the compose step could shrink — but it gives foreign
  agent-written HTML a real local origin, which is a straight security regression.
- **A non-sandboxed webview with a custom preload.** Would have given
  `__electrobunSendToHost` for free, at the price of handing the artifact
  Electrobun's RPC bridges to the backend. The event-bridge envelope costs six
  lines and keeps the sandbox.
- **Tag every modal with a mask attribute by hand.** Two dozen files, and it
  fails silently the first time someone adds the twenty-fifth.
