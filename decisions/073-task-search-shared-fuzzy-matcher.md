# 073 — Unify task search on the shared fuzzy matcher

## Context

`src/mainview/utils/taskSearch.ts` (`matchesSearchQuery`) filtered tasks with a
naive `String.includes()` substring check on title and description. The project
quick-switch palette (`ProjectQuickSwitchModal.tsx`) already used an fzf-style
fuzzy matcher (`src/mainview/utils/fuzzyMatch.ts`). Two different matchers for
two short-entity searches was inconsistent UX.

## Decision

Title and description now go through `fuzzyScore().matched` (subsequence match),
so task search matches the quick-switch behavior. Identifier fields — `seq`,
UUID, and PR number — intentionally keep strict `startsWith` prefix matching:
fuzzy subsequence on short numeric/hex IDs is meaningless (e.g. "135" would
match seq "12345"). The function still returns a boolean; both callers
(`KanbanBoard`, `ActiveTasksSidebar`) only filter, so no ranking was added.

BM25 (`src/shared/conversation-search-core.ts`) remains reserved for long
transcripts only — fuzzy is for short UI entities, BM25 for long text.

## Risks

Fuzzy subsequence is looser than substring, so a query can match a long
`description` via scattered chars (more false positives than before). Acceptable
for an interactive filter where the user refines the query live; titles are
short and dominate relevance in practice.

## Alternatives considered

- Keep `includes()` — rejected: leaves two divergent matchers.
- Fuzzy-match identifiers too — rejected: meaningless on short IDs, breaks
  intuitive #seq / UUID-prefix lookups.
- Add scoring/ranking to the callers — rejected: out of scope, both callers
  only filter (boolean), no sorted result list today.
