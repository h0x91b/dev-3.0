# UX Manifest Changelog

## 2026-07-02 — New surface: task image viewer (`dev3 show-image`)

Registered a new **task image viewer** overlay surface — a task-bound lightbox for images an
agent surfaces via a new `dev3 show-image <path...>` CLI command, with a clickable history (newest
activated first). Added `ux-architecture.yaml surfaces.task_image_viewer` +
`responsive.surface_adaptation.task_image_viewer`, a `PRODUCT_UX_BIBLE.md §5` surface row and a §12.3
narrow row. Placement: a Modal-family overlay (not a nav destination, not embedded in the inspector),
opened via an arrival push (auto-open only when already focused on the task), a conditional
image-count badge in the inspector Context bar, and a clickable toast. Storage is additive, in the
worktree (`~/.dev3.0/worktrees/{slug}/shared-images/`, next to DnD uploads, respecting the frozen
layout invariants). Shipped 2026-07-02 — rationale + as-built shape in UX decision 2026-07-02,
decision 097, and `feature-plans/show-image-viewer.md`.

## 2026-07-02 — Velocity Cockpit gains period navigation (temporal nav clarified as allowed)

Clarified the `stats_dashboard` read-only guardrail so it distinguishes **temporal navigation of the
existing time range** (allowed — a prev/next period stepper on the same axis, read-only, ephemeral
offset, hidden for range `all`) from **data filters** (still forbidden — slicing by project/agent/label
adds a new dimension). Updated `PRODUCT_UX_BIBLE.md §1.1` guardrail + §5 surface row and
`ux-architecture.yaml surfaces.stats_dashboard.allowed/forbidden`. Rationale + implementation in
UX decision 2026-07-02 and `feature-plans/stats-period-navigation.md`.

## 2026-06-29 — Terminal expert gesture: Alt/Option-click to move the shell cursor

Recorded an `expert_shortcut` pointer gesture on the live terminal: Alt/Option + left-click walks the
shell/readline cursor to the clicked cell. The shell-vs-TUI decision is made on the backend by asking
tmux what runs in the clicked pane (renderer gating on `!hasMouseTracking()` is impossible — dev3's
tmux runs `mouse on`, keeping outer tracking permanently enabled); horizontal-only on the cursor's
row. No chrome (no button/menu/palette/setting/keymap entry) — discoverability via one "Did you
know?" tip. Inert in Claude Code/vim/htop by design (they now receive real M-clicks instead). See UX
decision 2026-06-29 (revised 2026-07-02) and `feature-plans/alt-click-move-cursor.md`.

## 2026-06-29 — Standing rule: countable progress feeds the Velocity Cockpit

Added a forward-looking UX principle that makes the read-only Productivity Stats / Velocity Cockpit
(`stats`) a first-class consumer of every new feature: a feature producing a countable, repeatable
signal should emit it into the stats pipeline (`rpc-handlers/productivity-stats.ts` +
`utils/productivityStats.ts`) at build time and surface a motivational visualization on the cockpit
when warranted — guarded by a complexity/honesty budget (read-only surface, prefer one strong signal,
forward-only "tracking since", true numbers only; diagnostics stay off the cockpit). Captured as
`PRODUCT_UX_BIBLE.md §1.1` (`Proposed`) + a §10 placement row,
`ux-architecture.yaml placement_rules.instrument-and-surface-countable-metrics` +
`surfaces.stats_dashboard.instrumentation`, and UX decision 2026-06-29.

## 2026-06-24 — Built-in Operations board pinned-first + ⌘0 + "system object" identity

Recorded the decision to elevate the single hardcoded Operations board (`builtin` + `virtual`)
into a pinned, visibly-special system object: a pure `orderProjectsForDisplay()` helper pins it
first on the dashboard and switcher (non-draggable, move-locked); it owns `⌘0` (the "slot 0" of the
`⌘1-9` project-jump family, which now skips it), with zoom-reset relocated to `⇧⌘0`; its localized
name renders bracketed (`[ Operations ]`) with a ⚡ glyph + neutral `SYSTEM` badge + `⌘0` hint, while
user-created virtual boards keep their literal name + plain badge. Also finished stripping git-only
inspector controls from virtual tasks: the empty Git quickbar slot now shows a muted
`ops.gitUnavailable` note, and Dev-Server + Scripts are removed (Open-in + ports stay). No new object,
nav destination, surface, or color token. See UX decision 2026-06-24.

## 2026-06-23 — Virtual "Operations" board (Project.kind) shipped; home terminal removed

Marked `Project.kind` (`git` | `virtual`) as `Observed` in `ux-architecture.yaml`: virtual "Operations"
boards are a new *kind* of the existing Project object (not a new object or nav destination) — repo-less
Kanban whose tasks run an agent + split-right shell in a managed/chosen folder with the whole git domain
(worktree, branch, diff, PR, review columns) hidden. Removed the `home-terminal` global destination; its
single-PTY role is now the built-in Operations board's "Quick shell" operation (⇧⌘`). UX decision moved to
`Implemented`; see feature plan §12 and decision record 079.

## 2026-06-21 — Hint navigation as a cross-surface primitive + keyboard-first expert layer

Added a `Hint navigation overlay` surface row to bible §5 and two placement rules to §10 (hint =
navigation destination only, never a mutation; keyboard expert nav matched on `e.code`). Recorded the
decision to generalize the board-only Vimium hint into a `[data-hint-id]`-driven `HintOverlay` (now
covering dashboard project rows + attention tasks and sidebar tasks), fix layout-independence via
`e.code`, keep bare `F` + add a `⌘G` alias, and introduce a `g`-prefix go-to layer plus `/`-focus-search
and `c`-new-task bare keys. See UX decision 2026-06-21, decision record 076, and
`feature-plans/hint-navigation-generalization.md`. No new nav destination, toolbar button, or token.

## 2026-06-19 — Keyboard-shortcut registry + unified reference overlay

Added a `keyboard_shortcuts_reference` surface to `ux-architecture.yaml` and bible §5.2: a single
source of truth (`src/mainview/keymap.ts`, data — documents, does not dispatch) feeding one
`KeyboardShortcutsModal` with App + Terminal(tmux) tabs, reached via Help → Keyboard Shortcuts
(wiring the currently-dead `help-keyboard-shortcuts` menu action), the ⌘/ chord, and the ⇧⌘P palette;
same data renders the README table + website. Added a UX decision, a surface-table row, resolved the
open question, and created `feature-plans/keyboard-shortcuts-registry.md`. No new nav destination,
toolbar button, or token. Implementation deferred (design-only this pass).

## 2026-06-16 — Back/forward history nav in the global header

Added `history_nav` to the `global_header` surface's allowed actions in `ux-architecture.yaml` (back/forward arrows at the far-left of the breadcrumb row, also bound to ⌘[/⌘] and mouse side buttons, driven by the pre-existing `state.ts` route-history stack). Appended a UX decision. No new surface, nav item, token, or budget change — the empty left edge of the header absorbs it.

## 2026-06-15 — Added `task_switcher` transient overlay surface

Added a new `task_switcher` surface to `ux-architecture.yaml` (transient keyboard-summoned HUD for Option+Tab hold-cycle task switching) and a UX decision recording why this is a presentation of the existing `task_jump` action — not a command palette. Created `feature-plans/option-tab-task-switcher.md`.

## 2026-05-29 — Initial creation

Created the first Product UX Bible for dev-3.0 from a full repository audit.

Added:
- `PRODUCT_UX_BIBLE.md` — human-readable UX architecture (object model, navigation, surfaces, action taxonomy, token policy, budgets, placement rules, anti-patterns).
- `ux-architecture.yaml` — machine-readable policy (objects, surfaces, action_types, design_tokens, complexity_budgets, placement_rules, anti_patterns, open_questions).
- `UX_DECISIONS.md` — initial UX decisions.
- `UX_AUDIT_REPORT.md` — audit findings, evidence coverage, risks.
- `UX_GLOSSARY.md` — shared UX vocabulary for dev-3.0.

Evidence base: `src/mainview/state.ts`, `src/shared/types.ts`, `src/bun/application-menu.ts`, `src/mainview/components/*`, `src/mainview/index.css`, `concept.md`, `AGENTS.md`.

Confidence: medium. Key inferred area: complexity budgets (derived from changelog history + component sizes, not from an explicit spec).

## 2026-06-03 — Prevent-sleep header toggle + `--awake` token

Documented the new global-header prevent-sleep toggle (`global_header.allowed`) and added the `awake` semantic token (amber, both themes) to the bible token table and `ux-architecture.yaml`. Added a UX decision and decision record 059.

## 2026-06-03 — TaskInfoPanel 4-bar 2×2 model

Documented the inspector header as a 2×2 quickbar grid (Context / Session-Agent / Git / Runtime), one domain per bar, chrome pinned separately. Added `surfaces.task_info_panel.bar_model` to `ux-architecture.yaml`, a new bible §5.1, a UX decision, and updated the §9 budget + closed the related open question. Implemented the matching redistribution in `TaskInfoPanel.tsx` (dev-server + scripts moved to row-2-right; label strip truncates with `+k`).

## 2026-06-03 — macOS dock-persistence + unified quit-confirmation modal

Added a UX decision documenting `exitOnLastWindowClosed: false` (closing the last window keeps the app in the dock, reopened on dock-click) and the React quit-confirmation modal driven by the main-process `before-quit` gate, covering Cmd+Q (via `requestQuit`), menu Quit, and dock Quit. A window-less quit reopens a window that pulls the pending flag on mount to show the dialog reliably. Plus the Cmd+Shift+N New Window shortcut. No new visible buttons or tokens — conforms to the Modal surface and destructive-button-role policy. Decision records 044, 060, 061.

## 2026-06-03 — Narrow-viewport carousel navigation (planning)

Documented the responsive narrow-viewport (mobile / remote) carousel pattern: the Kanban board becomes a 2D scroll-snap carousel (one column per screen, drag-move replaced by a "Move to" action sheet) and the task terminal becomes a pane carousel (one zoomed tmux pane + explicit pager). Added bible §12, a `responsive` block + a `full-surface-swipe-over-terminal` anti-pattern to `ux-architecture.yaml`, a UX decision, and a full feature plan at `docs/ux/feature-plans/mobile-carousel-navigation.md`. Planning only — no product code changed. Idea by Ittai Zeidman.

## 2026-06-10 — Agent completion request (AI-initiated destructive confirm)

Documented the agent-initiated task-completion flow: CLI-triggered blocking approval via the existing `confirm()` Modal with a new `agentInitiated` visual treatment (accent border + robot badge), danger-role approve, autofocused safe cancel, CLI exit code 6 on decline. New feature plan `feature-plans/agent-completion-request.md`, UX decision appended, decision record 067. No new surfaces, nav items, or budget changes.

## 2026-06-11 — Slash skill autocomplete (new-task description)

Added a UX decision for the inline `/`-triggered skill-name autocomplete in the `CreateTaskModal` description textarea, backed by the `listAgentSkills` RPC over the global agent skill directories. Input-assist pattern: no new visible controls, conforms to Modal surface rules and the token policy.

## 2026-06-28 — Narrow-viewport (mobile) doctrine

Rewrote bible §12 from a single carousel feature into a product-wide narrow-viewport doctrine and expanded the `ux-architecture.yaml` `responsive` block to match. Reconciled the breakpoint ladder (layout gates on reactive `useNarrowViewport(768)`; `useCompact` 1600 is dense-desktop; `useMobile` 1024 drives only the viewport meta). Added: the one-at-a-time principle, the swipe gesture law (board full-swipe vs terminal/diff pager-only), a per-surface adaptation map for every §5 surface, the touch navigation + action-reachability model (palettes/native-menu are dead on touch → palette gets a touch entry; no feature may be touch-unreachable), a mandated reusable `BottomSheet` primitive, narrow complexity budgets + 44px touch targets, and four new anti-patterns. Grounded in a 3-agent code audit. Added a UX decision and `feature-plans/narrow-viewport-doctrine.md`. Planning only.

## 2026-06-29 — Dev-server button running-state indicator

Added a UX decision + feature plan (`feature-plans/dev-server-button-running-state.md`) for making the single `TaskDevServer` button reflect dev-server state (no-script / stopped / starting / running) instead of always looking green. Sharpened the success-token rule to "running only" and reserved the spinner for the transient start phase (running uses a calm pulsing dot). No new surface, button, or token; no `ux-architecture.yaml` structural change.

## 2026-06-29 — Narrow-viewport tmux windows switcher

Added the narrow-viewport tmux **windows** switcher to the doctrine: a new row in bible §12.3 (Terminal windows → switcher bar above the pane bar, buttons + dropdown, no swipe) and the `feature-plans/narrow-viewport-doctrine.md` §4 work list (now done, decision 093). Added a UX decision. Implemented (not planning-only): `MobileWindowCarousel.tsx` + `tmuxWindowNavigate` RPC, pairing with the existing panes switcher. No new route, nav item, setting, or token.

## 2026-06-29 — Dashboard Activity narrow-viewport pass

Implemented the narrow form for the Dashboard Activity view and corrected its stale `Observed (OK)` verdict in the per-surface map. Per-project actions + reorder now collapse into a kebab → `BottomSheet` action sheet on `useNarrowViewport`; cards go full-width (`p-3`); touch targets ≥44px; reorder (previously touch-unreachable: dead HTML5 drag + `hidden md:flex` steps) is reachable via the sheet. Updated bible §12.3 dashboard row and `ux-architecture.yaml` `surface_adaptation.dashboard` (ok → observed); appended a UX decision. Product code changed (not planning-only).

## 2026-07-02 — Mobile terminal composer (touch input model)

Added a UX decision + feature plan (`feature-plans/mobile-terminal-composer.md`) for the phone-keyboard problem: with the OSK open a phone shows ~4 terminal rows. On touch in browser mode the terminal stops summoning the OSK; a docked chat-style composer above `ExtraKeyBar` owns text entry (Send = mode-2004-aware paste + Enter, Insert, expand state; terminal tail stays visible), with a sticky `⌨` raw toggle for direct typing/select-to-copy/TUI mouse. Gated on `!isElectrobun && isTouchDevice` (input-model switch, not a width layout gate). Grounded in a 3-agent pass (competitive research — Termius Paste mode / Blink Snips / Happy / Omnara all converge on docked composer + raw escape hatch; adversarial critique; code-constraints audit). Added bible §12.3 "Terminal text input (touch)" row + `ux-architecture.yaml` `surface_adaptation.terminal_input`; synced the stale `primitive_bottom_sheet` status (proposed → observed, shipped in `BottomSheet.tsx`). Planning only.
