# Both transcript-discovery paths are taught about agent accounts, not unified

## Context

Conversation search and the agent adapters each found Claude transcripts on their
own, and both read `~/.claude/projects` only. dev3 injects `CLAUDE_CONFIG_DIR`
pointing at `~/.dev3.0/agent-accounts/claude/<id>` for any task launched under a
non-default account, so every transcript written by such a task was invisible to
search, to resume, and to the new import.

## Decision

One resolver, two callers. `src/bun/agent-store-roots.ts` owns
`claudeConfigDirs(home)` — the home store plus every agent account, with a
symlinked account that resolves to the home store dropped so nothing is reported
twice. `claudeTranscriptDir` in `src/shared/conversation-search-core.ts` is the
only place the `<configDir>/projects/<encoded-cwd>` layout is written down. The
adapter's `transcriptStore(worktreePath, configDirs)` takes the dirs as a
**required** parameter, so forgetting the accounts is a compile error, and
`src/bun/__tests__/claude-store-discovery-guard.test.ts` fails on a hand-rolled
`.claude/projects/...` path anywhere in `src/`.

The two mechanisms stay separate. Search locates *units* to score across four
transcript formats; the adapters answer "where does this agent keep its session
files" for resume and dumps. Merging them would put BM25 concerns into the agent
registry for no gain.

## Risks

- A third caller could still hand-roll the path in a `.tsx` file outside `src/bun`
  and `src/shared`; the guard walks `src/` from `src/bun/__tests__`, so it covers
  both, but a new top-level directory would need the guard's root updated.
- `claudeConfigDirs` reads the account directory on every call. It is a `readdir`
  of a handful of entries, called per scan, not per file.

## Alternatives considered

- **Unify search and the adapters behind one store abstraction**: rejected as a
  much larger refactor whose only benefit is aesthetic.
- **Read `CLAUDE_CONFIG_DIR` from the environment**: rejected — the scan runs in
  the app process, which has its own environment, not the agent's.
