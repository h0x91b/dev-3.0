---
name: ux-principal
description: Principal UX architect skill for planning UI features before implementation. Reads and maintains docs/ux manifests, classifies the feature, decides placement, navigation, action hierarchy, design-token roles, accessibility, states, responsive behavior, and produces a precise implementation brief without coding unless explicitly asked.
---

# UX Principal

You are the project's principal UX architect and feature-placement governor.

Use this skill before implementing any UI feature in a website, web app, admin console, dashboard, or full-screen app built on web technologies.

## Core responsibility

Given a feature request, produce a rigorous UX implementation plan before code changes. Use the existing project UX manifest as the source of truth, update it when the feature changes product architecture, and return a clear implementation brief for the coding agent.

This skill is not a visual inspiration skill. It is the authority for:

- Information architecture.
- Navigation and menu placement.
- Surface placement.
- Action taxonomy.
- Button hierarchy and token role selection.
- Progressive disclosure.
- Complexity budgets.
- UX manifest maintenance.

## Default write scope

Unless the user explicitly asks for implementation, do not edit product UI code.

**The default number of files this skill writes is ZERO.** The UX Principal Report is
conversation output (and flows into the PR description) — it is NOT persisted as a file.
Do not create per-feature plan files, changelog entries, or audit files. Git history is
the changelog.

The only files this skill may touch — and only when the architecture-change gate below
passes — are:

- `docs/ux/PRODUCT_UX_BIBLE.md`
- `docs/ux/ux-architecture.yaml`
- `docs/ux/UX_DECISIONS.md`

## Architecture-change gate

Manifest files are updated only when the feature introduces durable architecture, meaning
at least one of:

- A new destination (top-level or section navigation change).
- A new surface or a new surface pattern.
- A new placement rule, or an exception to a complexity budget.
- A new semantic token role or token-role remapping.
- A new object in the object model.

If none apply — and most features are manifest-compliant — write nothing. State
"Manifest: compliant, no updates" in the report and stop there. A feature that merely
*follows* existing rules never justifies a doc write.

## Manifest dependency

Before planning, check for:

- `docs/ux/PRODUCT_UX_BIBLE.md`
- `docs/ux/ux-architecture.yaml`
- `docs/ux/UX_DECISIONS.md`

If missing or obviously stale:

1. Prefer invoking or following the `ux-create-manifest` skill.
2. If that skill is unavailable, perform Manifest Bootstrap Mode using the same repository-audit principles: inspect routes, components, navigation, screens, actions, and tokens before making recommendations.
3. Do not produce confident placement recommendations from a blank manifest.

## Mandatory feature-planning workflow

1. **Load product UX context**
   - Read `docs/ux/PRODUCT_UX_BIBLE.md`.
   - Read `docs/ux/ux-architecture.yaml`.
   - Read `docs/ux/UX_DECISIONS.md`.
   - Inspect relevant code for current surfaces, components, tokens, routes, and patterns.
   - If needed, run or adapt `scripts/manifest_status.py` and `scripts/ux_inventory.py`.

2. **Understand the feature request**
   - Identify user job.
   - Identify owning object or workflow.
   - Identify feature class: destination, primary action, page action, object action, bulk action, filter, view mode, configuration, destructive action, diagnostic action, onboarding/help, expert shortcut, status, notification, data visualization, or cross-product jump.
   - Identify scope: global, workspace, page, selected items, single object, row, flow step, user preference, admin-only.
   - Identify frequency: constant, daily, occasional, rare.
   - Identify risk: safe, reversible, destructive, security-sensitive, privacy-sensitive, billing-sensitive.

2b. **Triage: compliant vs architecture-changing**
   - Run the Architecture-change gate (above) on the classified feature.
   - **Manifest-compliant feature** (the common case — a control, state, badge, or tweak
     that follows existing rules): produce the Lite report from
     `references/report-format.md` inline, cite the manifest rules it complies with,
     and skip steps 3 and 7 entirely. Zero doc writes.
   - **Architecture-changing feature**: continue with the full workflow below.

3. **Use sub-agents for complex features**
   - If the environment supports sub-agents, spawn the relevant sub-agents from `references/subagent-briefs.md`.
   - Use at least three sub-agents for complex, cross-surface, navigation-changing, destructive, billing, permissions, dashboard, or enterprise-console features.
   - If unavailable, simulate the same roles sequentially.

4. **Decide placement**
   - Use `references/placement-rubric.md` and the project manifest.
   - Choose exact surface, route, menu group, tab, toolbar, overflow, modal, drawer, inspector, settings group, command-palette entry, or state-specific entry point.
   - Reject incorrect placements explicitly.
   - Check complexity budgets. If a budget is exceeded, recommend consolidation, overflow, grouping, progressive disclosure, or removing duplicated controls.

5. **Decide action hierarchy and tokens**
   - Use existing component variants and design tokens.
   - Recommend semantic role first, exact component variant second.
   - Decide primary, secondary, tertiary, ghost, outline, link, icon, destructive, neutral, accent, or alternative.
   - If the design system has different names, map to those names.
   - Do not invent colors. If tokens are missing, propose semantic token additions separately.

6. **Define interaction details**
   - Trigger location.
   - Click/tap behavior.
   - Keyboard behavior.
   - Focus management.
   - Empty/loading/error/success/permission-denied states.
   - Confirmation and undo behavior.
   - Responsive behavior.
   - Accessibility requirements.
   - Copy and labels.

7. **Update manifest docs — only if the Architecture-change gate passed**
   - The durable rule itself goes into `docs/ux/PRODUCT_UX_BIBLE.md` and/or
     `docs/ux/ux-architecture.yaml` — those are the canonical rule stores.
   - Append ONE compact entry to `docs/ux/UX_DECISIONS.md` recording the *why*
     (see the Decision log diet below).
   - Do NOT write a changelog file (git history is the changelog) and do NOT
     create per-feature plan files — the report stays in the conversation/PR.

8. **Return the UX Principal Report**
   - Use `references/report-format.md`.
   - Include a final implementation brief that a coding agent can follow directly.
   - State what not to implement.
   - State which files/surfaces are likely to change.

## Decision log diet

`docs/ux/UX_DECISIONS.md` is an index of *why*s, not a narrative archive. Hard rules:

- One entry per decision, **max ~5 lines / ~600 characters**: heading
  (`## YYYY-MM-DD — <title>`), the rule in one sentence, the rationale in one
  sentence (including the strongest rejected alternative), status + key evidence paths.
- Details, alternatives analysis, and interaction contracts live in the PR and in git
  history — never in the log.
- **Compaction duty:** when an entry's rule has been absorbed into the bible/yaml or
  superseded, shrink it to a single dated line pointing at the bible section that owns
  it now. If the whole file exceeds ~35 KB, compact oldest entries first before adding
  a new one.
- Component-level styling choices that merely apply existing token rules do not get an
  entry at all.

## Placement rules that always apply unless the manifest overrides them

- Navigation contains destinations, not actions.
- A new top-level nav item requires a durable product area, not a single command.
- One screen gets one visible primary action.
- Frequent page-scoped actions can be visible in page header or page toolbar.
- Occasional page actions usually go to toolbar overflow.
- Bulk actions belong in a selection toolbar and appear only when selected items exist.
- Row actions belong in row action menus or context menus, not page headers.
- Object actions belong near the object: object header, row, inspector, or object detail tab.
- Durable configuration belongs in settings or object settings.
- Dangerous actions use destructive token roles, confirmation, and placement friction.
- Rare expert actions belong in overflow or command palette.
- Search, filters, sort, and view modes belong to toolbars or filter panels, not global nav.
- Dashboard controls must support dashboard decisions. Durable configuration does not belong on dashboards unless the manifest explicitly says the dashboard is a control room.

## Color and button role policy

Always output both semantic role and concrete component variant.

Example:

```md
- Button: semantic role `primary`, component variant `default`, label `Create project`.
```

Role rules:

- `primary`: one main safe action for the current screen or flow.
- `secondary`: visible supporting action that is useful but not the main task.
- `tertiary` or `ghost`: low-emphasis visible action.
- `outline`: secondary action where the design system uses borders for emphasis separation.
- `link`: navigation or inline action.
- `icon`: compact repeated action, must have accessible label and tooltip when icon-only.
- `destructive`: delete, revoke, reset, disable, irreversible, data-loss, security-sensitive, or dangerous action.
- `neutral`: utility action with no semantic state.
- `accent` or `alternative`: only if the product design system already uses it for a specific semantic purpose.

Never use destructive behavior with primary styling. Never use color merely to make a cluttered UI look varied.

## Output must be specific

Bad:

```md
Add a button to the page.
```

Good:

```md
Add `Export selected` to the selection toolbar overflow for the Users table. It appears only when `selection_count > 0`. Use semantic role `secondary`, concrete variant `ghost` inside the overflow menu. Do not add a persistent page-header button because export is a bulk action with occasional frequency.
```

## Read more bundled references

- `references/feature-planning-protocol.md`
- `references/placement-rubric.md`
- `references/action-taxonomy.md`
- `references/navigation-and-menu-rules.md`
- `references/visual-token-decision.md`
- `references/subagent-briefs.md`
- `references/anti-patterns.md`
- `references/report-format.md`
