# 132 — Preserve default Kanban columns in the mobile carousel

## Context

The narrow Kanban carousel filtered every collapsed column. Because Completed and Cancelled are collapsed by default for desktop density, mobile users could not reach either lifecycle column.

## Investigation

`KanbanBoard` used `useColumnCollapse().isCollapsed()` as the carousel filter, while `useColumnCollapse` did not distinguish defaults from user choices. The browser repro showed a 390px pager with seven columns and no Completed or Cancelled pages.

## Decision

Track explicit user-collapsed columns in a separate project-local storage key and expose `isUserCollapsed`. The carousel filters only that set; desktop rendering continues to use the full collapse state, and legacy stored collapse arrays treat built-in defaults as responsive defaults.

## Risks

Users who intentionally collapsed Completed or Cancelled before this distinction existed may see those columns again on mobile once, but their desktop preference remains unchanged. The extra localStorage key is renderer-only and can be safely ignored by older app versions.

## Alternatives considered

Filtering out only Completed and Cancelled would fix the default case but ignore explicit collapse intent. Removing collapse filtering entirely would make all user-hidden columns reappear, so explicit tracking preserves the existing mobile preference rule.
