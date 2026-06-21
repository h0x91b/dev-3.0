# UX Principal Report: Hint navigation generalization (board → dashboard → cross-surface)

Date: 2026-06-21
Mode: planning only
Manifest status: implemented — see decision record 076 + UX_DECISIONS 2026-06-21
Confidence: high

> **Update (2026-06-21, post-implementation):** scope expanded during the conversation beyond this
> original plan. Final, authoritative scope is in `decisions/076-keyboard-first-hint-generalization.md`.
> Deltas from the plan below: (a) hotkey is bare **`F` + `⌘G` alias** with **`e.code`** layout-independence
> (the plan's "bare `f`" recommendation, plus the Mac chord the user asked for); (b) the **sidebar task list
> is in scope** (listed as "future" below) — it now carries `data-hint-id`; (c) three extra keyboard-first
> bindings shipped alongside: **`g`-prefix go-to** (`g d/p/t/s`), **`/`** focus-search, **`c`** new-task.

## 1. Feature understanding

- User job: "Jump to the thing I'm looking at without reaching for the mouse." Extend the board's `f`-hint jump to the dashboard, then make it a reusable cross-surface primitive.
- Owning object or workflow: navigation primitive (not owned by any one object). Targets are *destinations*: a task, a project, an attention-task.
- Feature class: `expert_shortcut` (keyboard) rendering the existing `task_jump` / `destination` action classes as a transient overlay. Same family as the Option+Tab switcher and the Cmd+K palette.
- Scope: global (any screen that renders hint targets).
- Frequency: occasional-to-daily for keyboard users.
- Risk: safe. Hints only ever *navigate* (no mutation, no destructive action).
- Discoverability need: low/medium — covered by the existing tip + keymap registry; keyboard-only by design (no chrome).
- Assumptions: dashboard project rows and attention-task rows remain real `<button>`s with working `onClick` navigation.

## 2. UX placement decision

Recommended placement:

- Route/screen: any (`dashboard` + `project` in v1; auto-extends to any screen rendering `[data-hint-id]`).
- Surface: the existing **Hint navigation overlay** (generalize `TaskHintOverlay` → `HintOverlay`), keyboard-only, no DOM chrome.
- Menu/nav group: none (keyboard-only, same as palette/switcher — sidesteps toolbar-button-creep).
- Entry point: bare **`f`** (capture-phase global handler), gated by `!isTypingContext()` and a DOM probe for at least one `[data-hint-id]`.
- Visibility rule: a hint is rendered for every on-screen, non-occluded element carrying `data-hint-id`.

Rejected placements:

- Hinting every clickable target on a dashboard row (project-open + duplicate chevron + settings + remove + clone + reorder). Rejected — that is the **Row action explosion** + **Dashboard junk drawer** anti-patterns. Hints must map to *destinations*, not to in-place/destructive actions.
- A second hint for the duplicate chevron/count button. Rejected — it fires the same `openProject` action as the project-name button; one logical destination = one hint.
- A new dashboard-specific overlay component. Rejected — **New component for old pattern**. Generalize the existing overlay instead.
- Putting an `f`-hint button anywhere visible. Rejected — keyboard-only is the whole point; no chrome.

Rationale:

- The manifest treats keyboard as the primary interaction model and already classifies transient keyboard overlays (switcher, palette) as the correct home for "jump to anything". A hint overlay is the same class; generalizing it is manifest-consistent and adds zero visible chrome.
- The single durable policy that keeps this from becoming junk: **a hint targets a navigation/open destination, never a mutation or destructive action.** This mirrors the palette's "destructive + modal flows excluded by policy" rule.

Evidence:

- `src/mainview/components/TaskHintOverlay.tsx`, `src/mainview/utils/hintLabels.ts`, `src/mainview/App.tsx` (~L501), `src/mainview/components/ActivityOverview.tsx`, `docs/ux/PRODUCT_UX_BIBLE.md` §4–§5, §11.

## 3. Navigation and menu changes

- Add: nothing visible. New data-attribute contract `data-hint-id` (see §9).
- Rename: component `TaskHintOverlay` → `HintOverlay`; broaden copy (legend + keymap desc) to be surface-neutral.
- Move: activation gate in `App.tsx` from `screen === "project"` to a data-driven probe.
- Remove: the `screen === "project"` hard gate.
- No change: tokens (`--hint-*`), `hintLabels.ts` generator, occlusion/scan algorithm.

## 4. Action hierarchy and token decisions

| Element | Label | Semantic role | Concrete variant/token | Visibility | Notes |
|---|---|---|---|---|---|
| Hint badge | the hint chars | `icon`/status | `bg-hint border-hint-border text-hint-fg` (existing) | only while overlay active | unchanged; reuse as-is |
| Project hint target | (project name button) | `link`/destination | existing button | per visible project | maps to `openProject` |
| Attention-task hint target | (task row button) | `link`/destination | existing button | per visible attention task | maps to task navigation |

No new tokens. Hints are navigation prompts — they never carry destructive styling because they never trigger destructive actions.

## 5. Layout and component plan

- Screen pattern: List screen (dashboard) + existing overlay portal.
- Components to reuse: `TaskHintOverlay`→`HintOverlay`, `hintLabels.ts`, `--hint-*` tokens, `useGlobalShortcut`.
- New components allowed: none.
- Components not allowed: any dashboard-specific hint overlay.
- Data density: dashboard rows already dense; hints are ephemeral overlays, no permanent density cost.
- Progressive disclosure: hints exist only while `f`-mode is active.

## 6. Interaction contract

- Trigger: bare `f`, not in a typing context, with ≥1 `[data-hint-id]` present.
- Preconditions: targets on screen and non-occluded (existing occlusion test).
- Default state: badges on every project-open target + every visible attention task.
- Loading/empty: zero visible targets → overlay self-exits immediately (existing behavior).
- Error: n/a (navigation only); detached-node click guard already exists.
- Success: typed hint → `element.click()` → navigation runs (open project / open task).
- Confirmation/undo: none needed (safe). Backspace edits prefix, Esc cancels (existing).
- Keyboard and focus: overlay owns the keyboard via capture + `stopImmediatePropagation` (existing); gates the task switcher while active (existing).
- Responsive: hints follow cards via imperative reposition on scroll/resize (existing).

## 7. Accessibility requirements

- Accessible names: underlying project/task buttons keep their text labels (already true) — hints add nothing to the a11y tree.
- Focus management: badges are `pointer-events-none`, never focusable.
- Keyboard support: full keyboard model already implemented.
- ARIA: add `aria-hidden="true"` to the overlay portal container (badges are visual key-prompts, irrelevant to SR users who Tab normally). Minor, optional.
- Contrast/motion: existing `--hint-*` tokens pass in both themes; no motion added.

## 8. Manifest updates

Files to update (land with implementation commit, per repo convention tying decision records to code):

- `docs/ux/PRODUCT_UX_BIBLE.md`: add **Hint navigation overlay** to the §5 Surface model (keyboard-only, expert_shortcut). Record the `data-hint-id` contract and the policy "hints target navigation/open destinations only — never mutations or destructive actions" in §10 placement rules.
- `docs/ux/ux-architecture.yaml`: add the hint surface + `data-hint-id` contract.
- `docs/ux/UX_DECISIONS.md`: append 2026-06-21 decision (generalize hint overlay; navigation-only policy; data-driven activation).
- `docs/ux/UX_MANIFEST_CHANGELOG.md`: entry.

## 9. Implementation brief for coding agent

Implement exactly this:

1. **Generalize the overlay.** Rename `src/mainview/components/TaskHintOverlay.tsx` → `HintOverlay.tsx` (keep export default). Change `scanTargets()` to query `[data-hint-id]` instead of `[data-task-id]`, keyed by the `data-hint-id` value. Because `data-hint-id` lives only on the clickable element (never on the DnD wrapper), the "innermost element" dedup hack can be simplified to "first element per id wins" — but keep the `role="dialog"` skip and the occlusion test unchanged. `commit()` still does `element.click()`.
2. **Data-attribute contract.** Any element that is `data-hint-id="<unique-id>"` AND has a working `onClick` becomes a hint target. The id must be unique within the document.
   - `TaskCard.tsx`: add `data-hint-id={task.id}` to the same innermost element that currently owns the navigation `onClick` (keep `data-task-id` on the DnD wrapper for drag logic — do not remove it).
   - `ActivityOverview.tsx`: add `data-hint-id={`project:${project.id}`}` to the project-name open button (L261-264 cluster). Do NOT add it to the duplicate chevron/count button (L286), the reorder/drag buttons, or `ProjectActionButtons`. Add `data-hint-id={`task:${task.id}`}` to each attention-task button (L305-309 cluster).
3. **Data-driven activation in `App.tsx`** (~L501): replace `if (state.route.screen !== "project") return;` with: keep `if (isTypingContext()) return;` then `if (!document.querySelector("[data-hint-id]")) return;` before `setHintMode(true)`. This removes the per-screen gate and auto-enables hints on the dashboard and anywhere else targets render. Keep the route-change close and the switcher-gating.
4. **Copy generalization (i18n).** Broaden `hint.legend.jump` from "jump to a task" to a surface-neutral "jump" (en/ru/es). Broaden `keymap.shortcut.taskHints` desc from "Jump to a task by hint (board)" to "Jump to a task or project by hint" (en/ru/es). Keep the keymap `id: "task-hints"` stable.
5. **Tip.** Do not add a new tip. Update the existing `task-hint-nav` tip body (`tips.ts` + en/ru/es) to be surface-neutral ("press f to jump to any task or project"). Keep its score.
6. **Tests.** Add a `HintOverlay` test that a dashboard-like DOM (project buttons + attention-task buttons, plus non-hint action buttons) yields exactly one hint per `data-hint-id` and zero for action buttons; committing a hint clicks the right element. Add an `App` test that `f` no-ops (falls through) when no `[data-hint-id]` exists. Update existing `TaskHintOverlay.test.tsx` references to the renamed file/attribute. Run full `bun run test` + `bun run lint` before pushing.
7. **Manifest + changelog + decision record** in the same commit (§8). One changelog file under `change-logs/2026/06/<merge-day>/feature-hint-nav-dashboard.md`. One decision record `decisions/NNN-hint-navigation-generalization.md`.

Do not implement:

- Hints on action/destructive/utility buttons (settings, remove, clone, pull-main, reorder, drag handle).
- A second hint for the duplicate chevron/count button.
- A dashboard-specific overlay component.
- Any visible `f`-hint button/chrome.
- Hints in the `ActiveTasksSidebar` (valid future extension — out of scope here; it will light up for free once it renders `data-hint-id`, but don't wire it in this task).

Likely files to inspect or modify:

- `src/mainview/components/TaskHintOverlay.tsx` → `HintOverlay.tsx`
- `src/mainview/components/ActivityOverview.tsx`
- `src/mainview/components/TaskCard.tsx`
- `src/mainview/App.tsx`
- `src/mainview/i18n/translations/{en,ru,es}/common.ts`, `.../keymap.ts`, `.../tips.ts`
- `src/mainview/tips.ts`, `src/mainview/keymap.ts`
- `src/mainview/components/__tests__/TaskHintOverlay.test.tsx` (+ new App/overlay tests)
- `docs/ux/*`, `change-logs/*`, `decisions/*`

Acceptance criteria:

- On the dashboard, `f` shows one badge per project (→ opens project) and one per visible attention task (→ opens task); no badges on settings/remove/reorder controls.
- On the board, `f` behaves exactly as before.
- `f` falls through (does nothing, not swallowed-then-closed) on a screen with no hint targets, and is ignored in typing contexts.
- Esc/Backspace/occlusion/switcher-gating all unchanged. Full test suite + lint green.
