## 1. Context

The Kanban board could identify an open pull request immediately, but its checks, review state, merge state, title, and unresolved-comment count disappeared until GitHub answered again. Users need the last successful result to remain visible while the next hover-triggered refresh runs.

## 2. Investigation

PR identity is already persisted on `Task` and the backend already emits normalized rich status through `taskPrStatus`. The board receives task metadata before its periodic `getProjectPRs` lookup completes, so an additive task field can hydrate the existing PR popover without changing its surface or promotion logic.

## 3. Decision

Persist the last successful rich PR response as optional `Task.prStatusCache`, together with its PR identity and fetch timestamp. Hydrate Kanban badges from this cache first, keep the cached content rendered during the existing hover refresh, and treat cache-write failures as non-fatal so fresh push messages still update the UI.

## 4. Risks

The task file grows with normalized check metadata, and cached values can be stale until the next refresh. Writes are skipped when the rich payload is unchanged, and the optional field preserves compatibility with older task records and app versions.

## 5. Alternatives considered

Renderer-only memory or browser storage was rejected because it would not survive reloads or provide a shared source for task metadata. A separate cache file was rejected because the task already owns PR identity and an additive field keeps the existing on-disk layout and update path intact.
