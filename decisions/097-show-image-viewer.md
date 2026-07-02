# 097 — `dev3 show-image` + task-bound image viewer

## Context

Agents constantly produce visual artifacts the human should see (agent-browser
screenshots, rendered charts, QA captures), but a terminal can't render pixels.
We needed a channel for an agent to *show the human an image*, bound to its task,
with a browsable history.

## Decision

- **CLI:** `dev3 show-image <path...> [--caption "…"] [--task <id>]`
  (`src/cli/commands/show-image.ts`), wired in `src/cli/main.ts`. Paths are
  resolved to absolute, validated (exists, raster type, size), and sent as the
  `ui.show-image` socket method — mirroring `dev3 notify`/`attention`.
- **Transport:** the `ui.show-image` handler (`src/bun/cli-socket-server.ts`)
  copies each file, appends to `Task.sharedImages`, always pushes `taskUpdated`
  (badge/history), then pushes `cliShowImage` (toast + auto-open) unless focus
  mode is on. Renderer listens in `App.tsx` and mounts `TaskImageViewer`.
- **Storage — worktree, not `data/`:** files are copied to
  `~/.dev3.0/worktrees/<slug>/shared-images/` (`src/bun/shared-images.ts`), a
  sibling of the DnD `uploads/` dir (decision 036). This keeps them in the
  worktree tree (so they share its lifecycle) and is additive — no rename/delete
  of existing on-disk state, honouring the frozen `~/.dev3.0/` layout invariants.
  Bytes reach the webview through the existing `readImageBase64` RPC, so it works
  identically in desktop and remote/browser (the renderer never reads local paths).
- **Arrival behaviour:** auto-open the lightbox only when the user is already on
  that task and the window is foregrounded (never steal focus otherwise — north
  star §1.0); elsewhere a clickable toast + the attention badge. Toggle
  `dev3-auto-open-shared-images` in Settings → Behavior (default on).
- **Retention:** last 50 images/task, oldest pruned + files deleted at write time
  (`pruneSharedImages`). SVG excluded (webview XSS); 25 MB/image, 20/call caps.

## Risks

- Images die with the worktree on task completion (like DnD uploads) — accepted
  trade-off for keeping them in the worktree per the storage choice; history is
  for the active task, not a permanent archive.
- `readImageBase64` returns base64; very large/many images are heavier than a
  static route would be. Fine at the caps above; a custom protocol / dev-server
  static route is a noted follow-up.

## Alternatives considered

- **Store in `~/.dev3.0/data/<slug>/…`** (survives completion, was the original
  plan) — rejected on the user's call to keep it in the worktree next to uploads.
- **A new nav destination or an inspector tab** — rejected: per-object content is
  not a place (nav budget ≤7) and the inspector is the densest surface / #1
  button-creep risk. A Modal-family lightbox mirrors the diff viewer instead.
- **Toast-only** — no history; toast is the arrival signal, not the viewer.

See `docs/ux/feature-plans/show-image-viewer.md` and UX_DECISIONS 2026-07-02.
