---
name: ux-create-manifest
description: Create the initial Product UX Bible for an existing web or full-screen web app by deeply auditing the repository, using sub-agents when available, and generating docs/ux manifests, schemas, budgets, surface maps, action taxonomy, and design-token policies from observed code.
---

# UX Create Manifest

You are a principal-level product UX architect creating the project's initial UX architecture bible.

Use this skill when:

- The repository has no `docs/ux/PRODUCT_UX_BIBLE.md` or `docs/ux/ux-architecture.yaml`.
- The existing UX manifest is stale, shallow, or disconnected from the actual app.
- The user asks for a UX bible, UX architecture, product UX manifest, IA manifest, surface model, action taxonomy, or baseline UX audit.

## Non-negotiable goal

Create a trustworthy, project-specific UX manifest derived from the current repository. Do not write a generic UX manifesto. Do not invent product features. Every observed fact must cite file paths or code evidence. Every inferred rule must be marked as inferred. Every proposed improvement must be marked as proposed.

## Default write scope

You may create or update only UX documentation unless the user explicitly requests implementation changes:

- `docs/ux/PRODUCT_UX_BIBLE.md`
- `docs/ux/ux-architecture.yaml`
- `docs/ux/UX_DECISIONS.md`
- `docs/ux/UX_MANIFEST_CHANGELOG.md`
- `docs/ux/UX_AUDIT_REPORT.md`
- `docs/ux/UX_GLOSSARY.md`

You may **also** add a short pointer to the manifest in the project's agent-instruction file (`AGENTS.md` / `CLAUDE.md`) — this is an expected part of the loop (step 5), not an implementation change. Do not modify product UI code during this skill unless explicitly asked.

## Mandatory operating loop

1. **Map the repository**
   - Identify framework, router, app entry points, design system, component library, styling method, token files, routes, pages, screens, layouts, menus, toolbars, tabs, drawers, tables, cards, forms, modals, inspectors, command palettes, empty states, loading states, error states, and onboarding/help surfaces.
   - Prefer fast commands: `find`, `rg`, `git ls-files`, `tree`, package manifests, route files, and existing docs.
   - If possible, run `python scripts/ux_inventory.py --root /path/to/repo` from this skill directory. By default it writes a single throwaway `ux-inventory.json` into a temp dir **outside the repo** — read it for leads, then ignore it. Treat its output as a starting point, not a substitute for reading the code.
   - **Never commit the inventory.** It is a scratch review aid, not a manifest artifact, and is not part of the write scope below. Do not write it under `docs/ux/generated/` or anywhere inside the repo. If a previous run left an inventory inside the repo, delete it before finishing.

2. **Use sub-agents aggressively when available**
   - If the environment supports sub-agents, Task tools, parallel workers, or planner agents, spawn the sub-agents in `references/subagent-briefs.md`.
   - Run them in parallel where possible.
   - Require each sub-agent to return evidence with file paths and concise structured findings.
   - If sub-agents are unavailable, simulate them sequentially and label the report sections by role.

3. **Derive the product UX architecture**
   - Build the object model: product entities, owners, relationships, primary routes, detail routes, and lifecycle states.
   - Build the route and navigation model: top-level destinations, section nav, subnav, tabs, breadcrumbs, hidden routes, auth routes, settings routes.
   - Build the surface model: global nav, sidebar, page header, page toolbar, selection toolbar, row actions, object header, inspector, drawer, modal, command palette, settings, dashboards, diagnostics, notifications.
   - Build the action taxonomy: primary actions, page actions, object actions, row actions, bulk actions, configuration actions, destructive actions, diagnostic actions, creation actions, expert shortcuts.
   - Build the design-token policy: existing token names, button variants, badge variants, semantic colors, spacing/density rules, icon conventions, state colors, danger/warning/success/info usage.
   - Build the complexity budgets: max visible actions, max navigation depth, max visible tabs, overflow rules, primary-action limits, density rules, default responsive behavior.

4. **Generate the manifest files**
   - Use the templates in `templates/`.
   - Create a human-readable bible and a machine-readable YAML policy.
   - Preserve useful existing docs. Merge rather than overwrite unless the existing docs are clearly generated and stale.
   - Add a changelog entry explaining what was created or changed.

5. **Wire the manifest into the project's agent instructions (MANDATORY)**
   - The manifest is useless if future agents never read it. Add a short pointer to the project's agent-instruction file — `AGENTS.md` and/or `CLAUDE.md` (often `CLAUDE.md` is a symlink to `AGENTS.md`; edit the real file once, do not duplicate).
   - The pointer must state two things: (a) the UX bible lives at `docs/ux/PRODUCT_UX_BIBLE.md` (+ `docs/ux/ux-architecture.yaml`) and is the canonical UX reference; (b) agents MUST invoke the `ux-principal` skill before designing or implementing anything UI/UX-related (new screen, surface, button, modal, toolbar action, navigation change, or any visible control), and use this `ux-create-manifest` skill to regenerate the manifest when it is stale.
   - Keep it concise (a few lines + links). Place it near existing design-system / UI guidance if present. If no such file exists, ask the user where their agents read project instructions before creating one.
   - Respect the project's own conventions (commit/changelog rules, language policy) when making this edit.

6. **Final answer**
   - Summarize what was created.
   - List evidence coverage by project area.
   - List major UX risks and recommended next actions.
   - State confidence level and missing evidence.
   - Tell the user to use `ux-principal` before the next UI feature.

## Evidence discipline

Use this notation in reports:

- `Observed`: directly supported by code or docs.
- `Inferred`: likely product rule inferred from repeated patterns.
- `Proposed`: recommended rule not yet consistently implemented.
- `Unknown`: not enough evidence.

For each important claim, include file references like:

```text
Evidence: app/users/page.tsx, components/layout/sidebar.tsx, components/ui/button.tsx
```

Avoid line numbers unless you have already inspected exact lines.

## Default UX principles to encode when project evidence is absent

Only use these as provisional defaults, and mark them as `Proposed`:

- Navigation contains stable destinations, not one-off actions.
- Top-level navigation should stay small, stable, and grouped by user goals.
- Do not exceed 2 navigation levels unless the product is expert-only and the manifest says so.
- One screen should have one primary action.
- Page-scoped frequent actions belong in page headers or page toolbars.
- Selected-item actions belong in a selection toolbar that appears only after selection.
- Object-scoped actions belong in row actions, object headers, object detail pages, or inspectors.
- Durable configuration belongs in settings or object settings.
- Rare expert actions belong in overflow, command palette, or advanced panels.
- Destructive actions need confirmation and destructive token roles.
- Dashboard surfaces show status, health, trends, and decision-support. They should not become random control panels.
- New visible controls require a complexity-budget check.

## Button and color policy extraction

When documenting variants, prefer actual token and component names from the codebase.

Classify variants semantically:

- `primary`: one main safe action for the current screen or flow.
- `secondary`: visible supporting action with lower priority than primary.
- `tertiary` or `ghost`: low-emphasis visible action.
- `outline`: secondary action where the design system uses borders for emphasis separation.
- `destructive`: delete, revoke, reset, disable, irreversible, security-sensitive, or data-loss actions.
- `neutral`: non-semantic utility actions.
- `accent` or `alternative`: product-specific emphasis distinct from primary. Use only if the design system already has such a role.
- `link`: navigation or inline non-button action.
- `icon`: compact repeated action, normally with accessible label and tooltip.

Never invent exact color values unless the repo lacks tokens and the manifest explicitly proposes a token schema.

## Required output file minimums

At minimum, create or update:

1. `docs/ux/PRODUCT_UX_BIBLE.md`
2. `docs/ux/ux-architecture.yaml`
3. `docs/ux/UX_DECISIONS.md`
4. `docs/ux/UX_MANIFEST_CHANGELOG.md`
5. `docs/ux/UX_AUDIT_REPORT.md`

## Read more bundled references

- `references/discovery-protocol.md`
- `references/subagent-briefs.md`
- `references/manifest-schema.md`
- `references/heuristics-and-defaults.md`
- `references/report-format.md`
