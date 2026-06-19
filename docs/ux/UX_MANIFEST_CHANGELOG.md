# UX Manifest Changelog

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

## 2026-06-10 — Agent completion request (AI-initiated destructive confirm)

Documented the agent-initiated task-completion flow: CLI-triggered blocking approval via the existing `confirm()` Modal with a new `agentInitiated` visual treatment (accent border + robot badge), danger-role approve, autofocused safe cancel, CLI exit code 6 on decline. New feature plan `feature-plans/agent-completion-request.md`, UX decision appended, decision record 067. No new surfaces, nav items, or budget changes.

## 2026-06-11 — Slash skill autocomplete (new-task description)

Added a UX decision for the inline `/`-triggered skill-name autocomplete in the `CreateTaskModal` description textarea, backed by the `listAgentSkills` RPC over the global agent skill directories. Input-assist pattern: no new visible controls, conforms to Modal surface rules and the token policy.
