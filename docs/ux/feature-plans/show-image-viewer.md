# Feature plan — `dev3 show-image` + task-bound image viewer

Status: Planned (UX brief; no code yet)
Owner: UX Principal
Date: 2026-07-02
Related: UX_DECISIONS 2026-07-02 (show-image viewer), decision record (persistent per-task image store)

## 1. User job

Agents constantly produce visual artifacts the human should see — `agent-browser`
screenshots, rendered charts, generated images, diff/QA captures — but a terminal
cannot show pixels. The job: **let an agent surface one or more images to the human,
in-app, bound to the task it is working on**, with a **history** the human can click
back through (newest activated first). CLI shape requested by the user:

```
dev3 show-image path/1.jpg path/2.png ...
```

## 2. Classification

| Axis | Value |
|---|---|
| Feature class | `object_action` (produces task-scoped content) + a new **overlay viewer surface** + `notification` (arrival signal) |
| Owning object | **Task** (images belong to the task/worktree the agent is in) |
| Scope | single task |
| Frequency | occasional–constant (agents may push often) |
| Risk | safe (read-only display); the CLI reads local files the caller already owns |
| Trigger | a CLI command run by an agent inside a task worktree (cwd context) |

## 3. Placement decision

### 3.1 Viewer surface — a **lightbox overlay (Modal surface family)**, NOT a nav destination

- **Chosen:** a new `TaskImageViewer` overlay (dark full-bleed backdrop, one large
  image + a thumbnail/filmstrip rail for history, prev/next, Esc to close). It is a
  **Modal-family surface** (focused, transient, no routing), opened for a given
  `taskId` regardless of the current route — closing returns the user exactly where
  they were. Mounted once globally in `App.tsx` (like `ToastHost`/`ConfirmHost`),
  driven by imperative open state.
- **Rejected — new top-level destination / `stats`-style screen:** navigation holds
  *places*, not per-object content (nav budget ≤7, `navigation-destinations-only`).
  Per-task images are object content, not a workspace.
- **Rejected — a tab/section embedded in the `TaskInfoPanel` inspector:** the inspector
  is the densest surface in the app (§5.1 bar model, 34K) and the #1 button-creep
  pressure point. A gallery does not fit its height budget (`MAX_RATIO = 0.33`).
- **Rejected — toast-only:** toasts are transient and hold no history; they are the
  *arrival signal*, not the viewer.

Precedent: mirrors how the **Diff review viewer** is a dedicated full surface reached
from a task-scoped trigger, kept out of the inspector and out of navigation.

### 3.2 Entry points (how the viewer is opened)

1. **Arrival push (primary):** when `dev3 show-image` fires, the app receives a push
   event and:
   - appends the images to the task's persisted history, marks them **unseen**;
   - raises the **attention badge** on the task card (reuse the existing
     `cliAttention → addBell` path);
   - shows a **toast** `🖼 Agent shared N image(s)` whose `onClick` opens the viewer
     for that task at the newest image (reuse the `cliToast` path with a custom
     onClick).
   - **Auto-open** the viewer (newest active) **only when the user is already focused
     on that exact task** (route is that task, or the project board with it as the
     active task) **and** the window is foregrounded — i.e. never steal focus when the
     user is elsewhere. See §4.
2. **Inspector badge (reopen history):** a **conditional** image-count badge in the
   `TaskInfoPanel` **Context bar** (row 1, left), rendered **only when the task has
   ≥1 image** — placed next to the existing `diff_summary_badge` (both are
   "N artifacts to look at" `status` indicators, clickable to open their viewer). It
   is a status badge, not a persistent action button, so it does not structurally
   consume the bar's action budget; when there are no images it does not render.
3. **Command palette / native menu (discoverability + touch):** a `⇧⌘P` action entry
   "Show shared images" (context: task, enabled only when the active task has images)
   dispatched via `handleMenuAction`, plus the matching native-menu `Task` item. This
   guarantees a **touch-reachable** path on narrow/remote where the badge is the only
   pointer affordance.

**Optional (phase 2):** a small image-count indicator on the **task card** (like the
git badge, `status` role, conditional) so the board shows "this task has shared
images" without opening it. Held out of v1 to protect task-card density (≤2 inline);
the attention bell already signals arrival on the board.

### 3.3 Reject list (do NOT implement)

- No global-header button, no breadcrumb control (header = location + switching only).
- No always-visible inspector button — the badge is conditional on `count > 0`.
- No native OS dialog / `Utils.showMessageBox` (banned) — pure React overlay.
- No `window.open`/new window for images — render inside the app.

## 4. Arrival behavior (the key interaction decision)

Reconcile the user's "pop-up" intent with the north-star (§1.0: don't tax the human;
don't hijack focus unhelpfully).

**Recommended policy:**

| Situation | Behavior |
|---|---|
| Always | copy + persist images, mark unseen, raise attention badge + toast |
| User focused on **this** task, window foreground | **auto-open** the viewer at the newest image (you are already here — it "pops") |
| User elsewhere (other task / board / another screen) | **no focus-steal**; toast + attention badge; click either to open |

- The viewer always opens with the **newest image active**; the filmstrip shows the
  full history so the user can click back through older ones ("activate new first").
- On open, all shown images are marked **seen** (clears the unseen count/badge).
- A **Settings → Behavior** toggle `Auto-open shared images` (default **on**) lets
  users who dislike any pop disable auto-open and rely on badge + toast.

**Alternative considered — never auto-open (always badge + toast, user clicks to
open).** Cleaner "you jump to it" reading, zero interruption, but weaker for the
"agent is showing me something *now*" case. Offered as the toggle's off-state.

## 5. Data & transport

### 5.1 Persistence — copy into a **persistent per-task data dir** (additive)

- On `show-image`, the **bun** process (which can read the FS; the CLI and app share
  one host — remote only exposes the UI) copies each file into
  `~/.dev3.0/data/{slug}/task-images/{taskId}/<imageId>.<ext>`.
- Rationale: survives worktree destruction on task completion, works identically in
  **remote/browser** mode (the renderer cannot read local paths), and is **additive** —
  no rename/move/delete of existing on-disk state, respecting the frozen `~/.dev3.0/`
  layout invariants (AGENTS.md on-disk hard invariants). Mirrors the DnD-upload model
  (decision 036) but in the persistent `data/` tree rather than the ephemeral worktree
  `uploads/`.
- **Rejected — store the original path only:** breaks in browser mode and after the
  worktree/file is deleted (agent-browser screenshots in `/tmp` get GC'd).

### 5.2 Task model

Add to `Task` (`src/shared/types.ts`):

```ts
sharedImages?: SharedImage[];

interface SharedImage {
  id: string;            // uuid
  storedPath: string;    // ~/.dev3.0/data/{slug}/task-images/{taskId}/<id>.<ext>
  originalPath: string;  // what the agent passed (tooltip / provenance)
  name: string;          // basename
  mime: string;
  bytes: number;
  caption?: string;      // optional, from --caption
  createdAt: number;     // ms epoch
  seen?: boolean;
}
```

Persisted via the existing atomic task-write path (`src/bun/data.ts`,
`tasks.json`). **Retention:** cap at last **50 images/task**, dropping+deleting the
oldest beyond the cap at write time (bounded app-managed content cleanup, in the spirit
of the diff-review global sweep — not a load-time user-state migration). Plus a manual
**Clear images** action in the viewer (destructive, `confirm()`). *(Confirm the cap
with the user.)*

### 5.3 Rendering bytes to the webview

- New RPC `getSharedImage(taskId, imageId) → { dataUrl }` reads the stored file in bun
  and returns a base64 data URL. Works in **both** desktop and browser transports
  (same round-trip), consistent with the existing `uploadFileBase64` / `imageAttachments.ts`
  pattern. Thumbnails can reuse the same call (or a downscaled variant later).
- **Follow-up (perf):** if base64 proves heavy for many/large images, serve the
  `task-images/` tree via a custom protocol / the dev-server static route with the
  remote auth token. Not needed for v1.

### 5.4 CLI → app wiring (reuse the `notify`/`attention` machinery verbatim)

```
dev3 show-image a.png b.png [--task <id>] [--project <id>] [--caption "..."]
```

End-to-end (mirrors `dev3 notify`):
1. `src/cli/commands/show-image.ts` — parse positionals via `rejectUnknownFlags`,
   resolve each path to **absolute** (relative to cwd), validate existence +
   readability + supported raster type (`png/jpg/jpeg/gif/webp/bmp`; **exclude `svg`**
   for v1 — SVG-in-webview is an XSS vector), enforce a per-image size cap (~25 MB) and
   count cap (~20/call). Resolve task via `context.ts` (cwd) or `--task`/`--project`.
2. `sendRequest(socketPath, "ui.show-image", { taskId, projectId, paths, caption })`.
3. `src/bun/cli-socket-server.ts` — new `ui.show-image` handler: copy files → append
   to `task.sharedImages` → persist → `getPushMessage()?.("cliShowImage", { taskId, projectId, images, taskSeq, taskTitle, projectName })`. Return
   `{ ok, data: { stored, taskId } }`.
4. `src/mainview/rpc.ts` — add `cliShowImage` → `window.dispatchEvent(new CustomEvent("rpc:cliShowImage", …))`.
5. `src/mainview/App.tsx` — `useEffect` on `rpc:cliShowImage`: update state, raise
   badge, toast, and apply the §4 auto-open rule.

**Exit codes** (`src/shared/cli-exit-codes.ts`, existing): any invalid path →
`USAGE_ERROR (3)` fail-fast with the offending path named, nothing shown (agent
notices and fixes); app not running → `APP_NOT_RUNNING (2)`; success → `0`.
*(Fail-fast vs partial-success is a small call — recommending strict so the agent gets
a clear signal; note the trade-off.)*

## 6. Interaction details

- **Open:** newest image active; filmstrip rail (thumbnails) shows full history,
  scrollable; clicking a thumbnail activates it. Caption + `name` + relative time
  shown under the image; original path in a tooltip.
- **Keyboard:** `←/→` prev/next, `Esc` close, `Home/End` first/last. Modal-scoped
  (no new app-level shortcut → `keymap.ts` unaffected in v1).
- **States:** loading (spinner while bytes fetch), error (broken/missing file →
  inline "image unavailable" placeholder, never crash the viewer), empty (viewer only
  opens when ≥1 image exists).
- **Zoom (optional v1.1):** click-to-zoom / fit-to-window toggle.
- **Actions inside viewer:** copy image, reveal original path, **Clear images**
  (destructive, confirm). No task-lifecycle or git actions here (surface stays
  read/view only, like the diff viewer's non-mutation rule).

## 7. Tokens & a11y

- Backdrop `bg-overlay` / black scrim; chrome uses `bg-raised`/`border-edge`/`text-fg-*`.
  Buttons: prev/next/close = `ghost` icon (accessible label + tooltip); Clear =
  `destructive` ghost-danger. No hardcoded hex.
- Nerd Font image glyph for the badge/entry (e.g. `\u{F02E9}` md-image), per the
  icon convention.
- `role="dialog"`, focus trap, restore focus on close, backdrop-click / Esc dismiss.
  Filmstrip = a listbox; active thumb `aria-selected`.

## 8. Narrow viewport (<768, §12)

- Lightbox is full-bleed already; clamp any inner panel to `max-w-[calc(100vw-2rem)]`.
- Filmstrip → a bottom horizontal-scroll strip. Image area is **live-content**:
  axis-arbitrated horizontal **swipe** to change image + visible prev/next + dots
  (swipe never the only way). `prefers-reduced-motion` snaps.
- Touch entry = the inspector badge (≥44px) + the palette action entry (native menu
  absent in remote). **No feature is touch-unreachable.**

## 9. i18n / tips / changelog / decision record

- i18n keys (en/ru/es): toast text, viewer labels/buttons, empty/error states,
  Settings toggle label, palette/menu item.
- **Did-you-know tip** (1, `score: 4` — distinctive "agents show you screenshots
  in-app" capability): title 3–6 words, body ≤120 chars.
- Changelog entry (`feature-`), decision record (persistent per-task image store +
  arrival policy), keymap unaffected (no new app-level shortcut in v1).

## 10. Files likely to change (implementation, when approved)

- `src/cli/commands/show-image.ts` (new), `src/cli/main.ts` (register), `src/cli/context.ts` (reuse).
- `src/bun/cli-socket-server.ts` (`ui.show-image` handler + file copy + retention).
- `src/bun/data.ts` (persist `sharedImages`), `src/bun/paths.ts` (task-images dir helper).
- `src/shared/types.ts` (`SharedImage`, `Task.sharedImages`, `CliRequest` method).
- `src/mainview/rpc.ts` (`cliShowImage`, `getSharedImage`), `src/mainview/App.tsx`
  (listener + mount + auto-open rule + Settings toggle wiring).
- `src/mainview/components/TaskImageViewer.tsx` (new), `TaskInfoPanel` Context bar
  (conditional badge), `src/mainview/commands.ts` + `menuRouter.ts` + shared menu
  (palette/menu entry), `src/mainview/components/global-settings/*` (toggle).
- i18n `translations/{en,ru,es}/*`, `tips.ts`, `change-logs/…`, `decisions/NNN-…`.
- Tests: CLI parse/validate/exit-codes, socket handler (copy + retention + push),
  reducer, `TaskImageViewer` component, App listener + auto-open gating.
