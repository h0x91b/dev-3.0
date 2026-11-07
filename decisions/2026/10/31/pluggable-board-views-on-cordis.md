# Board views are Cordis 4 plugins over one shared board query

Status: Proposed — design agreed with the maintainer on 2026-10-31 (task seq:2308), not yet implemented.

## Context

A project or space board can only be shown as a Kanban. An external user reported they practically never use it except to reopen finished work; the dev-3.0 board holds ~2400 tasks, 98% completed or cancelled, while a Kanban column shows 15. The maintainer wants interchangeable **board views** (Kanban, Table, lineage Tree, Attention buckets, later anything — even 3D) and, eventually, views written by users as extensions.

## Investigation

Cordis 4 (cordiverse/cordis) was evaluated as the plugin engine. The core is ~2k LOC with no `node:` imports and gives inject-gated services, fiber lifecycles that dispose everything a plugin registered, and HMR. It has **no sandbox**: a plugin runs with the host's full privileges. `main` is `4.0.0-rc.12` while npm `latest` is still 3.18.1; every rc broke APIs; ~95% of commits come from one maintainer; Koishi's own webui is still on Cordis 3 and Vue-only.

## Decision

- A board view owns its layout (grouping, sort, columns); the **board query** (the `taskSearch.ts` token filter) is shared by every view of a board. A view is not a destination: no `Route` field, no history entry.
- Views are Cordis plugins in the renderer. dev3 provides `ctx.board` (board scope ∩ query, all statuses, plus every task action including launch and delete, routed through the existing confirm/approval flows) and `ctx.boardViews.register()`. Built-in views use only that contract; Kanban is rewritten on it and is the undisableable fallback.
- Plugin authors get the **raw Cordis Context**, so Cordis is pinned at exactly `4.0.0-rc.11` (the Wix npm mirror never received rc.12; see `board-host-cordis-provision`) and not upgraded before 4.0 stable except as a deliberate one-line bump.
- Extensions are folders under `~/.dev3.0/extensions/<id>/` (manifest + one prebuilt ESM bundle, host-provided `react`/`cordis`), trusted VS Code-style: consent once at first install, desktop-only install, a kill switch with an env override and a crash-screen escape. Telemetry names only `builtin:<id>` or `third_party`.
- The selected view and its layouts persist per board, in a wide and a narrow slot, in a new `board-views.json` stored as a list of saved views (one, implicit, in v1).

Full spec and task plan: the seq:2308 task notes and its report `board-views-spec.md`.

## Risks

No sandbox: an extension can reach every RPC the renderer can, including process spawning — mitigated only by consent, desktop-only install and the kill switch. Freezing an rc forgoes upstream fixes, and moving to 4.0 stable will break user plugins because they code against Cordis directly. The Kanban rewrite replaces the old board without a flag, so a parity checklist is its only gate. Cordis v4 in a browser is verified by reading source, not by running it.

## Alternatives considered

A dev3 SDK facade over Cordis (isolates authors from rc churn) and a plain in-house registry with a Cordis-shaped API (adopt Cordis after 4.0) were both rejected in favour of the raw Context. A sandboxed iframe per extension was rejected for v1 as too costly for drag, shortcuts and theming across the frame; the manifest/folder format keeps it possible later. A segmented switcher was rejected for a single dropdown; keeping Kanban as-is behind an adapter, or behind a feature flag, was rejected for a contract-only rewrite.
