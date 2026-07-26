# 177 — A created window is not a renderer: the desktop launch readiness contract

## Context

On a real Windows x64 machine over SSH (no interactive desktop) dev3 booted, logged
`=== dev-3.0 ready ===`, served remote RPC, and — in the Seq 1295 observation — died
~906 s later inside `libNativeWrapper.dll` with exit code 9. Reproduced live in Seq
1302 from an isolated checkout; the log order is the whole finding:

```
21:07:23.650 INFO  [window-manager] Window created {"id":1,"total":1}
21:07:23.650 INFO  [main] Main window created
21:07:23.662 INFO  [main] === dev-3.0 ready ===
[Sun Jul 26 21:07:23 2026] ERROR: Failed to create WebView2 controller, HRESULT: 0x80070578
```

`new BrowserWindow()` **succeeds**. Electrobun only throws when the native window
pointer is null; here the window is created and the WebView2 controller fails
*afterwards*, asynchronously, inside the native wrapper. There is no JS exception,
no event, and no falsy return — the bun side cannot see it at all.

## Investigation

- The same isolated checkout on the machine's own interactive desktop reaches
  `DOM ready` **366 ms** after `Window created` (`NavigationCompleted fired for
  webview 1`, no HRESULT). The packaged Windows launch proof measured 1511 ms.
  So a healthy renderer is ~3 orders of magnitude faster than any sane budget.
- **The crash is the first-paint resize nudge.** `createAppWindow` fired a 200 ms
  `setTimeout` that called `win.getSize()` + `win.setSize()` unconditionally. With a
  dead WebView2 controller that reaches an invalid native wrapper and Bun panics:

  ```
  [22:21] ERROR: Failed to create WebView2 controller, HRESULT: 0x80070578
  panic(thread 26360): Segmentation fault at address 0xFFFFFFFFFFFFFFFF
  bun.report/1.3.14/…libNativeWrapper.dll…   → exit code 9
  Elapsed: 4176ms
  ```

  Controlled A/B on the same machine, same SSH session, same checkout: nudge
  unconditional → segfault 4176 ms after start, exit 9. Nudge moved behind
  `dom-ready` → no crash, process alive until the watchdog ended it. That also
  explains the Seq 1295 "4–15 minutes" spread and why an idle run survived 17.5
  minutes: it is a **race** between the 200 ms timer and the asynchronous controller
  failure, not a timer we could ever out-wait. A readiness watchdog alone would
  never have caught it — the offending call has to be removed from the pre-renderer
  window, which is why the nudge now waits for `dom-ready` (where it belongs
  anyway: it exists to fix the FIRST PAINT).
- Electrobun's webview transport falls back from the renderer socket to an FFI
  `evaluateJavaScriptWithNoCompletion(webviewPtr, …)` and only early-returns on a
  null `ptr`, which a controller failure does not produce — so poller broadcasts
  are also FFI calls into a controller-less webview. Not observed to crash on its
  own (17.5 minutes of 10 s ticks), but it is why the launch must not linger.
- Shutdown was independently broken: the `before-quit` gate cancels the quit and
  asks the renderer to confirm. With a renderer, Ctrl+C works (observed:
  `Quit intercepted` → `quitApp (confirmed by renderer)` → cleanup). Without one,
  nobody answers and the app never exits.
- Electrobun **replaces `process.exit`**: the first call routes into its `quit()`,
  which always ends in `forceExit(0)`. A desktop-side `process.exit(8)` exits 0.
  `process.reallyExit` is not patched (verified on Windows, Bun 1.3.14).

## Decision

- `src/bun/renderer-readiness.ts` owns the contract. The first webview `dom-ready`
  is the only proof a renderer exists, so `index.ts` arms a watchdog right after
  `openMainWindow()` and disarms it in `onDomReady`. Budget: 45 s
  (`RENDERER_READY_TIMEOUT_MS`), ~30x the slowest observed healthy startup.
- `resolveRendererReadyTimeoutMs()` watches **win32 only** by default; macOS and
  Linux get `null` (no timer at all), so their startup is byte-identical. The
  `DEV3_RENDERER_READY_TIMEOUT_MS` env is the seam: an explicit value applies on
  every platform, `0` disables the watchdog, and garbage falls back to the
  platform default rather than silently disarming a safety net.
- On timeout `failDesktopLaunch()` writes an actionable diagnostic (the
  `DEV3_DESKTOP_RENDERER_UNAVAILABLE` marker, the 0x80070578 explanation, the
  WebView2 `winget` command, and `dev3 remote` as the headless answer) — console +
  log file only, no native dialog and no `window.alert`, because the renderer that
  would host in-app UI is precisely what is missing. It then calls
  `markQuitConfirmed()` so the quit gate cannot wait for a renderer, runs the
  normal `runGlobalQuitCleanup()`, and leaves via `hardExit()` with the new
  `CLI_EXIT_CODE_RENDERER_UNAVAILABLE = 8`.
- `src/bun/hard-exit.ts` owns leaving the process, and every layer of that had to
  be measured on Windows rather than assumed:
  - `process.exit(8)` exits **0** — electrobun replaces `process.exit` and its
    `quit()` always ends in `forceExit(0)`.
  - `process.reallyExit(8)` exits 8 in a plain Bun process but does **not end an
    electrobun app**: the app logged its full cleanup and then stayed alive for
    4.5 minutes with the native runtime holding the process.
  - `ExitProcess(8)` via `bun:ffi` does end it, but the process died with
    `0xC0000409` (fail-fast) because loader/CRT teardown ran while electrobun's
    native threads were live.
  - `TerminateProcess(GetCurrentProcess(), 8)` yields exactly 8. That is the
    primary path; `reallyExit` and `process.exit` remain ordered fallbacks for a
    platform where the FFI lookup fails. All of them skip buffered flushes, so the
    diagnostic is written with a synchronous `writeSync(2, …)` first.
- `writeAppReadyMarker()` moved from "window created" to "renderer ready". The
  marker is the packaged-launch proof's readiness signal and used to be written
  while there was no UI at all — a half-started app reporting success.
- Headless mode is left alone by construction: it never imports the window layer.
  A new guard in `cli-startup-graph.test.ts` walks `headless-entry.ts`'s static
  import graph and fails if `window-manager` or `electrobun/*` becomes reachable,
  and `test:headless-soak` (opt-in, 16 min default, not in `bun run test`) proves
  remote mode serves past the observed 906 s window with the watchdog pinned to
  1 ms.

## Risks

- A healthy launch that is slower than 45 s to first paint would now be killed.
  Observed healthy startups are 0.37–1.5 s, and the budget is win32-only, so the
  margin is large — but a pathologically slow machine is the failure mode to watch.
- The nudge was the crash we could reproduce; the pre-renderer window still
  contains other native calls (poller broadcasts into a controller-less webview).
  Nothing was observed to crash there in 17.5 minutes, but the class is not
  eliminated — only shortened to 45 s.
- `TerminateProcess` bypasses every exit handler and flush. Everything this process
  owns is torn down explicitly before the call; anything added to
  `runGlobalQuitCleanup()` later inherits that requirement.
- The launcher chain does not forward the code: with `bun run dev` the console saw
  `9` while the app process itself exited `8`. The app's own exit code is the
  contract; `bin/launcher.exe`'s translation of it is an electrobun detail.

## Alternatives considered

- **Poll for the WebView2 runtime / interactive desktop before creating a window.**
  Rejected: it answers a different question (is a runtime installed) than the one
  that matters (did *this* controller come up), and it would need a second
  platform-specific probe to maintain.
- **Fall back to headless/remote mode automatically.** Rejected by scope and by
  UX: a user who launched a desktop app silently getting a background web server
  is worse than a clear failure, and it would mask a broken install forever.
- **Arm the watchdog on every platform.** Rejected for now: the failure is only
  observed on Windows, and the cost of a false positive is killing a working app
  on the user's own machine. The env override makes the other platforms one
  variable away when evidence appears.
- **Make the pollers renderer-aware instead of exiting.** Rejected: it leaves a
  UI-less process running forever and multiplies the number of places that must
  remember the contract, instead of ending the launch that cannot succeed.
