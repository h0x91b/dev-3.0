# 071 — Searching past task conversations via transcript mapping

## Context

We wanted to let agents (and later the UI) search conversations from completed/cancelled tasks. The obvious corpus — the worktree — is gone: `moveTask` to a terminal status runs `git worktree remove --force` and nulls `task.worktreePath` (`task-lifecycle.ts`). The agent conversation transcripts, however, survive in each agent's own data dir.

## Investigation

Claude Code stores transcripts at `~/.claude/projects/<encoded-cwd>/*.jsonl`, where the cwd is encoded by replacing every `/` and `.` with `-`. Verified against on-disk layout (264 dirs; the algorithm `path.replace(/[/.]/g,"-")` reproduces real directory names exactly). Since `task.worktreePath` is nulled on completion, we reconstruct the cwd deterministically from `<dev3Home>/worktrees/<projectSlug>/<task.id[:8]>/worktree` (the same structure `context.ts` builds) and encode that. A spot check mapped 116 terminal tasks back to existing transcript dirs.

## Decision

- Pure core in `src/shared/conversation-search-core.ts` (encode, tokenize, word-boundary term counts, BM25 idf/score, exclusion set, recency multiplier, ranking).
- I/O engine in `src/bun/conversation-search.ts` reads transcripts via a per-agent locator registry. Each locator maps a worktree cwd → transcript files: **Claude** is path-keyed (`~/.claude/projects/<encoded-cwd>`); **Codex** is date-bucketed (`~/.codex/sessions/.../rollout-*.jsonl`) with the cwd in the SessionMeta header, so we build a cwd→files index once per search by reading each rollout's first line; **Gemini** uses aliased dirs (`~/.gemini/tmp/<alias>`) whose real cwd lives in `.project_root`, indexed the same way. Pure JS file scan, no ripgrep dependency. Adding another agent = one locator.
- Surfaced as `dev3 conversations search` (CLI, runs direct without the app) and a `searchConversations` RPC (for a future UI panel).
- **Ranking = BM25** over one "document" per task (transcript body + the task's curated meta: title, description, overview, notes). Meta is a boosted field (BM25F-lite, `META_FIELD_BOOST`). A bounded recency factor multiplies the BM25 score as a tie-breaker. Tasks are searchable by notes/overview alone, so a task with no surviving transcript still surfaces.

### Why hand-rolled BM25 (no library)

BM25 is ~40 lines of pure math and is the smallest part of the feature; ~90% of the code is our own document assembly, field boost, recency, variant-group exclusion, boilerplate dedup, and snippet extraction. A library (minisearch, okapibm25, orama) supplies only the formula and forces our data through its index API. For a dep-cautious repo whose CLI ships via `bun build --compile`, a zero-dependency function is cleaner and lower-risk. IDF also removes the need for a stopword list — terms common across the corpus (e.g. "command" in logs, injected skill text) decay toward zero automatically.

## Risks

- The Claude path-encoding is reverse-engineered; if Claude Code changes it, mapping silently returns no transcripts. It lives in one function (`claudeEncodePath`) to make a fix localized.
- Injected skill/CLI boilerplate appears in every transcript; BM25 IDF down-weights such corpus-wide terms automatically, and a cross-task line dedup keeps the boilerplate out of displayed snippets. Word-boundary matching avoids false hits (e.g. "tip" matching "tooltip").
- Full-file reads are fine for hundreds of tasks but could be slow on very large corpora; can switch to ripgrep later.

## Alternatives considered

- Raw agent grep via skill instructions only — rejected: only dev3 knows the groupId→task mapping needed for variant isolation, and non-claude paths differ.
- Searching worktree code — impossible without preserving worktrees/copy-back; out of scope (the request was conversations).
- Embeddings/FTS index — deferred; BM25 over the per-project task set is enough for v1 and avoids index lifecycle/storage.
- fuzzysort — wrong tool: it does fuzzy short-string matching (pickers/typos), not relevance ranking of long documents.

## Variant isolation

`computeExclusionSet` always drops the current task and every sibling sharing its non-null `groupId`, regardless of status. This is enforced in the engine (not just the skill), because parallel variants must explore independently and only dev3 can resolve the group membership. `--all-statuses` widens the status filter but never lifts the group exclusion.
