# Has Questions leads the sidebar's NEEDS YOU tier

## Context

NEEDS YOU merged `review-by-user`, `user-questions` and signalled `review-by-colleague` under one
comparator (priority band → coordinator lift → activity clock → `seq`). A task asking a question
is blocked on the user, yet it landed wherever its band and clock put it — routinely under a
stack of reviews that nobody is waiting on, in project, space and global scope alike.

## Decision

`groupTasksIntoTiers` (`src/mainview/components/sidebarTiers.ts`) sorts NEEDS YOU with
`coordinatorsThenQuestions`: live coordinators first (they steer the rest), then every
`user-questions` task, then everything else — whatever the priority or recency. A hibernated or
disconnected coordinator loses the lift, exactly as in `taskSortRank`. Inside each step the old
`compareTasksInBand` order is untouched. Display only — no stored priority or status is written. Custom-column
tiers and WAITING keep the plain comparator, and a question parked in a custom column stays
there (manual placement wins, as before).

## Risks

- A hibernated question still ranks with the questions; it still needs a reply.
- A first draft put questions above coordinators too; the user corrected it the same day.
- The Kanban board is unaffected: its columns are already one status each.

## Alternatives considered

- **A negative sort offset for questions in `taskSortRank`.** Rejected: that rank is shared by
  the board and every list, and an offset only outranks bands by a fixed margin.
- **A separate "ASKING" tier above NEEDS YOU.** Rejected: adds a header and changes the
  grouping the user knows; the ask was ordering, not structure.
