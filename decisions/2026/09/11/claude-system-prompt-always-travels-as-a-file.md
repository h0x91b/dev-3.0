# Claude's system prompt always travels as a file

## Context

dev3 injected the ~27 KB task-lifecycle protocol into every Claude launch with
`--append-system-prompt <body>`, so the whole protocol sat in each agent's
`argv`. `pgrep -f` / `pkill -f` match against the full command line, so ordinary
English words inside the protocol — `agent-browser`, `read-only`, `hibernate` —
matched every running agent on the machine. One agent restarting "its own"
browser daemon SIGTERMed every sibling agent, twice on one machine in two days
(h0x91b/dev-3.0#1734). The file channel already existed but was gated to Windows
PowerShell, where the reason was the 32 767-character command-line ceiling.

## Investigation

`--append-system-prompt-file` is not printed in `claude --help` on 2.1.236 (it
appears only inside another flag's description), so it was verified by running
it: a prompt file containing a random sentinel, asked for through `claude -p`,
came back with the sentinel; the same question without the flag answered `NONE`.
An unknown option errors out loudly in a real launch (`--version` short-circuits
option validation), so an older Claude without the flag fails visibly at launch
rather than silently dropping the protocol.

A live launch with the file shows a 214-byte argv and zero `pgrep -f` matches on
the prompt text; the old inline shape shows 14 645 bytes and four matches.

## Decision

`systemPromptNeedsFile()` is gone (`src/bun/agent-system-prompt-file.ts`);
`systemPromptFileFor()` in `src/bun/agents.ts` now returns a path for every
Claude launch on every platform. Two further changes:

- **Content-addressed names.** `claude-<sha256:16>.md` instead of `claude.md`,
  written through a temp file and renamed. Two app versions running side by side
  have different protocol bodies, so they no longer race to overwrite one path
  between dev3's write and the child's read. Files are immutable and never
  pruned, so an older version's `claude.md` and every past body stay readable.
- **No inline fallback.** A failed write throws instead of returning `null`. The
  fallback was the argv exposure itself; on Windows it could not launch anyway.

The pure adapter (`src/shared/agent-adapters/claude.ts`) keeps an inline branch
for a caller with no backend behind it; the golden matrix asserts that no Claude
command `resolveAgentCommand` builds carries a sentence of the protocol, on any
platform or option.

## Risks

- A Claude old enough to lack `--append-system-prompt-file` now fails to launch
  instead of running with the protocol inline. It fails loudly (`error: unknown
  option`), which is the same exposure Windows has shipped with for months.
- Already-running agents keep the old argv until they are restarted, so the
  `pkill -f` hazard persists for existing sessions. Deliberately not fixed by
  restarting anyone's session.
- One ~27 KB file accumulates per distinct protocol body (per app version). Not
  pruned on purpose — pruning one could break a resume whose stored command line
  still names it.

## Alternatives considered

- **Keep the platform gate and shorten the protocol.** Does not close it: any
  body long enough to be useful still contains matchable words.
- **Remove the adapter's inline branch entirely.** Structurally stronger, but it
  rewrites dozens of pure-adapter expectations for no production gain; the
  golden-matrix guard covers the same ground.
- **Keep the single `claude.md` name.** Simpler, but a parallel app version with
  a different body can overwrite it in the window between write and exec.
