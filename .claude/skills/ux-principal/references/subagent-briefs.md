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

## Design system and token sub-agent

Mission: Map semantic roles to existing components, variants, tokens, icons, badges, and copy patterns.

Return:

```md
### Token recommendation
- Components to reuse:
- Button variants:
- Badge/status variants:
- Icons:
- Token gaps:
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

## Accessibility and quality sub-agent

Mission: Check WCAG-adjacent concerns, keyboard support, focus management, labels, semantic structure, target size, contrast token risks, reduced motion, and screen-reader behavior.

Return:

```md
### Accessibility recommendation
- Labels and names:
- Keyboard:
- Focus:
- ARIA or semantics:
- Contrast/token risks:
- Responsive concerns:
- Evidence:
```

## Manifest patch sub-agent

Mission: Decide whether docs/ux must change and draft the exact patch.

Return:

```md
### Manifest patch recommendation
- Files to update:
- New rules:
- New objects/routes/surfaces:
- New token mappings:
- UX decision entry:
- Changelog entry:
```
