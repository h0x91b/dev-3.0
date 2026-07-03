# Sub-agent briefs for initial manifest creation

Use these when the environment supports sub-agents, Task tools, or parallel workers. If not available, perform these audits sequentially.

## Sub-agent 1: Repository and route cartographer

Mission: Map framework, routing, layouts, top-level destinations, nested routes, hidden routes, auth routes, settings routes, and full-screen app shells.

Return:

```md
### Route cartography findings
- Framework and router:
- App shells and layouts:
- Top-level destinations:
- Nested destinations:
- Hidden or modal routes:
- Settings/admin routes:
- Evidence:
- Risks:
```

## Sub-agent 2: Domain object and workflow analyst

Mission: Infer product entities, user jobs, workflows, object ownership, lifecycle states, and primary screens.

Return:

```md
### Domain model findings
- Product objects:
- Object relationships:
- Primary workflows:
- Frequent jobs:
- Rare or admin jobs:
- Evidence:
- Risks:
```

## Sub-agent 3: Surface and action auditor

Mission: Inventory menus, page headers, toolbars, action bars, row actions, selection toolbars, inspectors, drawers, modals, command palette, and context menus.

Return:

```md
### Surface and action findings
- Surfaces found:
- Action types found:
- Bulk action patterns:
- Destructive action patterns:
- Overflow patterns:
- Placement inconsistencies:
- Evidence:
- Risks:
```

## Sub-agent 4: Design system and token auditor

Mission: Discover components, variants, design tokens, semantic colors, spacing, density, typography, icons, and state styles.

Return:

```md
### Design system findings
- Component library:
- Button variants:
- Badge variants:
- Token files:
- Semantic colors:
- Spacing and density:
- Icon rules:
- Inconsistencies:
- Evidence:
- Risks:
```

## Sub-agent 5: Screen pattern and state auditor

Mission: Identify screen archetypes, page templates, list/detail/master-detail flows, dashboards, forms, empty/loading/error states, responsive behavior, and accessibility patterns.

Return:

```md
### Screen and state findings
- Screen archetypes:
- List/table patterns:
- Detail patterns:
- Form patterns:
- Dashboard patterns:
- Empty/loading/error patterns:
- Responsive behavior:
- Accessibility concerns:
- Evidence:
- Risks:
```

## Sub-agent 6: IA risk and cleanup analyst

Mission: Identify feature creep, overloaded menus, duplicate concepts, unclear labels, action/destination confusion, settings drift, dashboard clutter, and inconsistent hierarchy.

Return:

```md
### IA risk findings
- Overloaded surfaces:
- Duplicate labels or concepts:
- Misplaced actions:
- Menu or nav depth problems:
- Inconsistent action hierarchy:
- Recommended cleanup:
- Evidence:
- Risks:
```
