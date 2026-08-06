# 123 — Token-DSL task filters (search string is the single source of truth)

## Context

The Kanban board and the Active Tasks sidebar could only be narrowed by free-text
search plus (board-only) clickable label chips backed by a separate `activeFilters`
state. Users needed structured, combinable filtering ("everything Codex tagged Bug",
"attention tasks with a running dev server") on both surfaces, expressible by typing
OR by clicking, without the two ever disagreeing.

## Decision

Filtering is a **token DSL living inside the one search string** — the single source
of truth. Recognized facets: `priority:` `label:` `agent:` `status:` `is:attention` `has:port`
(registry in `src/mainview/utils/taskSearch.ts`, extensible). Semantics: AND across
facets, OR within a facet, free text ANDed and delegated to the existing
fuzzy/identifier matcher.

The `priority:` facet arrived with the task-priority feature (PR #893, which shipped a
separate `priorityFilters` board state + P0–P4 quick-chips). We **folded it into the
single-source string**: the P0–P4 quick-chips and the funnel's PRIORITY group (rendered
first — priority is the highest-value quick filter) are now views of `priority:` tokens,
and #893's `priorityFilters`/`activeFilters` board state is removed. The board also shows
only the most-popular labels inline (a `+N more` chip opens the funnel's full list) so
the label row never clips. Values with spaces are quoted
(`label:"Bug Fix"`); the funnel auto-quotes.

- `parseTaskQuery` / `matchesTaskQuery` / `toggleFacetToken` / `isFacetTokenActive` /
  `countActiveFacetTokens` are the pure seam. Matching uses case-insensitive
  **substring**; checked/active state uses **exact** (case-insensitive) token presence
  — deliberately two different comparisons (so `label:"Bug Fix"` is checked but
  `label:bug` is not, though both filter). The old `matchesSearchQuery` is fully
  replaced (no shim), its behavior kept as the internal free-text step.
- `src/mainview/utils/taskFacets.ts` builds the per-task `TaskQueryContext` (matching)
  and the present-values-only grouped funnel pool (empty groups dropped). `isAttentionTask`
  is the shared attention predicate (also the sidebar attention scope).
- `FilterFunnel.tsx` (shared): a ghost funnel button + accent count badge opening a
  grouped checkable dropdown (bottom sheet on narrow), plus a `filters.dsl` HelpSpot.
  `LabelFilterBar` label chips are now a VIEW of the string (toggle `label:` tokens);
  the board's `activeFilters` state is gone. Sidebar routes its search through the same
  engine and gains the funnel. Per surface the pool differs by design: board offers all
  statuses, sidebar only the active ones it shows.
- Filters are ephemeral (component state, reset on unmount); renderer-only, no new data.

## Risks

The DSL is a user-facing syntax that is hard to change once relied upon. Mitigated by
keeping the grammar tiny and the registry data-driven. Reconstructing the string on
token removal normalizes surrounding whitespace (acceptable — the string is display +
truth, not preserved byte-for-byte).

## Alternatives considered

- **Separate structured-filter state beside the search box** — two sources of truth
  that drift; rejected (the whole point is they can never disagree).
- **Drop the board label chips** — loses at-a-glance board filtering; instead the chips
  became a view of the string (option A of the grilling reconciliation).
- **`is:pr` / `port:<n>` facets** — dropped/deferred (no per-task PR data on the sidebar;
  specific-port filtering is rare). Registry left extensible.
