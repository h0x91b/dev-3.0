# Placement rubric

Use this to decide where UI belongs.

| Feature class | Default placement | Avoid | Notes |
|---|---|---|---|
| New major product area | Global nav or sidebar group | Toolbar, modal | Requires durable destination and user-recognizable label. |
| New sub-area of object | Object detail tabs, subnav, or section nav | Global nav | Should live under the owning object. |
| Primary create action for a collection | Page header primary or empty-state primary | Row action, settings | One primary visible. |
| Frequent page action | Page toolbar or page-header secondary | Global nav | Use visible action if frequent and page-scoped. |
| Occasional page action | Page toolbar overflow | Persistent primary button | Preserve visual calm. |
| Row-specific action | Row action or context menu | Page header | Applies to one object only. |
| Bulk action | Selection toolbar | Row action, global nav, page header | Appears only after selection. |
| Filter/search/sort/view mode | Page toolbar or filter panel | Global nav, settings | Controls the current view. |
| Durable configuration | Settings or object settings | Dashboard, page toolbar | Changes product behavior beyond current view. |
| Advanced configuration | Advanced section, collapsible panel, settings subpage | Main dashboard | Needs progressive disclosure. |
| Destructive action | Overflow, danger zone, confirmation dialog | Primary button, global nav | Needs friction and destructive role. |
| Status or health info | Dashboard card, status region, inspector | Settings | It informs decisions, not configuration. |
| Logs, traces, debug | Diagnostics tab, logs route, inspector | Primary nav unless core product | Expert/diagnostic surface. |
| Help or onboarding | Empty state, inline hint, docs link | Permanent nav item | Should not bloat navigation. |
| Cross-product jump | Command palette or global search | Local toolbar | Expert shortcut. |
| Notification preference | Settings, preferences | Toast itself | Durable behavior. |
| Wizard step | Flow footer and stepper | Global nav | Flow-scoped. |

## Placement rejection language

Use explicit rejection reasoning:

```md
Rejected placements:
- Global nav: this is an action, not a destination.
- Page header: the action applies only after row selection exists.
- Row action: the action applies to multiple selected objects, not one row.
- Settings: this is not durable configuration.
```

## Surface budget fallback

If the chosen surface is over budget:

1. Merge with an existing action group.
2. Move occasional actions into overflow.
3. Convert multiple related actions into one split-button or menu only if the design system supports it.
4. Add progressive disclosure.
5. Create a subpage only when the feature has enough depth to deserve a destination.
6. Remove duplicate or obsolete controls.
