# Action taxonomy

Classify before placement.

## Destination

A place the user navigates to. Examples: Projects, Alerts, Settings, Billing.

Placement: global nav, sidebar, section nav, object subnav, route.

Not placement: toolbar or row actions.

## Primary action

The main safe action for the current screen or flow.

Placement: page header primary, empty state primary, flow footer primary.

Rules:

- Max one visible primary per screen.
- Should match the main user job.
- Should not be destructive unless the entire flow is explicitly destructive and has confirmation.

## Page action

Applies to the current page or collection.

Placement: page toolbar or page-header secondary.

Examples: Refresh, Import, Export all, Configure columns, Create saved view.

## Object action

Applies to one object.

Placement: object header, row action, context menu, inspector, object detail page.

Examples: Rename project, archive item, copy ID, open details.

## Bulk action

Applies to selected objects.

Placement: selection toolbar.

Rules:

- Visible only when selection exists.
- Show selection count.
- Destructive bulk actions require confirmation.

## Configuration action

Changes durable behavior or preferences.

Placement: settings, preferences, object settings.

Examples: Notification rules, permissions, integrations, default retention period.

## Destructive action

Deletes, revokes, disables, resets, or causes data loss or dangerous state change.

Placement: overflow, danger zone, destructive confirmation.

Rules:

- Use destructive token role.
- Require confirmation if irreversible or high impact.
- Consider undo for reversible destructive actions.

## Diagnostic action

Helps understand status or failure.

Placement: diagnostics tab, logs route, inspector, details panel.

Examples: View logs, inspect trace, show error details.

## Expert shortcut

Known rare action for power users.

Placement: command palette, keyboard shortcut, overflow.

Rule: Not the only path to a core feature.
