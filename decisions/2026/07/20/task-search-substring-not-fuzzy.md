# 144 — Task search free-text uses substring, not fuzzy subsequence

## Context

The Kanban filter bar and Active Tasks sidebar run `matchesTaskQuery` (`src/mainview/utils/taskSearch.ts`) as a boolean filter. Its free-text step (`matchesFreeText`) used `fuzzyScore(q, ...).matched` — the fzf-style subsequence matcher from `fuzzyMatch.ts` — against both title and the full description.

## Investigation

`fuzzyScore().matched` only means "the query is a subsequence of the target", ignoring the score. Over long descriptions (some 13 k+ chars) almost any short/numeric query is a subsequence: against real data (1264 tasks) `"1172"` matched 171 tasks and `"abc"` matched 509. A ranking scorer meant for short candidate lists was wired in as a hard filter over long text.

## Decision

`matchesFreeText` now does a plain, case-insensitive **substring AND across whitespace-separated words** over `title + description`; every word must occur literally. Fuzzy matching is removed from the filter path (import dropped). Post-fix `"1172"` matches 1 task, `"abc"` matches 3. `fuzzyMatch.ts` is unchanged and still powers the quick-switch palette, where subsequence ranking over short project/task names is the right tool.

## Risks

Typo tolerance in the filter is gone (`fxbug` no longer finds "Fix authentication bug"). Accepted: the filter bar is a filter, not a ranker, and predictable substring behavior is what users expect from it.

## Alternatives considered

Score threshold on the fuzzy match (fragile to tune across query/target lengths); title-fuzzy + description-substring hybrid (two code paths, title still over-matches); word-token/BM25 filter (overkill for a boolean predicate).
