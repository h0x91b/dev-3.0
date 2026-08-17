# Canonical conversation event model, parsed on demand

## Context

Three planned features need agent conversations as data, not as text: importing past conversations into dev3, handing a conversation from one agent to another, and storing conversations in parsed form. dev3 already located transcripts for `conversations search` (`src/bun/conversation-search.ts`), but flattened them into `string[]` — enough for BM25, useless for anything structural.

A survey of existing npm packages (`continues`, `@agent-pattern-labs/iso-trace`, `claude-replay`) found none usable as a dependency here: `continues` requires Node >= 22.5 and its `extractContext()` truncates to the last 10–50 messages by design (it targets handoff, not archival); `iso-trace` deliberately discards Claude thinking blocks; `claude-replay` exposes no stable parser entry point. Their real value was as format references, and their `Session → Turn → Event[]` shape informed ours.

## Investigation

Both formats were characterized against live on-disk files, not from memory.

- **Claude Code** (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`): eight record types in one session — `user`, `assistant`, `attachment`, `system`, `mode`, `permission-mode`, `last-prompt`, `ai-title`. Records thread by `parentUuid` and carry `isSidechain`, so a conversation is a tree.
- **A thinking block keeps its body in `thinking`, not `text`**, and arrives empty (signature only) when redacted. The pre-existing search extractor reads `b.text` for thinking blocks, so reasoning has never been searchable.
- **Token usage is billed per record, not per block.** Streaming splits one assistant turn into thinking-only, tool_use-only and text-only records, each with its own `usage`. A first cut attached usage to text blocks and reported 18 257 output tokens where the file held 90 225.
- **Codex** (`~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`): two overlapping streams in one file. `response_item` is the model history (`message`, `reasoning`, `function_call`, `custom_tool_call`, and their `_output` twins); `event_msg` is the UI stream and restates content as `user_message` / `agent_message` / `agent_reasoning`. Its session id is in the `session_meta` header, not the filename, and `token_count` reports both cumulative and per-turn usage.

## Decision

- Pure model in `src/shared/conversation-model.ts` (types, usage math, `scanJsonl`) and pure parsers in `src/shared/conversation-parsers/{claude,codex}.ts`. Zero dependencies, no fs — the whole format layer is unit-testable from strings.
- **Flat event log** (`message` / `thinking` / `tool-call` / `tool-result` / `attachment` / `lifecycle`), not a message list. Native ids and `parentUuid` are preserved so the tree survives; tool results pair by call id only, never by adjacency.
- **Nothing is dropped silently.** Unmapped records become `lifecycle` events and increment `stats.unknownRecords`; Codex's duplicated UI events increment `stats.duplicateRecords`; a truncated final line counts as a live write, not corruption. Every skip surfaces in `fidelity.warnings`.
- I/O in `src/bun/conversation-parse.ts`; file discovery is reused from `conversation-search.ts` via the new `transcriptFilesForWorktree`, so a new locator serves both search and parsing.
- Surfaced as `dev3 conversations dump`, writing to the task's own container directory — `<worktrees>/<slug>/<taskShortId>/conversations/`, beside the `logs/` and `diffs/` already there. Stamped with `parserVersion` and re-derivable from the native transcript at any time.

### Why the dump lives in the task directory, not a shared root

A shared `~/.dev3.0/conversations/<slug>/` was tried first, on the assumption that a task's directory dies with the task. It does not: `removeWorktree` (`src/bun/git.ts`) removes only `<taskShortId>/worktree` and never its parent, and nothing else — including the worktree reaper, which only kills processes — deletes the container. Verified on disk: 1472 of 1518 task directories in one project exist without a `worktree/` and still hold their `logs/` and `diffs/`.

So the per-task directory is both durable *and* correctly scoped. One task can accumulate many agents and many compactions; keeping those files inside the task means export, import and "delete the old ones" are directory operations, and the shared root stays clean.

Verified end to end on a live session of this task: 538 events, 30 thinking blocks, 67 tool calls and all four token counters match an independent Python count of the same file snapshot exactly.

## The generation direction

A parsed conversation that still speaks its source agent's dialect cannot be re-rendered for another client, so three things were added on top of the ingest layer.

**Tool semantics** (`src/shared/conversation-tools.ts`): every native name maps to a canonical operation — Claude's `Bash{command}` and Codex's `exec_command{cmd}` both become `shell.run{command}` — with the native name always retained and anything unmapped kept as `unknown`. The mapping is asymmetric where the agents are: Codex has no file read tool, Claude has no code-mode sandbox. Codex also has no Write/Edit at all, so the files it changed are recovered from `*** Update File:` headers inside `apply_patch` bodies (verified against a real session: 24 patch calls → 9 distinct files).

**Two layers and turns** (`ParsedConversation.turns` + `sessionEvents`): the conversation is grouped into exchanges, and the agent's own bookkeeping is kept aside. This is the difference between a re-encoding and a model — in this task's own session the bookkeeping is 813 records against 401 conversation events, so leaving it inline buries the conversation under its own plumbing.

**A renderer** (`src/shared/conversation-render.ts`, `dev3 conversations handoff`): the retelling, as one message. **A native transcript for another client is deliberately not attempted** — `--resume` reads only the agent's own file, Claude signs its thinking blocks so they cannot be forged, and the tool sets do not match. Any cross-client continue is a retelling; the renderer keeps prompts and replies verbatim and bounds tool output (default 2048 characters per call; this session renders to 76 KB with output dropped, 169 KB with it kept).

## What a dump keeps — decided by cold-agent experiment, not taste

The first dump of this task's own session was 1.09 MB, and the obvious question was whether the full tool input/output earns that. Rather than judge it from inside the conversation, three agents with no prior context were each handed the same dump at a different truncation budget and asked to take the work over cold. A fourth measured the file's byte composition.

| Budget | Size | Takeover score |
|---|---:|---:|
| Full | 1 086 286 B | 8 / 10 |
| 1 000 chars | 764 815 B | 7 / 10 |
| 100 chars | 589 128 B | 6.5 / 10 |

**The curve is nearly flat, and all three reached the same verdict independently: the dump is an excellent specification and a poor codebase — a real takeover starts by opening the git branch.** Cutting 46% of the file cost 1.5 points, and every loss they named (file contents, command bodies, a 36 KB file-read output) is re-derivable from the repository or by re-running. All three also listed the same dead weight: the session-event array, per-event token usage, and event ids.

The measurement found duplication nobody had noticed: `tool.canonical` was 98.2% byte-identical to the same event's `tool.input`, and `turns[].assistantText` was 100% identical to message events of its own turn — 17.9% of the file stored twice. Pretty-printing was another 16.3%, and the 908 payload-free session records 16.2%.

`src/shared/conversation-dump.ts` therefore makes the dump a **projection** of the lossless in-memory parse: duplicated fields omitted, per-event usage dropped, the session layer discarded except the two records that change a takeover decision (`edited_text_file` and the compaction marker), and payloads truncated per role.

A second measurement of a real dump found the same class of waste again, and each item is now cut: `turns[].userText` duplicated the turn's own user message (11.2% of the file); `canonical.command` / `canonical.path` are lifted out of `input`, so they are kept only when truncation cut them out of it; an `edited_text_file` snippet is a whole file and was bypassing the budget entirely because it rides in `meta`, not in `tool` (7.6%); and Claude withheld the body of *every* reasoning block, so 102 signature-only events were costing ids and timestamps to say "it thought here" — they collapse into a per-turn `redactedThinking` count.

Tool payloads are cut by **operation, not by size** (`TOOL_POLICY` in `conversation-dump.ts`). The native arguments are dropped outright — the canonical form already carries the path, command, pattern or prompt in one shape for every agent, so keeping both stored each call twice in two dialects. What survives then depends on whether the next agent can get it back for free: a file read/write/edit/patch keeps only its path, because the repository and `git diff` hold the bytes and an edit's search/replace pair describes a state that no longer exists; a shell command is kept whole with its output bounded, because the command exists nowhere else; anything from outside the machine (a fetched page, a web search, a subagent's report) keeps a bounded copy since nothing can re-derive it. An unmapped tool keeps its arguments verbatim — guessing what is safe to drop there would lose real content. On this conversation that dropped 292 tool inputs and 147 outputs and took the dump from 897 KB to 731 KB while the conversation itself grew.

Compaction is the one session record with real transfer value, so both parsers normalize it to `meta.recordType = "compaction"` (`COMPACTION_RECORD_TYPE`): Claude emits a `system` record with `compactMetadata`, Codex a `compacted` UI event with no metrics. The Claude form carries `tokensBefore` / `tokensAfter` / `tokensDropped` / `durationMs`, which is how a reader learns the agent lost 407 853 tokens of context mid-task. The summary that replaces the history arrives as an ordinary `user` record; without a flag a reader takes the agent's own handover text for a user request, so it is tagged `meta.compactSummary`. Budgets are per role because one number cannot serve both: an absolute worktree path is ~92 characters on its own, so the 100-char cap decapitated every path, while tool output has a median of 243 characters and two values holding 37% of all output bytes. Defaults: 2 000 characters for commands and paths, 1 000 for tool output and file contents. `dumpPolicy` records what was cut, so fidelity is never implied. `--verbatim` opts out entirely.

Result on this task's five sessions (main agent plus four subagents, which is exactly the "many agents in one task" case the per-task directory was chosen for): 1.0 MB total, where the main session alone previously took 1.09 MB.

## Risks

- Both formats are private and mutate between releases. Mitigation is the unknown-record counter plus `parserVersion`, so a drift shows up as a warning instead of silent loss.
- Codex reasoning is a summary only; the real chain ships encrypted. Reported as a fidelity warning rather than pretended to be complete.
- Gemini transcripts are discovered by the shared locator but have no parser yet; they are filtered out explicitly rather than mis-parsed.
- The parsed dump must never become the source of truth. Nothing reads it yet, which is the point.

## Alternatives considered

- **Depend on `continues`** — rejected: Node 22 + ESM against a `bun build --compile` CLI, and its context window truncates by design.
- **Depend on `iso-trace`** — rejected: drops thinking blocks, which dev3 wants.
- **Reuse the search extractor** — rejected: it is lossy on purpose (text only, no tools, no ids) and it also mis-reads thinking blocks.
- **A `packages/conversation-import` workspace** — rejected: the repo has no monorepo layout, and one feature is a poor reason to invent one.
