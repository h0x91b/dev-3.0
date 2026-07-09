# UX Decisions

Compact index of UX architecture decisions — the *why* behind rules that live in
`PRODUCT_UX_BIBLE.md` / `ux-architecture.yaml`. Max ~5 lines per entry; details live in
git history, PRs, and `decisions/NNN-*.md`. Newest first.

## 2026-07-10 — Diagnostics: in-UI crash/error surface for remote/mobile

- **Rule:** One framework-agnostic diagnostics store feeds three surfaces — a provider-wrapping `RootErrorBoundary` (self-contained English fallback), a phase+timeout `BootstrapScreen` (Retry/Reload replaces the bare spinner), and a `DiagnosticsPanel` opened from a floating pill that appears ONLY in remote mode when `errorCount > 0` (plus a pre-React loader in `index.html`).
- **Why:** Mobile/remote users have no devtools; crashes blanked the page and stuck loads spun silently. Rejected a permanent header/menu diagnostics button (button-creep, and dead on a crashed tree) and an external error reporter (doesn't let the user see/copy it on the phone). The pill is earned, not permanent.
- **Status:** Observed. Evidence: `diagnostics.ts`, `RootErrorBoundary.tsx`, `BootstrapScreen.tsx`, `DiagnosticsPanel.tsx`, `DiagnosticsIndicator.tsx`; bible §5.5.

## 2026-07-09 — HTML Artifacts: sandboxed task workspace + separate Runtime control

- **Rule:** `SharedArtifact` is a task-owned HTML output opened in a resizable workspace beside the terminal (one-at-a-time on narrow), with opaque-origin iframe sandbox + network-blocking CSP, live dev3 theme tokens, and HTML/ZIP download; Runtime keeps `Images` and `Artifacts` as separate conditional controls, an explicit budget exception chosen by the user.
- **Why:** Interactive reports need to stay portable and usable alongside the agent; rejected a modal (blocks terminal), a TSX/backend mini-runtime (server/dependency/share burden), and a merged Outputs button (user requires distinct identities).
- **Status:** Observed. Evidence: `TaskArtifactViewer.tsx`, `TaskWorkspacePane.tsx`, `shared-artifacts.ts`, decision 120.

## 2026-07-06 — Feature-gated preset: shown-but-disabled + deep-link to enable

- **Rule:** a preset that depends on an off-by-default capability (e.g. `requiresPxpipeProxy`) stays **visible** in the Provider→Model→Mode picker but renders **disabled** (`Select` disabled option, muted + lock glyph) until enabled; clicking it does not select — it fires a clickable `info` toast that deep-links (window `OPEN_SETTINGS_SECTION_EVENT` → `Route.section`) to the Global Settings section that turns it on. Its manager is a normal settings section (configuration lives in settings).
- **Why:** the user must be able to *discover* the capability without it silently launching a heavy/experimental dependency. Rejected: hiding the preset until enabled (undiscoverable) and auto-starting the dependency on selection (hidden side effect).
- **Status:** Implemented. Evidence: bible §10 (feature-gated preset row), `AgentConfigPicker.tsx`, `Select.tsx`, `PxpipeProxySettingsSection.tsx`, `decisions/112-pxpipe-cost-trick-preset.md`.

## 2026-07-05 — Automations: project-settings tab; runs are ordinary tasks

- **Rule:** The `Automation` object (RRULE+tz schedule + prompt + agent, per project) is durable configuration → CRUD lives in a 4th `ProjectSettings` tab (tabs 3→4, budget ≤6); each fire creates a **normal task** on the board (clock-glyph provenance on the card); run history + missed-run status render only inside the tab; failures/missed runs surface via toast + status, never silently.
- **Why:** configuration-in-settings rule + nav budget ≤7. Rejected: a top-level "Automations" destination (a single-feature screen violates the nav budget) and a board-level panel (durable config on an operational surface).
- **Status:** Observed. Evidence: bible §3 (Automation), yaml `objects.automation`, `ProjectSettings.tsx`, `automations-scheduler.ts`.

## 2026-07-05 — Agent rate-limit indicator is ambient header status, not a cockpit metric

- **Rule:** account-wide agent rate-limit usage renders as a passive icon+percent indicator in the global header's stateful-indicators zone (next to prevent-sleep); hidden until data exists, `warning` token ≥80%, `danger` ≥95%; its enable toggle lives in Global Settings → Behavior.
- **Why:** it is a diagnostic "battery gauge" the user must see before hitting a limit — not a motivational countable signal (cockpit rejected) and not task-scoped (task surfaces rejected).
- **Status:** Implemented. Evidence: `GlobalHeader.tsx`, `ux-architecture.yaml` global_header.allowed.
## 2026-07-03 — Inline help: one registry, three layers (Tooltip / HelpSpot / help mode)

- **Rule:** Help content lives in a `src/mainview/help.ts` registry (declare-as-data, like `keymap.ts`/`tips.ts`); a fast `Tooltip` primitive progressively replaces native `title=` on icon controls; a ghost (i) `HelpSpot` → rich read-only `HelpCard` is allowed only in header-bearing sections (≤1 each); dense headerless zones (inspector quickbars, task card) are covered by a screen-wide help-mode overlay (`⇧⌘/`, Help menu, palette, kebab on narrow) via `data-help-id` — never by permanent icons. Bible §5.4.
- **Why:** Native `title=` (~227 usages) is slow and control-scoped, and per-section (i) icons everywhere would be toolbar-button-creep wearing a help hat. Rejected: (i) in every zone (creep); help-mode-only (no ambient discoverability); tooltip-migration-only (explains buttons, not sections).
- **Status:** Observed. Evidence: bible §5.4, yaml `surfaces.inline_help`, `help.ts`, `Tooltip.tsx`, `HelpSpot.tsx`, `HelpCard.tsx`, `HelpOverlay.tsx`.

## 2026-07-03 — Close Pane: two-step visual pane picker (no new button; destructive gets spatial friction)

- **Rule:** The red Close Pane control (inspector `tmux_controls` + native menu) no longer blind-kills the active pane — it arms a transient overlay over the terminal that draws one hit-box per pane from real tmux geometry (cells → %, PaneMapSheet math); hover arms a pane in `danger` red (idle = neutral `accent` marching-ants), click kills exactly it, Esc / scrim cancels, last-pane kill routes through the `confirm()` service. Narrow/touch keeps the old direct-kill (no hover). No new toolbar button.
- **Why:** Blind-kill closed the wrong pane and gave a destructive action zero friction; a spatial two-step pick supplies the friction + `destructive` token + confirmation the rubric wants while adding zero chrome (avoids toolbar-button-creep, the #1 anti-pattern) and reusing the mini-map geometry. Rejected: a dropdown pane list (loses the on-screen spatial mapping); a persistent per-pane close affordance (control creep). Decision 101.
- **Status:** Observed (verified in-browser). Evidence: `ClosePanePicker.tsx`, `close-pane-picker.ts`, `rpc-handlers/tmux-pty.ts` (tmuxKillPane), `TaskTmuxControls.tsx`, `menuRouter.ts`.

## 2026-07-03 — Agent picker: Provider → Model → Mode cascade (UI-only grouping, flat `configId` stays the key)

- **Rule:** The launch picker's 3-field cascade is a presentation grouping over the existing flat preset list — the selected leaf resolves to a single `configId`, which stays the durable storage key and command-resolution unit; no data-model decomposition, no migration. Optional `groupLabel?`/`modeLabel?` on `AgentConfiguration` override derivation only when curation beats it. Changing Model preserves the current Mode kind when it exists in the new group (bible §1.0).
- **Why:** Provider matrices are irregular and curated (Codex encodes effort×sandbox in `additionalArgs`, OpenCode's 2nd axis is a persona) — a decomposed `model × mode` cross-product would generate invalid combos, lose per-preset curation, and force a `configId` migration across app versions sharing `~/.dev3.0/` (frozen-layout risk). Rejected: data-model decomposition; optgroup subheaders in one long dropdown (doesn't reduce choice per step).
- **Status:** Observed. Evidence: `LaunchVariantsModal.tsx`, `utils/agentPicker.ts`, `shared/types.ts`.

## 2026-07-02 — Mobile terminal input: docked composer default + sticky raw-mode toggle

- **Rule:** On touch in browser mode (gate = `!isElectrobun && isTouchDevice`, NOT width) the terminal never summons the OSK; a docked chat-style composer owns text entry (Send = mode-2004-aware paste + Enter), with a sticky `⌨` raw toggle on `ExtraKeyBar` restoring direct typing. Bible §12.
- **Why:** OSK leaves ~4 terminal rows — compose-then-paste with the tail visible is the converged industry pattern (Termius/Blink/Happy); rejected fullscreen-compose-default (hides the agent's question) and raw-only chrome collapse (typing stays miserable).
- **Status:** Observed (shipped 2026-07-03). Evidence: `TerminalComposer.tsx`, `TerminalView.tsx`, `ExtraKeyBar.tsx`.

## 2026-07-02 — Shared-images re-open control: a Runtime-bar button, not an inspector chip

- **Rule:** Access-to-produced-output controls belong in the inspector's Runtime & access bar (row 2 right); the images button renders only when count > 0 and is a relocation, not an addition. Bible §5.1.
- **Why:** The Context-bar chip read as passive metadata and was undiscoverable; row 2 is the "Outputs" domain (open-in, dev-server) so produced screenshots belong there; rejected duplicating the control (bar creep) and an always-visible disabled button at zero.
- **Status:** Observed (2026-07-02). Evidence: `task-info-panel/TaskSharedImages.tsx`, `TaskInfoPanel.tsx`.

## 2026-07-02 — Task image viewer v2: windowed card, fill-to-frame, per-image captions

- **Rule:** The image viewer is a centred windowed modal card (~85vw, fullscreen one keypress away), images fill the frame, tall captures auto-switch to fill-width + vertical scroll, and each `--caption` annotates the image it follows.
- **Why:** A full-bleed takeover didn't read as task-bound and never upscaled small captures; ghostty's WebGL canvas paints above DOM scrims in the desktop shell, so the viewer hides `[data-terminal]` via `visibility:hidden` while open. Decision 097 (addendum).
- **Status:** Observed (2026-07-02, verified in-browser). Evidence: `TaskImageViewer.tsx`, `src/cli/commands/show-image.ts`.

## 2026-07-02 — `dev3 show-image` + a task-bound image viewer (new lightbox overlay surface)

- **Rule:** Agent-surfaced images open in a global lightbox overlay (Modal family, not a destination, not the inspector); arrival raises the attention badge + toast, auto-opens only when the user is already focused on that task; a conditional count badge appears next to the diff badge. Bible §5, §12.3.
- **Why:** The missing "agent shows the human a picture" channel; mirrors the diff viewer (task-scoped full surface kept out of nav to protect the ≤7 nav budget and inspector density); files stored in the task worktree (`shared-images/`, additive to the frozen `~/.dev3.0/` layout). Rejected: new destination, inspector tab, toast-only (no history). Decision 097.
- **Status:** Observed (2026-07-02). Evidence: `src/bun/shared-images.ts`, `TaskImageViewer.tsx`, `cli-socket-server.ts`.

## 2026-07-02 — Period navigation on the Velocity Cockpit (temporal nav ≠ a forbidden control)

- **Rule:** The read-only stats cockpit may gain navigation along the time axis (prev/next period stepper; offset ephemeral, lifetime views stay anchored to now) — but never data filters on new dimensions, mutations, or durable config. Bible §1.1, `stats_dashboard.allowed/forbidden`.
- **Why:** Temporal nav extends the existing time-range switch on the same axis (no new control class); rejected a date picker (turns the celebration surface into an operator console).
- **Status:** Observed. Evidence: `stats/PeriodStepper.tsx`, `utils/productivityStats.ts` (`offset`).

## 2026-06-29 — Dashboard Activity: narrow-viewport action sheet (corrects the "OK" verdict)

- **Rule:** On narrow viewports the dashboard project-row action cluster + reorder collapse into a kebab → `BottomSheet`; touch targets ≥44px; no feature may be touch-unreachable. Bible §12.3/§12.6.
- **Why:** Audit showed the "narrow = OK" verdict was wrong: non-wrapping icon row, ~28px targets, reorder fully touch-dead (HTML5 drag + `hidden md:flex` steps); the doctrine's kebab→sheet fixes all three with zero desktop change.
- **Status:** Observed (2026-06-29). Evidence: `ActivityOverview.tsx`.

## 2026-06-29 — Narrow-viewport tmux windows switcher (pairs with the panes switcher)

- **Rule:** Sub-768px terminals get a windows switcher bar above the panes bar (buttons + dropdown, NO swipe — the pane carousel owns horizontal swipe on that surface), shown only when window count > 1.
- **Why:** Windows were the one terminal affordance with no mobile form (doctrine §4); reuses the panes-switcher idiom; a dedicated `tmuxWindowNavigate` RPC returns layout (same reason `tmuxPaneNavigate` exists). Decision 093.
- **Status:** Observed (2026-06-29). Evidence: `MobileWindowCarousel.tsx`, `rpc-handlers/tmux-pty.ts`.

## 2026-06-29 — Dev-server button states: green = running only, spinner = transient only

- **Rule:** The `success` green token means a *running* dev server only (configured-but-stopped = neutral); spinners are reserved for transient start/restart; a healthy long-running process shows a calm pulsing dot. Bible §7, §5.1.
- **Why:** The button painted green for any task with a dev script, misusing the token; a perpetual spinner reads as "stuck loading" — the pulsing-dot idiom already used by `BugHuntersLightbox` signals "alive" without anxiety.
- **Status:** Observed (shipped in #754). Evidence: `task-info-panel/TaskDevServer.tsx`.

## 2026-06-29 — Alt/Option-click moves the shell cursor (terminal expert gesture, no chrome)

- **Rule:** Expert pointer gestures layered on the terminal surface add zero chrome (no keymap entry, no menu/setting — a tip is the only discoverability); the shell-vs-TUI decision must live on the backend (tmux `pane_current_command`), never on renderer mouse-tracking state.
- **Why:** dev3's tmux runs `mouse on`, so SGR tracking is always on and the renderer can't distinguish a shell from vim/htop; backend gating keeps the gesture inert in mouse-owning TUIs. Decision 098.
- **Status:** Observed. Evidence: `src/bun/tmux-alt-click.ts`, `TerminalView.tsx`.

## 2026-06-29 — Instrument & celebrate: countable progress feeds the Velocity Cockpit (standing rule)

- **Rule:** New features producing countable, repeatable signals should emit them into the stats pipeline at build time and surface a cockpit visualization when motivational; the cockpit stays read-only, honest (no backfill, no inflation), and diagnostic metrics stay off it. Bible §1.1, `placement_rules.instrument-and-surface-countable-metrics`.
- **Why:** The cockpit compounds value only if features feed it by default; guardrails (read-only, complexity+honesty budget) prevent it becoming a bloat license.
- **Status:** Proposed (standing practice; cockpit itself Observed).

## 2026-06-28 — Productivity Stats "flair" pass: animations, heatmap, milestones, momentum headline

- **Rule:** The stats showcase may gain motivational polish (boot animations gated by `useReducedMotion`, a range-independent 12-month heatmap, lifetime milestone medals, a momentum headline) but zero new controls; achievement semantics get their own tokens (`--stat-gold`, `--stat-fire`) rather than overloading accent/danger.
- **Why:** Vanity surface — "feel alive and rewarding" is on-brief; a "this week" heatmap is meaningless so the year grid stays range-independent; verifiable logic lives in the pure engine.
- **Status:** Observed (2026-06-28). Evidence: `utils/productivityStats.ts`, `components/stats/*`.

## 2026-06-28 — Productivity Stats is a new top-level destination, entered from the Dashboard

- **Rule:** A read-only stats screen is a genuine durable place → earns a top-level destination (nav budget stays ≤7); entry via Dashboard card + View menu + ⇧⌘P — explicitly NO GlobalHeader button.
- **Why:** Serves the developer-speed positioning; the user chose the Dashboard card over header chrome; LOC is forward-only (captured at completion, decision 084) so the views show an honest "tracking since". Rejected: a panel inside the Dashboard list, a Settings home.
- **Status:** Observed (2026-06-28). Evidence: `ProductivityStatsView.tsx`, `rpc-handlers/productivity-stats.ts`.

## 2026-06-28 — `dev3 remote` backgrounds by default (user-first CLI default)

- **Rule:** Hand-typed CLI commands default to what a lazy human wants (detach + print link + return the shell); machine/supervised callers (systemd, Docker, skills) pay the explicit `--no-detach`. Bible §1.0.
- **Why:** The Unix foreground-daemon convention optimizes for supervisors, but the primary caller here is a human; rejected keeping foreground default (taxes the human to please a convention that doesn't bind them).
- **Status:** Observed. Evidence: `src/cli/commands/remote.ts`, `remote-service.ts`.

## 2026-06-28 — Browser-mode application menu bar (the native menu's stand-in in Remote Access)

- **Rule:** Browser mode renders its own `AppMenuBar` above `GlobalHeader`, built from the SAME `buildApplicationMenu` source as the native menu (relocated to `src/shared/`) — one definition, no RPC, no drift; items not covered by `menuRouter` browser handlers are dropped; labels stay English (documented exception). Never mounted in Electrobun.
- **Why:** Remote mode lost the canonical action surface; a fresh top strip adds zero pressure to the dense header cluster; rejected merging into `GlobalHeader`, a `getApplicationMenu` RPC, and duplicating the menu (guaranteed drift).
- **Status:** Observed. Evidence: `src/shared/application-menu.ts`, `AppMenuBar.tsx`, `menuRouter.ts`.

## 2026-06-28 — Narrow-viewport (mobile) doctrine: carousel/one-at-a-time everywhere

- **Rule:** On sub-768px show exactly one sibling at a time with swipe + visible pager; gate layout on reactive `useNarrowViewport(768)` (never `isElectrobun`, never mount-once `useMobile`); full-surface swipe only on scroll-body surfaces (never live-content like terminals/diffs); every swipe has button+keyboard equivalents; `BottomSheet` is the mandated mobile action surface; no feature may be touch-unreachable. Bible §12 + yaml `responsive`.
- **Why:** Phone-over-remote is the real secondary form factor; generalising the proven board carousel avoids forking a separate mobile app; the breakpoint reconciliation fixed a real 1024-vs-768 doc/code mismatch.
- **Status:** Observed (board + terminal + header + inspector shipped; rest tracked per-surface in yaml `surface_adaptation`).

## 2026-06-28 — Remote Access modal: network-interface (IP) selector, tunnel-off only

- **Rule:** When the tunnel is off, a styled native `<select>` above the URL block lists candidate IPv4s (+ loopback) and rebuilds URL/QR; hidden when the tunnel is on; requested host validated against the enumerated allow-list; session-local.
- **Why:** Auto-picking one interface breaks on multi-homed boxes (VPN/Docker/multiple NICs) and blocks the SSH-forward `localhost` path; configuration inside an existing modal = no new surface; native `<select>` reuses the `ProjectSettings` pattern and is not a banned OS dialog.
- **Status:** Observed. Evidence: `remote-access-server.ts`, `rpc-handlers/remote-access.ts` (`host` param).

## 2026-06-27 — Global keyboard focus ring (`:focus-visible`) as the single focus affordance

- **Rule:** Focus indication is one global `:focus-visible` accent outline in `index.css` (keyboard/AT only, never mouse), authored after `@tailwind utilities` to beat `.outline-none`; modal shells (`[tabindex="-1"]`) exempted. Documented in `DESIGN.md`.
- **Why:** App-wide accessibility affordance belongs in the base stylesheet, not scattered across ~29 `outline-none` components; rejected Tailwind ring classes per component and a new focus token (accent already is the focus color).
- **Status:** Observed (2026-06-27). Evidence: `src/mainview/index.css`, `DESIGN.md`.

## 2026-06-24 — Built-in Operations board: pinned-first, ⌘0, and a "system object" identity

- **Rule:** The built-in Operations board (`kind: "virtual"` + `builtin: true`) is pinned first everywhere (`orderProjectsForDisplay`), owns `⌘0` (excluded from ⌘1-9; zoom-reset moved to ⇧⌘0), and reads as a system object (bracketed localized name + ⚡ + SYSTEM badge) — no new object, destination, or color token.
- **Why:** Structurally special (app-provisioned, undeletable) so it must not read as "just another project"; bracketed-name treatment chosen over a new violet token to avoid theme churn; virtual tasks drop Git/Dev-Server/Scripts inspector controls (net budget reduction).
- **Status:** Observed (2026-06-24). Evidence: `shared/types.ts` (`isBuiltinOpsProject`), `App.tsx`, `ActivityOverview.tsx`.

## 2026-06-23 — Virtual "Operations" board: repo-less ad-hoc work as `Project.kind: "virtual"`

- **Rule:** Repo-less work is a new *kind* of the existing Project object — same dashboard/board/cards/labels stack, git domain hidden entirely, simplified columns; virtual projects live in a separate `~/.dev3.0/virtual-projects.json` (parallel-path rule 5) with synthetic never-reused `~/.dev3.0/ops/<slug>` paths so `projectSlug()`/CLI context stay untouched; working dir is a managed temp folder by default.
- **Why:** A new kind keeps IA/nav/components unchanged while switching git off where meaningless; rejected a new top-level nav entry, a parallel Workspace object (~90% overlap), and a no-worktree flag inside git projects (breaks diff/PR semantics). Directory hidden by default to kill the onboarding problem.
- **Status:** Observed (shipped 2026-06-23 in 6 stages; replaced `home-terminal`, ⇧⌘` = Quick-shell operation). Full spec in git history.

## 2026-06-22 — Feature-discovery tips are surface-aware and distributed beyond the board

- **Rule:** Tips carry a required `contexts` field used as a sort *boost, never a filter* (matching tips lead, then the full catalogue cycles); the `ActiveTasksSidebar` is the tip carrier for the task/terminal view via the shared `useTipRotation` hook.
- **Why:** Tips previously reached only the Kanban board, so terminal-surface discovery facts never reached terminal dwellers; boost-not-filter keeps every surface cycling everything. Rejected: a ticker (annoying), a permanent terminal footer (chrome creep), an exclusive-context flag.
- **Status:** Observed. Evidence: `tips.ts` (`TipContext`), `hooks/useTipRotation.ts`.

## 2026-06-22 — Active Tasks sidebar: within-group ordering is oldest-first (work-queue, not feed)

- **Rule:** Sidebar groups sort oldest-first by `movedAt`, uniform across all groups; the sidebar does NOT reuse the kanban's `sortTasksForColumn`.
- **Why:** A queue must surface the longest-waiting (most starvation-prone, often agent-blocked-on-user) task first — matching the attention/bell scope's oldest-first; a per-group direction split breaks scan predictability. Known trade-off: variant siblings can separate.
- **Status:** Observed. Evidence: `ActiveTasksSidebar.tsx`.

## 2026-06-21 — Hint navigation is a cross-surface primitive; keyboard-first expert layer

- **Rule:** The Vimium-style `HintOverlay` is surface-agnostic (scans `[data-hint-id]` on the innermost clickable element); hints map to navigation/open destinations only — never mutations or destructive actions; bare/sequence keys match on `e.code` (layout-independent).
- **Why:** Generalizing the existing overlay avoids per-surface clones; `e.key` matching made the feature Latin-layout-only (the real bug); `g`-prefix go-to + `/` + `c` follow Linear/GitHub conventions. Decision 076.
- **Status:** Observed. Evidence: `HintOverlay.tsx`, `utils/hintLabels.ts`, `App.tsx`.

## 2026-06-19 — Diff review is a 3-day persisted safety net + explicit "Reset review"

- **Rule:** Inline diff reviews persist in `localStorage` with a 3-day TTL (safety net, not a store); clipboard is transport only; `Reset review` is destructive-styled, confirm-gated, visible only with ≥1 comment; the whole review lifecycle stays inside the diff viewer surface (documented as bible §5.2).
- **Why:** Reviews previously lived in volatile clipboard + React state and were lost to accidental terminal selections; permanent storage was over-scoped (stale accumulation) — 3 days covers the realistic re-copy window; a backend file store rejected (RPC plumbing + touching the frozen `~/.dev3.0/` zone for ephemeral drafts).
- **Status:** Observed. Evidence: `TaskDiffViewer.tsx` (`pruneExpiredReviews`).

## 2026-06-19 — Keyboard-shortcut registry as single source of truth + two-tab reference overlay

- **Rule:** `src/mainview/keymap.ts` is the single source of truth for app-level shortcuts (drives the two-tab App|Terminal `KeyboardShortcutsModal`, README, website); the registry documents — the `App.tsx` handler chain stays the dispatcher; entry via Help menu + ⌘/ + palette, never a toolbar button or nav destination.
- **Why:** Registry-driven dispatch was rejected as a risky rewrite of edge-case-heavy central code (capture phase, terminal focus, `e.code`); a vitest test guards drift instead; ⌘/ over bare `?` because the live terminal must still receive `?`.
- **Status:** Observed (shipped; also codified in AGENTS.md). Evidence: `keymap.ts`, `KeyboardShortcutsModal.tsx`, `__tests__/keymap.test.ts`.

## 2026-06-19 — Both palettes surfaced in the native View menu (discoverability)

- **Rule:** Keyboard-only surfaces still get native-menu entries (the menu is the canonical action surface); chord accelerators can't be bound in Electrobun (single-char only, decision 044) so the chord is shown in the label text and the keydown handlers stay the sole shortcut owners.
- **Why:** A native accelerator would double-fire against the toggle handlers. Decision 074.
- **Status:** Observed. Evidence: `application-menu.ts`, `menuRouter.ts`.

## 2026-06-18 — Action palette (⇧⌘P): two-surfaces-one-shell; DOM mirror of the native menu

- **Rule:** Navigation (⌘K) and actions (⇧⌘P) are two surfaces on one extracted `PaletteShell`; the action palette runs commands via the existing `handleMenuAction` router (a mirror, not a second command runner); destructive lifecycle + modal flows are excluded by policy (destructive needs friction, not fuzzy-Enter); language-switch labels stay identical across locales so English is always findable.
- **Why:** VSCode's chord convention; routing through `handleMenuAction` also fixed several previously-inert native menu items. Decision 072.
- **Status:** Observed. Evidence: `CommandPaletteModal.tsx`, `commands.ts`, `PaletteShell.tsx`.

## 2026-06-18 — Command palette (⌘K) introduced as a new surface

- **Rule:** ⌘K is the type-to-find navigation surface (keyboard-only, zero visible chrome — no toolbar-creep); short UI entities must reuse `utils/fuzzyMatch.ts` as the single matcher (BM25 stays for long transcripts only); ⌘K = navigation, ⇧⌘P = actions, kept separate.
- **Why:** `Cmd+T` rejected — universal "new tab" and intercepted by the live terminal; ⌘K is the Slack/Linear/Notion convention. Distinct from the Option+Tab switcher (MRU over *active* tasks vs type-search over all entities).
- **Status:** Observed. Evidence: `ProjectQuickSwitchModal.tsx`, `utils/fuzzyMatch.ts`.

## 2026-06-15 — Option+Tab task switcher is a transient HUD overlay, NOT a command palette

- **Rule:** The task switcher is an `expert_shortcut` rendering the existing `task_jump` action class as a hold-cycle HUD (Option+Tab project / Option+Shift+Tab global; Ctrl+Tab on Linux); MRU in-memory order; live Shift scope toggle; commit respects `dev3-task-open-mode`.
- **Why:** A command palette was rejected — the sidebar already owns `task_jump` and a new global palette would be surface creep; MRU matches the alt-tab muscle memory the user explicitly invoked. Decision 069.
- **Status:** Observed. Evidence: `TaskSwitcherOverlay.tsx`.

## 2026-06-16 — Browser-style back/forward navigation in the global header

- **Rule:** History arrows live at the far LEFT of the header breadcrumb row (navigation belongs with the "address bar", not the action cluster), as a segmented pill of two icon-only chevrons; ⌘[/⌘] + mouse side buttons drive the existing `state.ts` route-history stack.
- **Why:** Bare chevrons didn't read as a control (looked decorative); the segmented group is the universal back/forward affordance; far-left placement adds zero pressure to the dense right cluster. History dropdown rejected as scope creep.
- **Status:** Observed. Evidence: `GlobalHeader.tsx`, `App.tsx`, `state.ts`.

## 2026-06-15 — Compact status-age badge on Active Tasks sidebar cards

- **Rule:** Status-age is a read-only `status` indicator (consumes no action budget): clock glyph + single most-significant unit (`5m`/`7h`/`13d`), live 1s re-render, verbose form in the tooltip only.
- **Why:** `movedAt` is written only on real status changes so it faithfully means "time in current status"; compact-only per the user's requirement.
- **Status:** Observed. Evidence: `utils/statusAge.ts`, `ActiveTasksSidebar.tsx`.

## 2026-06-15 — Cmd+Shift+1..9 switches project to the OPPOSITE view

- **Rule:** Shift = inverse of the unshifted chord: ⌘1-9 preserves view mode, ⇧⌘1-9 flips it (and deliberately ignores `dev3-task-open-mode` — explicit Shift means "the other view"). Not in the app menu (chord accelerators impossible, decision 044).
- **Why:** One-chord "reach a project AND the other layout"; macOS swallows ⇧⌘3/4/5 for screenshots — documented, not worked around. Decision 068.
- **Status:** Observed. Evidence: `App.tsx`.

## 2026-06-12 — Quiet "behind origin" indicator on the header Git Pull button

- **Rule:** Header convention: *quiet* accent (icon tint + 6px dot) for ambient "something is available"; *loud* accent (filled pill + pulse) reserved for app-update prompts. Status indicators don't consume the header action budget.
- **Why:** Behind-origin is a status, not an action; backend `fetchOrigin` is throttled (3 min) so the 15s poll stays network-free.
- **Status:** Observed. Evidence: `GitPullButton.tsx`, `git.ts` (`getBehindOriginCount`).

## 2026-06-11 — Slash skill autocomplete in the new-task description

- **Rule:** Input assists (inline autocomplete anchored to the field) are zero-chrome and consume no surface budget; a dedicated "insert X" button would be toolbar creep.
- **Why:** Users invoke skills by `/name` and shouldn't memorize slugs; caret-anchored positioning rejected as needless complexity for a 4-row textarea.
- **Status:** Observed. Evidence: `useSkillAutocomplete.ts`, `SkillAutocompleteDropdown.tsx`, `src/bun/skills-catalog.ts`.

## 2026-06-10 — AI-initiated task completion uses a blocking, visually distinct confirm dialog

- **Rule:** Agent-requested completion opens the imperative `confirm()` modal with an `agentInitiated` treatment (accent border + "AI agent request" badge, danger-role confirm, autofocused cancel); the CLI blocks ≤10 min; decline = exit code 6; `cancelled` stays CLI-forbidden.
- **Why:** Completion destroys the worktree + tmux session (destructive → human approval); the AI-identity badge prevents mistaking it for a routine confirm. Zero new chrome. Decision 067.
- **Status:** Observed. Evidence: `confirm.tsx`, `completion-requests.ts`, `cli-socket-server.ts`.

## 2026-06-03 — Narrow-viewport carousel navigation (mobile / remote)

- **Rule:** Narrow viewports get a responsive *view-mode* of existing screens, never a new destination: board = 2D scroll-snap carousel (full-surface swipe OK — column bodies scroll only vertically); terminal = pane carousel with an explicit pager (NO full-pane swipe — TUIs consume touch); gate on width, not `isElectrobun`.
- **Why:** "One screen-width element + swipe to siblings" is presentation of data the screens already own (bible §4); tmux auto-unzooms on pane select so steps must `select-pane` then re-zoom. Idea by Ittai Zeidman.
- **Status:** Observed (board + pane carousels shipped). Evidence: `MobileBoardCarousel.tsx`, `MobilePaneCarousel.tsx`.

## 2026-06-03 — Cmd+1..9 preserves the current view mode (task-view vs board)

- **Rule:** Project switching preserves the user's view mode (task view → task view with an explicit "select a task" empty state; board → board); the empty state is a status surface (centered muted text, no button, no auto-selected task).
- **Why:** Keyboard-heavy users live in the task view; yanking to the board on every switch breaks flow; auto-selecting a task was explicitly rejected — the user asked for an empty pane, not a guess.
- **Status:** Observed. Evidence: `App.tsx`, `ProjectView.tsx`, `state.ts` (`taskView`).

## 2026-06-03 — Prevent-sleep surfaced as a header toggle with a new `--awake` token

- **Rule:** Prevent-sleep is an always-visible header toggle (coffee glyph, semantic `--awake` amber token in both themes), forced on + locked while remote access is active; enabled = sleep inhibited whole-app-lifetime, not just while agents run.
- **Why:** Buried in Settings it was invisible; amber/coffee reads "awake" and is distinct from `--warning`; remote-active detection imported lazily to keep the resource monitor free of electrobun-heavy imports.
- **Status:** Observed. Evidence: `PreventSleepToggle.tsx`, `caffeinate.ts`.

## 2026-06-03 — TaskInfoPanel governed by a 4-bar 2×2 domain model

- **Rule:** The inspector header is a 2×2 grid of quickbars, one per domain — Context / Session-Agent (row 1 = "Drive"), Git / Runtime (row 2 = "Outputs"); panel chrome pinned far-right of row 1 is not a bar; labels truncate to 4 chips + `+k`. Bible §5.1.
- **Why:** Row-1-right had become a 4-domain dumpster; the panel has a hard `MAX_RATIO=0.33` height budget, so domains separate horizontally, not by adding rows.
- **Status:** Observed. Evidence: `TaskInfoPanel.tsx`.

## 2026-06-03 — macOS dock-persistence + React quit-confirmation modal

- **Rule:** Standard macOS lifecycle (`exitOnLastWindowClosed: false`; closing windows ≠ quitting); one React quit-confirmation modal (never `showMessageBox`) driven by a single `before-quit` gate on every deliberate quit; a window-less quit reopens a window that pulls the pending dialog on mount.
- **Why:** The dialog must work identically in the remote client; the pull-on-mount handshake fixed a push-vs-mount race. Decisions 044/060/061.
- **Status:** Observed. Evidence: `quit-manager.ts`, `App.tsx`, `src/bun/index.ts`.

## 2026-06-03 — Hide-sidebar affordance inside the Active Tasks sidebar header

- **Rule:** Controls that govern a panel (chrome) sit at the panel-chrome convention's far-right edge; the sidebar header follows the toolbar budget (≤4 visible), not the §5.1 bar model.
- **Why:** The split could only be collapsed from the top-right; the sidebar needed its own affordance, mirroring the inspector's zoom toggle.
- **Status:** Observed. Evidence: `ActiveTasksSidebar.tsx`.

## 2026-06-03 — Compact (≤1600px) layout for header + task toolbar

- **Rule:** Below 1600px (`useCompact()`), header/toolbar labels collapse to icon-only (tooltips kept) and the rare external links fold into a single `⋯` overflow; no flex-wrap (vertical space is scarce in a terminal-centric app).
- **Why:** 14" MacBooks overflowed the labelled rows; per the action taxonomy, rare external links are the correct overflow candidates. Content-aware (ResizeObserver) v2 noted. Decision 063.
- **Status:** Observed. Evidence: `useCompact.ts`, `GlobalHeader.tsx`.

## 2026-05-29 — Toolbar button creep flagged as the primary anti-pattern

- **Rule:** Explicit complexity budgets; adding a visible button to `TaskInfoPanel`, `TaskCard`, or board toolbars requires an overflow/group decision first.
- **Why:** Changelog history showed steady accretion of always-visible git/tmux/dev-server buttons on the densest surfaces.
- **Status:** Inferred (from changelog + file sizes) — now enforced by the budgets in yaml.

## 2026-05-29 — Native application menu is the canonical action surface

- **Rule:** The Electrobun application menu is the authoritative, complete action taxonomy; DOM toolbars mirror only the frequent subset.
- **Why:** The menu enumerates every action; DOM surfaces are intentionally partial to control density.
- **Status:** Observed. Evidence: `src/shared/application-menu.ts`.

## 2026-05-29 — Button variants documented as role → token, not as a prop

- **Rule:** Button semantics are documented as semantic role mapped to Tailwind token classes (`bg-accent` = primary, `text-danger`/`bg-danger` = destructive, ghost = hover surface) — there is no `<Button variant>` API.
- **Why:** No formal Button component exists; AGENTS.md forbids hardcoded colors and mandates semantic tokens.
- **Status:** Observed.

## 2026-05-29 — Initial manifest derived from repository

- **Rule:** dev-3.0 is a full-screen desktop web app with a screen-based navigation model (the `Route` union in `state.ts`); the manifest's "routes" are screen ids.
- **Why:** There is no URL router; modeling `useReducer` navigation as URL routes would be fiction.
- **Status:** Observed.
