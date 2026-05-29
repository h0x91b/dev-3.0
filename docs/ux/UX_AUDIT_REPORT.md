# UX Audit Report — dev-3.0

Date: 2026-05-29
Source: repository audit + `ux_inventory.py`
Confidence: medium

## Evidence coverage by area

| Area | Coverage | Key evidence |
|---|---|---|
| Navigation model | High | `src/mainview/state.ts` (Route union, history), `GlobalHeader.tsx` |
| Object model | High | `src/shared/types.ts` (Project, Task, Label, CustomColumn, TaskNote, statuses) |
| Action taxonomy | High | `src/bun/application-menu.ts` (full menu), inspector + board components |
| Surfaces | High | `KanbanBoard/Column`, `TaskCard`, `TaskInfoPanel`, `*Modal`, `*Popover`, settings |
| Design tokens | Medium-High | `src/mainview/index.css`, `tailwind.config.js`, AGENTS.md, inline usage |
| Complexity budgets | Low-Medium (inferred) | changelog history, component file sizes |
| States (empty/loading/error) | Medium | `ErrorToast`, `GitPullErrorModal`, decisions 020/047 |

## Findings

### Strengths

- Clear, small navigation surface (screen router + breadcrumbs + native menu). Destinations are stable and few.
- Strong, enforced token discipline in AGENTS.md (no hardcoded colors, semantic Tailwind classes, two themes).
- Action taxonomy is well-defined and centralized in the native application menu.
- Mandatory i18n (en/ru/es) keeps all user-facing strings localized.

### Risks

1. **Toolbar/inspector density (highest).** `TaskInfoPanel.tsx` (34K) and `TaskCard.tsx` (33K) concentrate many always-visible actions. Changelog shows continual button additions. Without enforced budgets this trends toward a control-panel anti-pattern.
2. **No multi-select / bulk model.** All actions are per-task; any future "act on many tasks" feature has no defined home (selection toolbar is `Proposed` only).
3. **No `--info` semantic token.** Accent (blue) is overloaded for both primary CTA and informational emphasis, which can blur primary-action hierarchy.
4. **Large settings surface.** `ProjectSettings.tsx` (59.9K) risks becoming hard to scan; grouping rules exist but no size budget.
5. **Debug screens in the Route union.** `gauge-demo` / `viewport-lab` are real screens; they must stay Debug-menu-only and never leak into user navigation.

## Recommended next actions

1. Enforce the Task-card (≤2 inline) and toolbar (≤4 visible) budgets in review; route extras to context menu/overflow.
2. Decide on the multi-select question; if yes, add a selection-toolbar spec to the manifest before building.
3. Decide on an `--info` token vs. intentional accent reuse.
4. Run the `ux-principal` skill before every new UI feature and update this manifest when surfaces change.

## Confidence & missing evidence

Medium overall. Strongest on navigation/objects/actions/surfaces. Weakest on complexity budgets (inferred from history, not an explicit spec) and on empty/loading/permission states, which are scattered and not centrally documented.
