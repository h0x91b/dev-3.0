# Live Artifact: one in-place page per task, with its own state store

## Context

A published artifact is a snapshot: every change is a new version, and the only way back to the
agent is `sendToAgent`. A long-running "assistant" task (wixel-dev-space Seq 118) outgrew that and
hand-built a localhost portal (`~/.wixel-current-hub`: one Node server, one SQLite file) that the
user drives daily — status cards the agent rewrites, Approve / Reject / Discuss, comments, a
"page updated" banner, opened in Chrome and on the phone. The ask is to make that a dev3 feature:
any artifact can become the task's **Live Artifact**, which updates in place, keeps state in a
micro backend, and opens in a browser.

## Investigation

- The viewer renders artifacts in a `sandbox="allow-scripts"` frame with no `allow-same-origin` and a
  CSP that blocks connections (`decisions/2026/07/09/task-html-artifacts.md`), so an in-app live page
  cannot `fetch` a server; it has to go through the viewer by `postMessage`, like `sendToAgent`.
- Today "Open in browser" is `Utils.openPath` on the stored file — a `file://` page with no channel.
- `bun:sqlite` is not loadable under the backend tests (Vitest runs on Node) and Bun does not ship
  `node:sqlite`, so SQLite would mean two drivers behind an adapter for a store of a few hundred
  small documents.

## Decision

User answers (2026-10-21, from the plan artifact): collections of JSON documents; read-only and
kept after the task completes; loopback-only browser URL, phone via remote access; only a click
wakes the agent; **page changes auto-reload with state kept**, data changes reach the page
asynchronously (server-sent events, no reload); port collisions across the machine must be designed
for; the pilot is built in this task from scratch.

- **One per task.** `Task.liveArtifact` (`src/shared/types/shared-media.ts`, additive optional field)
  points at a stored `SharedArtifact` page plus a `pageRev`. Pages are stored by the existing
  `saveSharedArtifact` into `shared-artifacts/<uuid>/` (immutable dirs), so the viewer, download and
  open-in-browser paths take the page unchanged. `dev3 live adopt` points at an existing artifact
  version's record — no copy, since stored dirs are never rewritten.
- **Store:** `worktrees/<slug>/live-artifacts/<taskId>/state.json`, owned by the app process only
  (`src/bun/live-artifact-store.ts`); the CLI goes through the socket, so there is one writer.
  Atomic write via a temp file in the same dir. Every document carries a `rev`; a write may pass
  `ifRev` and a stale one is refused. User writes append to a capped event log the agent reads with
  `dev3 live events`. Pure rules (names, limits, merge) live in `src/shared/live-artifact.ts`.
- **Two transports, one API.** `window.dev3.live` (`src/shared/live-artifact-client.ts`, serialized
  like the agent-message bridge) talks to the viewer by `postMessage` inside the app (viewer ->
  `liveArtifactOp` RPC, store changes pushed back as `liveArtifactChange`), and to the loopback live
  server by `fetch` + server-sent events in a browser tab. Both run `runLiveOp`
  (`src/bun/live-artifact-ops.ts`) as the user, so they cannot drift. Remote mode needs nothing new:
  its viewer uses the same RPC path.
- **Live server** (`src/bun/live-artifact-server.ts`): `127.0.0.1` only, never a fixed port — it binds
  the port this install (hash of `process.execPath`) used last, falling back to any free port, so
  prod/staging/dev builds never collide and bookmarks survive restarts. One origin, per-task
  unguessable token paths (`/<token>/`, token stored beside the store); `Host` must name the server
  (DNS rebinding) and writes must be same-origin JSON. Per-task `*.localhost` origins were dropped:
  not every browser resolves them, and the token already scopes every request.
- **Auto-reload with state kept.** In the viewer the live page is the last list entry, always
  "version 1", so a new page re-composes the frame and the existing draft-keeping
  (`decisions/2026/08/31/keep-unsent-artifact-input-across-versions.md`) puts input back with no
  banner. In a tab the client saves controls to `sessionStorage` and reloads on a `page` event.
- **Read-only after completion:** writes to a `completed`/`cancelled` task are refused.

## Risks

- JSON rewrite per mutation is O(store size); bounded by the caps in `LIVE_LIMITS`.
- Auto-reload with state kept (PR 3) restores controls by key into a changed page — a renamed field
  loses its draft; accepted by the user over the Refresh banner.
- An older app version ignores `liveArtifact` and shows nothing; the page stays reachable as a
  normal stored artifact on disk.

## Alternatives considered

- SQLite per task (the Hub's choice) — rejected for the driver split above; revisit if the store
  outgrows a JSON file.
- Versioning the live page like artifacts — rejected: the point is one URL whose content moves.
- A fixed port per install — rejected: prod, staging and dev builds run side by side and would
  collide.
