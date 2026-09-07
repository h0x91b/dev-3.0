# Artifact resize freeze investigation

Status: investigation blocked on a native desktop reproduction, 2026-09-05. Root cause not established. Diagnostic instrumentation added after a new user-reported incident; no fix or panel redesign. 280 full-app browser drags did not reproduce the freeze.

## Environment and evidence provenance

Task 1797; checkout e8e3dec08; macOS 15.7.7 (24G720); installed app/CLI 1.51.2. A local-only `dev3 remote start --no-tunnel --port 31979` served the installed app. A worktree dev build was also started through `dev3 dev-server start --wait` (port 18004). Neither server existed for this task before this investigation.

The fixture is the previously reported nanochat artifact ZIP (upload-1788165750418-e774-nanochat), republished to task 1797 as “Resize investigation fixture”. ZIP contains index.html (6,562 bytes), app.css (41,732), report.js (116,071), app.js (31,733), dev3-icon.png (25,949). Composed iframe srcdoc: 298,806 characters. This is a real historical reproducer, not a newly invented infinite-loop artifact.

## New measurements

Full remote app, Chromium, 1440×900 viewport, own task's live tmux terminal alongside the fixture. Each pointer drag starts on the real separator, moves to x=490 or x=1078, then releases; approximately 950↔360 px panel widths, 150 ms minimum pause after release. Two batches of 20 drags each:

| Batch | Duration | Host rAF frames | Largest gap | p95 gap | Long tasks ≥50 ms | Iframe loads | src/srcdoc mutations |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8,989.8 ms | 1,011 | 22.7 ms | 13.4 ms | 0 | 0 | 0 |
| 2 | 9,378.9 ms | 1,050 | 22.6 ms | 13.7 ms | 0 | 0 | 0 |

Same iframe DOM identity before/after both batches; both ended at aria-valuenow=360. UI remained scriptable. Raw results: `1797-evidence/remote-resizes.txt`. Host rAF, PerformanceObserver(longtask), iframe load listener and attribute MutationObserver were installed before the drags. These measurements do not rule out content-dependent terminal bugs or prove behavior of native WKWebView.

## Existing evidence, not measurements repeated here

Task 1755 notes were read explicitly because the 2026-08-31 artifact process-isolation decision references that investigation. Its original raw `/tmp/dev3-freeze*.txt` samples are no longer present. Do not present its numbers as fresh samples:

- 2026-08-31 timer capture: 4,006/4,006 main-thread samples in DOMTimer::fired → ScheduledAction::execute → JSC::profiledCall → JIT; physical footprint 2.9 GB, peak 3.8 GB.
- Later capture: 4,031/4,031 main-thread samples in WebSocket::didReceiveMessage → dispatchEvent → JSEventListener → JSC/JIT, footprint 660 MB, peak 805 MB.
- The note inferred a terminal-write-path origin because it assumed the PTY socket was the only desktop WebSocket. That exclusivity claim is incorrect in the installed Electrobun: `dist/api/browser/index.ts:52` creates the desktop RPC WebSocket too. The stack still points to JS handling a socket event, but does not uniquely identify PTY processing.
- The same task retracted its sidebar paint-storm thesis: capture screenshots distorted apparent frame rate; healthy app logs stayed at 60 fps shortly before a discrete wedge.

The process-isolation ADR records containment of a deliberately runaway child, not identification of the original bug. Its broad attribution to an artifact should be read alongside the later corrected task notes.

## Code observations checked against runtime

`TaskWorkspacePane.tsx` moves a ghost line during pointermove and commits real artifact width only on release. Its clamp observer watches the containing row. `TaskArtifactViewer.tsx` composes on [current, t, transport], not width; runtime iframe identity/attribute counters above confirm no resize reload in the tested path. `ArtifactFrame.tsx` uses a sandboxed iframe in remote mode and a separate electrobun-webview on supported macOS desktop. Desktop transport must therefore be measured independently.

## Work still required

Capture a native desktop reproduction and sample its attributed WebContent PID while wedged. A current freeze, callback/function attribution and a controlled intervention are still needed to name a root cause. No speculative debounce or loop change is justified by the present measurements.

## WebKit full-app comparison

Playwright 1.58.x with matching WebKit revision 2248, macOS runner, same installed remote server at port 31979, 1440×900, same fixture and task terminal. This is browser remote mode in Playwright WebKit, **not** the system WKWebView embedded by Electrobun. Drags have eight mousemove steps and a 150 ms pause after release. All batches alternated measured aria-valuenow 946↔360 px.

| Run | Batch | Drags | Duration ms | rAF frames | Maximum gap ms | p95 ms | Cumulative loads | Attribute changes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Initial | 1 | 40 | 7457 | 476 | 72 | 23 | 1 | 0 |
| Initial | 2 | 40 | 7358 | 470 | 85 | 23 | 1 | 0 |
| Initial | 3 | 40 | 7731 | 488 | 43 | 24 | 1 | 0 |
| Settled | 1 | 40 | 7458 | 484 | 30 | 24 | 0 | 0 |
| Settled | 2 | 40 | 7196 | 471 | 30 | 21 | 0 | 0 |
| Settled | 3 | 40 | 7280 | 475 | 30 | 23 | 0 | 0 |

The initial run instrumented before the first iframe load finished. Its load counter increased once in batch 1 and never again; a second run waited 1.5 seconds before instrumentation and measured zero loads throughout. DOM iframe identity stayed the same in every batch. WebKit long-task entries were not collected; the timing column is host rAF, not a JS CPU profile. Raw JSON: `1797-evidence/webkit-resizes.txt` and `webkit-settled-resizes.txt`.

## Targeted code stress measurements

A read-only audit helper exercised the real OSC8/file-link providers with synthetic immutable buffer adapters: 100 passes × 48 rows, all cells OSC8-linked and wrapped path text. Total elapsed ms by column count: 1=10.95, 2=10.88, 3=51.10, 4=50.99, 8=60.93, 16=85.84, 40=131.83, 80=220.93, 160=424.76. All terminated. These are synthetic JS provider tests, not native freeze reproductions.

The same audit exercised the ANSI theme filter: 17 MB valid SGR/text in 474.48 ms; 2 MB unterminated CSI parameters in 45.05 ms; 10 MB repeated incomplete CSI prefixes in 33.08 ms. No nonprogress was demonstrated. A Ghostty zero-column selection loop was identified by reading, but dev3 does not call that selection API and normal fitting clamps to at least two columns; it is not a supported explanation or a proposed fix.

## Failed setup attempts and native limits

The initial Playwright package expected WebKit revision 2227 and failed against installed 2248 with `Protocol error (Console.enable): Console domain was not found`. Retried with a locally cached matching package. Navigation attempts also needed the project board opened first and the exact task selected. Those timeouts happened before resizing and are excluded from the tables.

The worktree dev server initially became ready at 18004 and served a WebKit navigation into the task/artifact. Later, navigation timed out and an HTTP HEAD probe failed to return in three seconds. Successful comparison runs therefore use the separately started, responsive installed remote server at 31979. No renderer-hang conclusion is drawn from the dev-server setup failure.

The actual canary desktop app (bun PID 95996) was opened to this task and its native View → Toggle Developer Tools menu opened Web Inspector. Automated console access did not yield a reliable evaluated result; no native resize sequence or frozen stack was captured. `lsof -p 96281` showed a `Library/WebKit/dev3.electrobun.dev/WebsiteDataStore/...` mapping, confirming that WebContent PID belonged to dev3, but it was not a measured frozen reproduction. Old task 1755 samples cannot replace this missing experiment.

Both servers and the task-specific Chromium browser were stopped after measurements. No terminal input was sent to another task. Temporary build output changes were discarded; product changes below add only opt-in diagnostic boundaries.

## Deliverable verdict and next capture

**Unresolved.** The tested resize path does not remount/rewrite the artifact and did not freeze in Chromium or Playwright WebKit. The historical stacks point to a discrete JS callback wedge, but do not uniquely identify the terminal path: desktop Electrobun RPC also uses WebSocket. The specific function and whether it explains today's native symptom remain unproven. There is no evidence sufficient to blame the compositor or declare an Electrobun/WebKit defect.

To continue efficiently, reproduce in native desktop with the original terminal state/output, not just the artifact ZIP. Record app build, selected task, terminal backend and dimensions before/after each drag. Keep JavaScript & Events recording enabled and screenshot recording disabled; on the freeze, pause JS to name the function, and concurrently run `sample <attributed-WebContent-PID> 5 -file <output>` from a separate shell. Repeat with the same artifact and a quiet terminal, then the same terminal resize without the artifact. These controlled interventions distinguish artifact work from terminal redraw work. The historical samples alone do not make that distinction conclusive.

The coordinator has the report path. An opt-in diagnostic change was added at the user's request; it does not claim to fix the freeze. Further native access/capture is needed before claiming the requested diagnosis is complete.

## New native incident and requested instrumentation

The user reported another freeze during this investigation. The daily log records `2026-09-05 01:06:19.862 [95996:renderer-watchdog] renderer heartbeat lost`, quietForMs=9830, terminals=1, frameErrorPanes=0, active task=818c6734, project=6e50abef. The last heartbeat was therefore approximately 01:06:10.032. A new bun PID 67244 started receiving renderer heartbeat at 01:06:28.562: the frozen process was already gone when sampling began.

At 01:07:20, `sample 67677 3` captured the replacement WebContent (launch time 01:06:28.312), attributed by the dev3 WebKit datastore path. 1,747 of 2,558 main-thread samples were waiting in the run loop (~68.3%); 714 entered rAF callbacks (~27.9%). Physical footprint was 596.5 MB, peak 802.2 MB. This is a healthy replacement sample, not the freeze stack. Raw sample was retained locally at `/tmp/dev3-1797-latest-webcontent.sample.txt`.

The user explicitly requested additional diagnostics. Added opt-in `freeze` debug channel. In the updated app's Web Inspector console, execute:

```js
localStorage.setItem("dev3-debug", "terminal,rpc,boot,freeze")
```

Then resize in the original failing task. No reload is needed after setting the flag in an app already running the updated code. Each refit arms a 10-second, 2,000-span capture. `[freeze-trace]` events go to `~/.dev3.0/logs/YYYY/MM/YYYY-MM-DD.log`; nothing is uploaded. `traceId`, `capture`, and `spanId` pair begin/end events for nested operations. Stages include geometry calculation, resize, OSC8 feed, ANSI filter, terminal write, selection cleanup, renderer, underline redraw and link scan. Return/throw behavior is preserved. No terminal text, URI or path is recorded by these new boundaries.

Disable with `localStorage.setItem("dev3-debug", "terminal,rpc,boot")`. Tracing remains active only until the current bounded capture expires. Existing default logging behavior is unchanged; the new channel is off unless explicitly selected (or `*` is selected).

Initial validation: 33 tests passed across the trace helper, render guard, underline renderer and debug channel. Tests verify begin is emitted before work, matched end on exceptions/expiry, nested IDs, budget enforcement, sink failure isolation and off-by-default behavior outside test mode. Typecheck result is recorded with the final handoff. This instrumentation adds overhead and can perturb the reproducer; use an Inspector pause or native sample to confirm the candidate suggested by an unmatched begin.

### Instrumentation transport correction

Inspection of installed `electrobun/dist/api/browser/index.ts` established that the ordinary desktop RPC calls `await window.__electrobun_encrypt(msg)` before `WebSocket.send`. That await would strand a newly queued begin marker if the next synchronous operation wedges. The diagnostic transport therefore posts a typed `terminalFreezeTrace` message directly through `__electrobunBunBridge.postMessage` on desktop; `window-manager.ts` receives it into the local renderer log. Remote mode falls back to the existing diagnostic request. Tests verify the native message is posted before the traced callback starts. Native end-to-end delivery still needs verification in the next desktop reproduction.

A rebuilt remote app did write opt-in traces to the real daily log under bun PID 85232, covering render, write, selection, OSC8, ANSI and underline paths. Counts are saved in `1797-evidence/trace-sink-validation.json`. The first TypeScript check found test-only use of Array.at against the ES2020 target; replaced it with indexed access, then lint and 33 tests passed. Added native transport tests are included in final validation.

Final instrumentation validation: `bun run lint` passed; 35 tests passed across five suites including native transport. Both test servers and owned browser sessions are stopped. The diagnostic change must be built/launched before the console flag has any effect; it does not modify the installed canary app.

## Second user-reported incident: closing the artifact

At 01:47 on 2026-09-05 the user reported that closing an artifact occupying roughly half the window froze the old installed app. The daily log confirms heartbeat lost at 01:46:14.136 under bun PID 67244, quietForMs=9653, terminals=1, frameErrorPanes=0, active task=818c6734, project=6e50abef. Last heartbeat was approximately 01:46:04.483. Replacement bun PID 71486 began receiving heartbeat at 01:46:21.427; no frozen-process sample was captured before restart. This was not the instrumented build.

Closing the panel changes terminal geometry too, so terminal refit/redraw remains a shared trigger candidate. Artifact native-view teardown is an additional candidate; this observation alone does not distinguish them. If teardown stalls before the refit callback, the new terminal trace may not arm. The user will next reproduce closing the artifact in the instrumented worktree build.

## Diagnostic regression: native Bun crashes, 01:48–01:49

This section supersedes the direct-native-transport recommendation above. The user enabled the trace in the native worktree build and reported immediate process crashes. Right-hand dev-server pane captured Bun 1.3.14 panic: `Segmentation fault at address 0x100000000`, child signal 5, script exit 133. Unlike the original renderer-only freeze, the bun process died.

macOS reports `bun-2026-09-05-014825.ips` (capture 01:48:18.9857) and `bun-2026-09-05-014916.ips` (capture 01:49:16.3637) both identify faulting thread 6, named Worker, with Bun/JSC addresses rather than symbolicated application JS. The second process had run for 26,907 ms and reported RSS/peak 0.61 GB. No native bridge function is symbolicated in these reports; attribution to the new delivery path is a candidate based on the controlled enablement, not a fully established Bun root cause.

For bun PID 75541, 183 native trace records reached the daily log: one arm, 91 begins, 91 matching ends, zero unmatched operations. The last completed operation was strip-osc52. Thus this run neither captures a terminal operation stuck forever nor establishes the original artifact-freeze cause. Summary: `1797-evidence/native-trace-crash-summary.json`.

Removed the direct `__electrobunBunBridge` sender and its host message handler entirely. Both platforms now use the existing diagnostic RPC request; max spans reduced to 300 per refit (still a ten-second window). Existing stored debug flags remain understood. The normal desktop RPC's encryption await can strand the latest marker on a JS wedge, so live Inspector pause/sample is required for final attribution. This intentionally favors removing the suspected instrumentation crash path over an unverified synchronous marker guarantee.

Recovery validation: TypeScript and 33 focused tests pass. Native user reproduction is still needed to establish whether removing the direct bridge eliminates the diagnostic crash; passing unit tests cannot make that claim.
