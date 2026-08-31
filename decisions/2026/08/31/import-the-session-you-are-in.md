# `dev3 import` takes no arguments, and the working directory is the only way to pick a project

## Context

`dev3 conversations import` picks up the Claude Code conversations a project
accumulated in the past. It does not cover the one an agent is sitting in right
now, which is the case an agent can actually act on — it knows the work is worth
keeping the moment it becomes worth keeping.

## Investigation

Run from an agent's own shell both halves of the question are already answered,
so a picker would be asking about state the process already holds:

- the working directory says which project owns the work;
- `CLAUDE_CODE_SESSION_ID` says which conversation this is (verified against a
  live session rather than assumed).

Two spellings of "the project's directory" turned out to matter, because the
comparison happens between strings that three different systems produced.
`process.cwd()` reports the PHYSICAL path; the folder picker stored whatever the
user browsed through, symlink and all, and on Windows with backslashes; and a
Claude store directory is named after the cwd that agent's shell reported. Any
two of those can disagree about the same directory.

## Decision

`dev3 import` (top level, `src/cli/main.ts`) takes no arguments and offers no
list. A stray argument is a usage error rather than something to ignore, because
`dev3 conversations import --sessions <id>` sits next door and invites the
mistake.

A conversation is imported into the project owning the directory it ran in and
**nowhere else** — deliberately no override flag, since any other target attaches
the work to the wrong repository. `projectOwningCwd` (`src/cli/context.ts`)
matches on a path boundary, never a bare prefix, and compares a normalised
spelling of both sides: symlinks resolved, separators forward, no trailing slash.
It returns the project record with its **stored path untouched**, because that
exact string is what `projectStorageKey` turned into the project's data
directory, and the frozen on-disk layout (AGENTS.md) is not negotiable.

`projectPathCandidates` (`src/bun/conversation-import.ts`) answers the same
question from the other end: rather than rewriting the project path, it offers
every spelling a Claude store name may legitimately be encoded from — the stored
one first, the physical one second — and whichever matches decides what "inside
the project" means for that store.

Both local answers (the session id and the owning project) are resolved by
`resolveImportTarget` **before** the CLI looks for the app. "No dev3 project owns
this directory" is a common answer, not an error footnote: measured on a real
board, of 30 transcripts carrying a cwd only 7 sat under a registered project.
It has its own exit code, `20`, and names the directory it checked. In the two
directories agents actually live in — a dev3 worktree and a virtual board's
working dir — it says what is true there instead ("this conversation is already
the task", "a virtual board has no repository") rather than the useless "add this
repository to dev3".

## Risks

Importing a live conversation freezes it: the description is the transcript at
that moment, it does not follow the rest of the session, and the
`importedSessionId` guard makes a second run answer "already on the board"
instead of refreshing. A recently active conversation also arrives with a git
worktree of its own, branched from the branch it ran on. Both are stated in
`dev3 import --help` and in the changelog rather than left to be discovered.

Resolving symlinks costs a `realpathSync` per registered project per invocation.
It is bounded by the number of projects and only runs for this one command.

## Alternatives considered

**Rewrite the stored project path once, at the source.** Tidier, and forbidden:
the path names the project's data directory under `~/.dev3.0`, and every other
installed version of the app reads that directory.

**Normalise the project path inside the scan.** Tried, and it broke seven shipped
discovery tests — the store name is encoded from the cwd Claude recorded, which
is not always the physical path. Offering both spellings as candidates fixes the
symlink case without changing what already worked.

**An `--project` flag.** Rejected: the one thing it buys is attaching a
conversation to a repository it never ran in.
