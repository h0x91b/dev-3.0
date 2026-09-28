# Freeze capture keeps recent terminal output

## Context

The 2026-09-27 desktop freeze was captured by the freeze collector, but only at the end. The one in-freeze sample showed the renderer main thread spinning inside a WebSocket message listener. Stack/source inference placed it in the terminal PTY socket's `onmessage` → `writeToTerminal` → `ghostty-web` write. JIT/WASM frames are unsymbolized, and nothing had recorded the terminal bytes, so the hang could not be replayed.

## Investigation

The renderer went silent while hidden and was flagged only ten minutes later, when the window regained focus. The host kept sending PTY output to the stuck socket the whole time. A plain "last N bytes" ring dumped at detection would therefore mostly hold output the renderer never processed, and the bytes it choked on would already be evicted. Hidden windows keep beating every ~3 s, so a gap of two beats is a usable early signal even though the monitor does not flag hidden windows.

## Decision

`freeze-diagnostics/pty-output.ts` is a dependency-free recorder with a bounded ring per PTY client: 64K characters, 32 clients, least-recently-written evicted. `pty-server.ts` routes every send through one `sendText` helper that records into it, and a socket close forgets the client. The host (`freeze-diagnostics.ts`) tracks each desktop window's last beat. Its existing 1-s timer pins every ring once a beat is ≥6 s stale and unpins when beats resume. On a capture whose reasons include `window-N-heartbeat-missing`, the worker asks the host (`capture-pty-output`) to write `<session>.<n>-pty.json` (0600, ≤4 MiB, newest clients first), and the result is logged in the journal. Per the user's choice, this rides on the existing "Record app freezes" switch rather than a separate one; the switch copy and `docs/diagnostic-logs.md` now say so. The recorder is enabled only while the collector runs and is cleared when it stops.

## Risks

Anyone who had already turned the switch on now also stores recent terminal output, secrets included, without being asked again; the files stay local and rotate with their session. The dump may still miss the trigger: more than 64K characters inside the 6-s pin delay, or state-dependent behaviour such as geometry and prior screen content. A replay is a lead, not a guaranteed reproduction. The pin is global across windows and also fires on a legitimate WebKit suspension; that costs only an in-memory copy.

## Alternatives considered

A separate opt-in sub-switch was recommended but declined by the user in favour of one switch. A settings.json-only key was rejected as undiscoverable. Dumping from the worker via shared memory would also survive a blocked host, but the suspect here is a renderer, with a healthy host. Flagging hidden-window heartbeat loss in the monitor (option B of the incident report) was not authorized and is not part of this change.
