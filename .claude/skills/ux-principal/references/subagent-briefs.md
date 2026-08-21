# Sub-agent briefs for UX Principal feature planning

Use sub-agents for complex features. If unavailable, perform these roles sequentially.

## IA and placement sub-agent

Mission: Decide feature class, owning object, scope, route/menu/surface placement, and rejected placements.

Return:

```md
### IA placement recommendation
- Feature class:
- Owning object/workflow:
- Scope:
- Recommended surface:
- Menu/nav changes:
- Rejected placements:
- Budget impact:
- Evidence:
```

## Interaction and states sub-agent

Mission: Define trigger, flow, preconditions, loading, empty, error, success, permission, confirmation, undo, keyboard, focus, and responsive behavior.

Return:

```md
### Interaction recommendation
- Trigger:
- Preconditions:
- States:
- Confirmation/undo:
- Keyboard/focus:
- Responsive behavior:
- Evidence:
```

## Component reuse sub-agent

Mission: Decide which existing components and surfaces this feature reuses, and whether a new pattern is justified at all. Roles only — the concrete variant, colour and motion values belong to `better-colors` and `better-ui`.

Return:

```md
### Reuse recommendation
- Components to reuse:
- Existing surface that already does this:
- New pattern justified? (why the manifest must record it)
- Semantic roles needed:
- Missing role to hand to `better-colors`:
- Evidence:
```

## Consistency and anti-pattern sub-agent

Mission: Compare the proposed feature to existing patterns and identify clutter, duplicate concepts, naming drift, menu bloat, and action hierarchy problems.

Return:

```md
### Consistency recommendation
- Existing similar patterns:
- Risks:
- Duplicates:
- Required consolidation:
- Anti-patterns avoided:
- Evidence:
```

There is deliberately no accessibility sub-agent and no colour sub-agent. Those are `better-accessibility` and `better-colors`; run them as their own skills instead of paraphrasing them here.

## Manifest patch sub-agent

Mission: Decide whether docs/ux must change and draft the exact patch.

Return:

```md
### Manifest patch recommendation
- Files to update:
- New rules:
- New objects/routes/surfaces:
- New token mappings:
- UX decision entry (≤5 lines):
```
