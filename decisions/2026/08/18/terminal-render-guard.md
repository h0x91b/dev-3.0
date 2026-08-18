# Guard every terminal frame instead of only the resize path

## Context

Third incident of a permanently blank terminal, 2026-08-18 ~14:00. The rebuild
shipped hours earlier (`terminal-renderer-crash-self-heal`) never fired: the log
held no `[refit]` line, no `[error]` line, nothing. The user restarted the app.

## Investigation

The earlier fix hangs off the three `catch` blocks in `refitToContainer`, so it
only ever sees a crash that arrives through `term.resize`. Two other paths could
kill the renderer with no trace at all, both by deliberate design:

- `enqueueTermWrite`'s flush swallowed every throw from `batchTerm.write()` with
  the comment "Swallow ghostty-web rendering errors" — added to stop thousands of
  `app_exception` analytics events per session.
- the socket's `onmessage` swallowed the same class for the same reason.

And a frame can also stop arriving without throwing anywhere. The log could not
distinguish "nothing was sent to the pane" from "bytes arrived and nothing
painted", because nothing counted either.

## Decision

`src/mainview/terminal-render-guard.ts` wraps `renderer.render` the way the cursor
gate and the bidi view already do (installed last, disposed first), and:

- **swallows a throwing frame** so the vendor's private loop reaches its own
  `requestAnimationFrame` — this is coder/ghostty-web#189's first ask, implemented
  locally, and it is what keeps a pane alive at all;
- **reports the first three failures then every 60th**, keeping the log usable
  when a broken frame repeats at 60 fps;
- **watches for a stall**: the vendor renders every frame whether or not anything
  changed, so a *visible* pane with no frame for 6 s is a dead loop by definition.
  Hidden windows are never judged, and a window returning from hidden gets a fresh
  clock, because rAF is paused while hidden.

Both signals route into the existing `recoverFromRendererCrash` rebuild. The two
silent catches now log (throttled) with `socketBytes` / `socketBatches` /
`msSinceLastByte` / frame counts, and the write path also asks for a rebuild.

## Risks

- Swallowing a frame hides a genuine vendor bug from analytics; the throttled log
  line plus the rebuild are the compensation, and the counters make it visible.
- The 6 s stall threshold is a guess. It cannot fire on a hidden window; a very
  long main-thread block on a visible window would trigger a pointless rebuild,
  bounded by the existing 3-rebuild budget.
- The stall detector cannot tell a dead loop from a renderer that is alive but
  painting nothing visible; the logged counters are what tells them apart after
  the fact.

## Alternatives considered

- **Leave it to the upstream fix.** coder/ghostty-web#132 addresses the
  resize/realloc race, but it is unreleased and does not make the loop survive a
  throw — and the silent mode is not covered by it at all.
- **Restart the loop instead of rebuilding.** `startRenderLoop` is private; there
  is no public way in.
- **Keep the swallows and only add logging.** Would have diagnosed the next
  incident but left the pane dead, which is the part the user actually feels.
