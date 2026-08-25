# Import a session by its transcript, not by its process

## Context

Users run agent sessions outside dev3 — a plain terminal, their own checkout —
and want that work on the board without retyping it. "Import" sounds like it
should adopt the running process. It cannot, and the interesting question turned
out to be which artifact identifies a session: the live process, or the
transcript it leaves on disk.

## Investigation

Everything below was measured on this machine (Claude Code 2.1.246, git 2.55.0),
not read off the code.

**Adopting a live process is a wall on both backends.** Native opens the pty
itself (`native-terminal-registry/host.ts:351-386`) and classifies a foreign pid
as `reused` (`ownership.ts:44-70`); Windows is native-only, so adoption is
impossible there by construction. tmux would mean speaking to the user's own
socket and `source-file`-ing dev3's config into their server across version skew
(`pty-server.ts:1732-1739`, `tmux/binary.ts:63-68`). The decisive one on both:
`-e` / `set-environment` seeds only NEW processes
(`pty-server.ts:1848-1851, 1946-1950`), so a live foreign agent can never receive
`DEV3_TASK_ID` — no status hooks, no `dev3 message`, no board automation
(`cli/context.ts:93-107, 227-247`). So import can only mean re-hosting.

**Re-hosting by session id works, and `--continue` does not.** Created a session
in directory A, ran `claude -p --resume <id>` from directory B: it resumed, and
appended to **A's** file (107 612 → 127 456 bytes) with new records stamped
`"cwd":"<B>"`. Resume is cwd-independent. `claude --continue` in B started a
brand-new session instead.

**Two candidate discovery surfaces, and only one generalizes.**
`~/.claude/sessions/<pid>.json` is an undocumented live-session registry (pid,
cwd, sessionId, `status: busy|idle`, tmux pane, `procStart`). It is Claude-only —
no other harness has anything comparable — and its `procStart` is recorded in
**UTC** while `ps -o lstart=` prints **local**, so the natural pid-reuse guard
fails on every non-UTC machine and would classify every session as dead. Against
that, dev3 already models transcript stores for three harnesses:
`LOCATORS = [claudeLocator, codexLocator, geminiLocator]`
(`conversation-search.ts:277`).

**The transcript path is also cheap and self-describing.** Scanning all 35
transcripts on this machine and reading each one's `cwd` from its *content* took
41 ms. Reading cwd from content matters: `claudeEncodePath` is lossy
(`conversation-search-core.ts:41-43`), so a store directory name cannot be
decoded back into a path.

## Decision

**A session is identified by its transcript.** Import lists past sessions,
scoped to a project by the `cwd` recorded inside each transcript, and re-hosts
the chosen one with `--resume <id>` in a **fresh dev3 worktree on a branch forked
from the session's own** — stock `existingBranch` behaviour
(`git.ts:1058-1080`), so diff/PR/review columns and teardown are unchanged.

- Title and description come from `ParsedConversation.title` — already parsed
  from Claude's `ai-title` records (`conversation-parsers/claude.ts:279`,
  registered at `:43`) — falling back to the first human turn, with
  `renderHandoff` (`conversation-render.ts:155`) as the body.
- The live registry is **optional garnish**: badge a row that is running right
  now, degrade to nothing when unreadable. It is never load-bearing, so no
  undocumented format and no pid arithmetic sits on the critical path.
- Surfaces: a mode strip in `CreateTaskModal`, mirroring
  `AddProjectModal`'s `local | clone | init` (`AddProjectModal.tsx:28`), plus
  `dev3 import` run inside the session's own shell.

**Import must persist the session's origin cwd.** This extends
`verify-resume-session-id-against-transcripts.md`, whose resolver deliberately
"never downgrades a resume it cannot check". An imported task defeats that
intent: resuming from the new worktree creates
`~/.claude/projects/<encoded-new-worktree>/` containing only an empty `memory/`
and no `.jsonl`, so the store *looks* checkable. `existsSync(store.dir)` passes,
`sessionIdsNewestFirst` returns `[]`, and `resolveResumableSessionId`
(`agent-transcripts.ts:47-60`) yields `ids[0] ?? null` = null → `--continue`
(`agent-adapters/claude.ts:76-78`) → a fresh session, with only a `log.warn`. The
import launch succeeds and the first recovery silently orphans the conversation.
The resolver must therefore check the recorded origin store before falling back.

## Risks

- **Undocumented formats.** `ai-title`, `custom-title` and the store layouts are
  reverse-engineered and have already churned across observed versions. Every
  read needs a null path and must degrade to "no title", never to a crash.
- **An imported session may still be running.** Listing past sessions makes this
  unlikely rather than impossible, and two concurrent clients on one transcript
  is still unverified. The registry badge is the mitigation, not a guarantee.
- **Dead branches.** A finished session's branch may be merged or deleted; the
  flow needs a fallback to the project's base branch.
- **Uncommitted work stays behind** in the user's checkout. Carrying it over is
  `git -C <origin> diff HEAD | git -C <worktree> apply`; untracked files are not
  covered and must be reported rather than silently dropped.
- **Subdirectory sessions.** A session started in `repo/packages/api` is a
  different cwd than `repo`. Prefix-matching the cwd read from content handles
  it; exact equality (`conversation-search.ts:192-194, 249-251`) does not.

## Alternatives considered

- **Adopt the live process** — impossible on both backends; see Investigation.
- **Discover via `~/.claude/sessions/`** — Claude-only, undocumented, and carries
  the UTC/`lstart` trap. Demoted to an optional badge for exactly those reasons.
- **List live sessions rather than past ones** — a shorter list (9 vs 35 here),
  but it makes the Claude-only registry load-bearing and buys a concurrency
  problem instead of avoiding one.
- **Point the task at the user's own checkout** (`opsWorkDir`, or a git task on
  their directory) — keeps uncommitted work, but arms teardown at a directory
  dev3 does not own. Measured: `git worktree remove --force` on a *main* checkout
  exits 128 with a message `isUnregisteredWorktreeError` does not match
  (`git.ts:2439-2441`), stranding the task in `tearing-down`; on a *linked*
  worktree it exits 0 and deletes the directory silently. Plus
  `reapWorktreeProcesses` SIGKILLs every process whose cwd is under the task root.
- **A card that only retells the session** — an afternoon's work and risks
  nothing, but it is a bookmark: the conversation itself never reaches the board.
- **Ask the running agent for a description** — Claude exposes an undocumented
  peer socket (`/tmp/cc-socks/<pid>.sock`), but it perturbs the target transcript
  and no other harness has one. Unnecessary: `ai-title` answers it from disk.
