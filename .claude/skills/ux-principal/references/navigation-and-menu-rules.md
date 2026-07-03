# Navigation and menu rules

## Global navigation

Purpose: stable destinations.

Allowed:

- Major product areas.
- Stable workspaces.
- User-recognizable domains.
- Settings only if settings is a major destination in the product shell.

Forbidden:

- Create, export, import, delete, refresh, run, reset.
- Object-specific controls.
- Filters and view modes.
- Temporary states.
- Experimental features without durable IA.

Decision test:

```text
Would a user say "I need to go to X" rather than "I need to do X"?
```

If yes, it may be a destination. If no, it is probably an action.

## Sidebar groups

Group by user goal or product domain, not database table unless the database table is the user's mental model.

Good group labels:

- Work
- Observe
- Manage
- Configure
- Admin

Bad group labels unless user-facing:

- CRUD
- Tables
- Misc
- Utils
- Other

## Tabs

Use tabs for peer sections within the same object or route.

Avoid tabs when:

- Items are not peers.
- The target is a global destination.
- The set is long or dynamic.
- The content is a one-off action.

## Overflow menus

Use overflow for secondary, occasional, advanced, destructive, or expert actions.

Do not use overflow as the only way to find a core feature that novice users need.

## Command palette

Use for expert shortcuts and cross-product jumps.

Do not make command palette the only path to essential features.

## Settings menu

Settings owns durable behavior:

- Preferences.
- Integrations.
- Notifications.
- Permissions.
- Billing configuration.
- Object-level configuration.

Settings does not own daily operational commands.
