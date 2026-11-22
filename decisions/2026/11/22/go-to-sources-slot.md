# Go-to palette rows on an internal `goToSources` slot

## Context
Batch item 2 of the off-Cordis inventory. `GoToPalette` (⇧⌘K/J/L) hard-wired three row kinds (projects, spaces,
tasks) in one `GoItem` union, with matching, ranking and trailing badges spread across the component. The
inventory also named settings entries and destinations, but the palette lists neither today; this PR moves what
exists and adds nothing. The slot is internal: no manifest kind, no public service, no API version bump.

## Decision
- **Pin first.** `GoToPaletteRanking.test.tsx` was committed on main before the move: a fixed fixture and query set
  (empty, fuzzy, `label:`, `status:`, `#seq`, no match) in all three modes, with the task on screen sunk. Its
  snapshots are unchanged after the move; only its setup installs the built-in sources.
- **Source shape** (`src/mainview/go-to-sources/registry.ts`). A source declares its `modes` and gives
  `rows(data)`, `matches(row, query, data)`, optional `rankText` / `textClassName` / `right`, and `select`.
  Row ids double as visit keys (`p:` / `t:`), which is how "All" interleaves by the visit timeline.
- **Host keeps the policy.** `GoToPalette` merges the sources shown in a mode in slot order (projects 10, tasks 20,
  spaces 30 reproduce today's order), runs `orderByNavRecency` for "All", sinks the current task, parses the query
  once, filters, and fuzzy-ranks on free text. The lazy task-pool load, the facet resolver, the mode strip,
  keyboard and empty/loading states stay host-owned.
- **Snapshots, not lookups.** Rows are rebuilt only when the slot or the data (`GoToData`) changes; a keystroke only
  filters the prebuilt rows. Open callbacks go through a ref so a parent re-render does not rebuild rows.
- **Isolation.** Every source callback is guarded: a throw falls back (no rows, no match, `text` as the haystack,
  no class, no badge, no-op select) and is logged once per registered source and callback. A trailing node that
  crashes on render is caught by its own boundary and reported the same way.

## Risks
- The task pool is a host service, loaded only in task-bearing modes. A future source that needs tasks in Projects
  mode would need the load condition to come from sources.
- `GoToData` exposes the facet resolver indirectly (`taskContext`). Opening the slot needs a narrower, public shape.
- There is no extension budget: a chatty source could flood "All". The opening track must cap rows per source.

## Alternatives considered
- **Sources that own their data through hooks.** Rejected: hooks inside registry items break the rules of hooks
  when sources come and go, and the lazy task load would run per source.
- **One `filterRank` per source.** Rejected: ranking across sources must be comparable, so the host keeps it.
