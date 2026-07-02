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

## Addendum — viewer v2 (windowed + captions + scrim fix)

First cut shipped a full-bleed fullscreen lightbox. User feedback: it read as a
takeover ("why did it blur everything") rather than something bound to the task,
the image floated tiny (never upscaled), tall full-page captures collapsed to a
sliver, and on the desktop the terminal shone *through* the dark scrim.

- **Windowed by default (`TaskImageViewer.tsx`).** A centred modal card capped at
  ~85vw × 860px with the task board dimmed behind it, so it clearly belongs to
  the task. A **fullscreen toggle** (button or `f`) expands it to full-bleed for
  detailed viewing; `Esc` steps out of fullscreen first, then closes.
- **Image actually fills the frame.** Switched the `<img>` from `max-w/max-h`
  (caps at natural size → tiny) to `w-full h-full object-contain`, which scales up
  to the stage. Tall images (h/w ≥ 2.2) auto-switch to **fill-width + vertical
  scroll** (`w-full h-auto` in an `overflow-y-auto` stage) so a full-page capture
  is readable top-to-bottom; a per-image toggle flips between the two modes.
- **Scrim fix — hide the WebGL terminal.** ghostty-web's WebGL canvas is promoted
  to a WKWebView hardware overlay plane that paints above any DOM scrim (verified:
  the scrim is correct in a Chromium browser, leaks only in the desktop shell).
  The viewer sets `<html data-image-viewer="open">` and `index.css` hides
  `[data-terminal="true"]` via `visibility:hidden` (keeps its box → no ghostty
  reflow, snaps back on close).
- **Per-image captions.** `dev3 show-image` parsing is now order-aware: each
  `--caption`/`-c` binds to the image path it follows (`src/cli/commands/show-image.ts`),
  sent as `images:[{path,caption?}]` (handler keeps back-compat for the old
  `paths`+`caption`). Captions render as a readable, wrapping note bar under the
  image — the agent's voice on each shot. Skill text (`agent-skills.ts`) now tells
  agents to **proactively** show images they produce.
