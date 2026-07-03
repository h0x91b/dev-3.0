# Product UX Bible

Status: Draft
Source: Derived from repository audit
Last updated: YYYY-MM-DD
Owner: Product UX Architecture

## 1. Purpose

This document defines how this product organizes navigation, screens, actions, design-token roles, and feature placement. It is the canonical UX architecture reference for agents and humans working on UI features.

## 2. Product overview

### Product type

- App type:
- Primary users:
- Primary jobs:
- Primary operating mode:

### Evidence

- Observed files:
- Existing docs:
- Known gaps:

## 3. Object model

| Object | Route | Detail route | Owner | Common actions | Evidence |
|---|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD | TBD |

## 4. Navigation model

### Global navigation

Purpose: Stable top-level destinations.

Allowed:

- Major product areas.
- Stable workspaces.
- User-recognizable domains.

Forbidden:

- One-off actions.
- Temporary states.
- Object-specific controls.
- Filters.

Budget:

- Max top-level items:
- Max depth:

### Section navigation and tabs

Purpose:

Rules:

Evidence:

### Breadcrumbs

Purpose: Show location, not actions.

Rules:

Evidence:

## 5. Surface model

| Surface | Purpose | Allowed | Forbidden | Budget | Evidence |
|---|---|---|---|---|---|
| Global nav | Destinations | destination | action, filter | TBD | TBD |
| Page header | Title, status, primary action | primary_action, status | dense filters | TBD | TBD |
| Page toolbar | Page-scoped utilities | search, filter, page_action | settings | TBD | TBD |
| Selection toolbar | Bulk actions | bulk_action | non-selection actions | TBD | TBD |
| Row actions | Item actions | object_action | global action | TBD | TBD |
| Inspector | Contextual object detail | metadata, secondary edit | global nav | TBD | TBD |
| Settings | Durable configuration | configuration | daily operation | TBD | TBD |
| Command palette | Expert shortcuts | rare_action, jump | only path to core feature | TBD | TBD |

## 6. Action taxonomy

| Action type | Definition | Placement | Token role | Notes |
|---|---|---|---|---|
| primary_action | Main safe action for screen | Page header or flow footer | primary | Max one visible |
| page_action | Applies to current page or collection | Page toolbar | secondary or ghost | Frequency decides visibility |
| object_action | Applies to one object | Object header, row actions, inspector | secondary, ghost, destructive | Use overflow for secondary actions |
| bulk_action | Applies to selected objects | Selection toolbar | secondary, destructive | Visible only after selection |
| configuration | Durable behavior change | Settings | secondary | Not dashboard clutter |
| destructive | Data loss or risky state change | Overflow, danger zone, confirm | destructive | Never random primary |
| expert_shortcut | Rare known action | Command palette, overflow | neutral | Not only discoverability path |

## 7. Design token and variant policy

### Button variants

| Semantic role | Component variant | Use for | Do not use for | Evidence |
|---|---|---|---|---|
| primary | TBD | One main safe action | Multiple competing CTAs | TBD |
| secondary | TBD | Supporting visible action | Main irreversible action | TBD |
| tertiary/ghost | TBD | Low-emphasis action | Critical path action | TBD |
| destructive | TBD | Delete, revoke, reset, disable | Safe routine action | TBD |
| link | TBD | Navigation or inline action | Form submission primary | TBD |

### Badges and status colors

| Semantic role | Component variant/token | Use for | Evidence |
|---|---|---|---|
| success | TBD | Healthy, complete, active | TBD |
| warning | TBD | Needs attention, degraded | TBD |
| danger | TBD | Failed, blocked, destructive risk | TBD |
| info | TBD | Informational state | TBD |
| neutral | TBD | Metadata, inactive, unknown | TBD |

## 8. Screen patterns

### List or table screen

- Header:
- Toolbar:
- Search/filter:
- Row actions:
- Bulk actions:
- Empty state:
- Loading state:
- Error state:

### Detail screen

- Header:
- Subnav/tabs:
- Inspector:
- Actions:
- Related objects:

### Dashboard screen

- Purpose:
- Allowed widgets:
- Forbidden widgets:
- Action rules:

### Settings screen

- Purpose:
- Grouping rules:
- Save/apply behavior:
- Danger zone:

## 9. Complexity budgets

| Surface | Budget | Overflow rule | Notes |
|---|---:|---|---|
| Global nav | TBD | Group or demote | Destinations only |
| Page header primary actions | 1 | Demote to secondary or overflow | One main CTA |
| Page header secondary actions | 2 | Overflow | Avoid CTA soup |
| Page toolbar visible actions | 3 | Overflow after 3 | Search/filter are not counted as actions unless command-like |
| Row visible actions | 1 | Overflow after 1 | Repeated rows must stay calm |
| Tabs | 6 | More menu or subpage | Use labels with scent |

## 10. Placement rules

| Feature class | Place in | Reject | Rationale |
|---|---|---|---|
| destination | Global nav, section nav, object subnav | toolbar, modal | Destinations are places |
| primary_action | Page header primary | global nav, settings | Main task of current screen |
| bulk_action | Selection toolbar | page header, row action | Requires selected items |
| configuration | Settings, object settings | dashboard, toolbar | Durable behavior |
| destructive | Overflow, danger zone, confirmation | primary, global nav | Requires friction |

## 11. Known anti-patterns in this project

- TBD

## 12. Open questions

- TBD
