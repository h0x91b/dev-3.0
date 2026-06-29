# UX Principal Report: Dev-server button running-state indicator

Date: 2026-06-29
Mode: planning + implementation brief
Manifest status: updated (token-role clarification appended)
Confidence: high

## 1. Feature understanding

- User job: at a glance, know whether this task's dev server is running, without clicking.
- Owning object/workflow: Task → Runtime & access bar (`TaskDevServer`, row-2-right of `TaskInfoPanel`).
- Feature class: **status** layered onto an existing **dev_server_action** control (no new action, no new button).
- Scope: single object (the active task's dev server).
- Frequency: constant (the control is always visible while the inspector is open).
- Risk: safe (the only state change is reflecting reality; start/stop already exist).
- Discoverability need: high — the whole point is a glanceable signal.
- Assumptions: `checkDevServer` (tmux `has-session`) is cheap enough to poll on a short interval; there are **no** push messages for dev-server status today.

## 2. UX placement decision

Recommended placement:

- Route/screen: task detail / split — `TaskInfoPanel` inspector.
- Surface: existing `TaskDevServer` control in the Runtime & access bar. **No new surface, no new button.**
- Entry point: unchanged — same single button.
- Visibility rule: unchanged (shown when the inspector renders for a non-virtual task).

Rejected placements:

- A separate "status" chip next to the button → adds a control to the densest surface (violates §5.1 budget / toolbar-creep anti-pattern). The state belongs **on** the existing button.
- A status dot on the `TaskCard` (board) → out of scope; the user asked specifically about the inspector button, and the card is a separate budget.

Rationale:

- The manifest already reserves the green `success` token for "running dev server" (bible §7 token table, `ux-architecture.yaml` tokens.semantic.success). The current code paints the button green **whenever a dev script exists**, even while stopped — that is the token misuse that makes the two states identical. Fixing the state-to-token mapping resolves the request with zero new chrome.

Evidence:

- `src/mainview/components/task-info-panel/TaskDevServer.tsx` (the button + dropdown)
- `docs/ux/PRODUCT_UX_BIBLE.md` §5.1 (bar model), §7 (success = running dev server)
- `docs/ux/ux-architecture.yaml` tokens.semantic.success.use_for

## 3. Navigation and menu changes

- Add: none. Rename: none. Move: none. Remove: none.
- No change to nav, palette, or menus.

## 4. Action hierarchy and token decisions

The single control renders four mutually-exclusive visual states. One control, state-driven styling.

| State | Condition | Semantic role / token | Icon / motion | Label | Click |
|---|---|---|---|---|---|
| No script | `!hasDevScript` | `warning` (dashed) — unchanged | static arrow | "Set up dev server" | hint popover (unchanged) |
| Stopped | hasScript, not running, task active | **neutral** (`text-fg-2`, solid `border-edge`, `hover:bg-elevated-hover`) | **play ▶** triangle | "Dev server" | start server |
| Starting | transient: start/restart in flight | neutral, `text-fg-3`, non-interactive | **`animate-spin` ring** | "Starting…" | no-op |
| Running | hasScript, running, task active | **`success`** (green text + `border-success/30` + `hover:bg-success/15`) | **pulsing green dot** (`animate-pulse`), reduced-motion → steady dot | "Dev server" | open Restart/Stop dropdown |
| Inactive task | `!isTaskActive` | `text-fg-muted/50`, disabled — unchanged | static arrow | "Dev server" | no-op |

Decisive token rule: **green ⇒ running only.** Stopped is neutral. This is the change.

## 5. Layout and component plan

- Screen pattern: in-place state machine on one button; same footprint.
- Components to reuse: existing button markup; idiomatic spinner (`w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin`, cf. `TerminalPreviewPopover`/`TaskCard`) and the live-dot pattern (`w-2 h-2 rounded-full bg-success animate-pulse`, cf. `BugHuntersLightbox`/`SpawnAgentModal`); `useReducedMotion()`.
- New components allowed: none.
- Components not allowed: no new status chip/badge component, no second button.
- Data density: unchanged (icon swaps in place; label width roughly constant).
- Progressive disclosure: Restart/Stop stay in the existing dropdown (running state only).

## 6. Interaction contract

- Trigger: same button. Behavior per state above.
- Preconditions: live running state must be tracked in the component (it currently is not).
- Default state: on mount, optimistic "stopped/unknown" → first poll resolves it.
- Loading/transient: "Starting…" spinner shown optimistically the moment start/restart is clicked, cleared when the next status check confirms running (or on error).
- Error state: on RPC failure, toast (existing) + fall back to last-known/stopped styling.
- Success state: running → green + pulsing dot.
- Confirmation/undo: Stop stays in the dropdown (no extra confirm — already one click deep, reversible by restart).
- Keyboard and focus: unchanged; global `:focus-visible` ring applies.
- Responsive: unchanged.

### State source (implementation note — NOT a new action)

There are no push messages. Track running state by:
1. Poll `checkDevServer({taskId, projectId})` on mount and on an interval (~4-5s) while mounted, task active, and `hasDevScript`. It is a tmux `has-session` check — cheap.
2. Set `starting` optimistically on start/restart click; set `stopped` optimistically on stop; reconcile with the next poll and with the RPC responses.
3. Pause the interval when `document.hidden` (visibilitychange) to avoid background churn.

## 7. Accessibility requirements

- Accessible names: per-state `title` / `aria-label` — "Dev server stopped — click to start", "Dev server starting…", "Dev server running — click for options", "Set up dev server".
- `aria-busy={starting}` during the transient phase.
- Motion: the running pulse and the starting spin must be gated by `useReducedMotion()` → steady dot / static icon when the user prefers reduced motion.
- Contrast: success/neutral tokens already meet contrast in both themes; no new tokens.
- Do not rely on color alone — the icon (play vs dot vs spinner) and label ("Starting…") carry the state too.

## 8. Manifest updates

Files updated:

- `docs/ux/UX_DECISIONS.md`: appended the 2026-06-29 token-role clarification (green = running only; spinner = transient only; pulse-dot = steady alive).
- `docs/ux/UX_MANIFEST_CHANGELOG.md`: appended entry.
- `docs/ux/ux-architecture.yaml`: no structural change (no new object/route/surface/budget). The success token's existing `use_for: "...running dev server"` already covers this; the decision record sharpens "running **only**".

## 9. Implementation brief for coding agent

Implement exactly this in `src/mainview/components/task-info-panel/TaskDevServer.tsx`:

1. Add running-state tracking: `type DevState = "unknown" | "stopped" | "starting" | "running"`. Poll `checkDevServer` on mount + ~4500ms interval (guard: mounted, `isTaskActive`, `hasDevScript`); pause on `document.hidden`.
2. `handleDevServer`: when stopped → set `starting`, await `runDevServer`, then set from result/poll; when running → open dropdown (current behavior). Restart → set `starting` around `restartDevServer`. Stop → set `stopped` optimistically around `stopDevServer`.
3. Style the button by state per §4: **stopped = neutral** (drop the always-green classes), **running = green + pulsing dot**, **starting = spinner + "Starting…"**, no-script/inactive unchanged.
4. Swap the leading glyph: play ▶ (stopped) / spinner (starting) / pulsing dot (running). Gate pulse + spin with `useReducedMotion()`.
5. Per-state `title`/`aria-label` + `aria-busy` (§7). Add i18n keys (`header.devServerStarting`, `header.devServerRunningTitle`, `header.devServerStoppedTitle`, etc.) in en/ru/es.
6. Tests: extend `TaskInfoPanel.test.tsx` — mock `checkDevServer` → running shows green/dot, stopped shows neutral/play, start click shows "Starting…". Add a feature changelog entry. Add 1 "Did you know?" tip (small feature → 1).

Do not implement:

- No new button, chip, or surface. No card/board indicator. No new color token. No confirm dialog for stop. No push-message backend (polling is sufficient and in-scope).

Likely files: `TaskDevServer.tsx`, `i18n/translations/{en,ru,es}/common.ts` (header.*), `__tests__/TaskInfoPanel.test.tsx`, `tips.ts` + tip i18n, `change-logs/2026/06/29/`.

Acceptance criteria:

- Stopped and running are unmistakably different at a glance (neutral+play vs green+pulsing dot).
- A spinner appears only during start/restart, never as the steady running signal.
- State reflects reality within ~5s without user interaction, and immediately (optimistically) on click.
- Reduced-motion users get steady (non-animated) equivalents.
- `bun run lint` + `bun run test` green.
