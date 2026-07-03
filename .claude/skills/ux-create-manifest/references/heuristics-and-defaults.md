# UX architecture heuristics and provisional defaults

Use these only when the current repository does not provide enough evidence. Mark them as `Proposed` in the manifest.

## Information architecture

- Group by user goals and product concepts, not by implementation folders or database tables.
- Navigation should contain destinations, not commands.
- A top-level destination should be stable, frequently needed, and meaningful to users.
- Prefer shallow navigation with strong labels over deep nesting.
- Do not create a new top-level nav item for a single feature unless it represents a major product area.

## Navigation budgets

Default provisional budgets:

```yaml
global_nav:
  max_top_level_items: 7
  max_depth: 2
section_nav:
  max_visible_items: 9
tabs:
  max_visible_tabs: 6
```

These are budgets, not universal laws. Adjust them to the observed product density and user expertise.

## Action placement

- Primary action: page header or flow footer, max one visible primary per screen.
- Page action: page toolbar or secondary page-header action.
- Object action: object header, row action, context menu, or inspector.
- Bulk action: selection toolbar, visible only when selection exists.
- Configuration: settings or object settings.
- Dangerous action: overflow, danger zone, destructive variant, confirmation.
- Rare expert action: command palette, overflow, advanced panel.

## Complexity budgets

Default provisional budgets:

```yaml
page_header:
  max_primary_actions: 1
  max_secondary_actions: 2
page_toolbar:
  max_visible_actions: 3
  overflow_after: 3
row_actions:
  max_visible_actions: 1
  overflow_after: 1
form_footer:
  max_primary_actions: 1
  max_secondary_actions: 1
```

## Color and semantic variant policy

- Primary means hierarchy, not brand decoration.
- Destructive actions must not use primary styling.
- Warning, danger, success, and info colors should describe state or risk, not random variety.
- Alternative or accent variants should be reserved for product-specific semantic emphasis and documented in the manifest.
- If token names are unclear, document semantic role first and exact component variant second.
