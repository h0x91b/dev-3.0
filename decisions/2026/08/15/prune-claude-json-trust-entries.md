# Prune dev3 trust entries from `~/.claude.json`

## Context

`ensureClaudeTrust` (`src/bun/agents.ts`) writes one `projects["<worktree path>"]` entry per task launch so Claude Code skips its trust dialog — into `~/.claude.json` and into the active managed account's own `.claude.json`. Nothing ever removed them.

Measured on one machine (machine-footprint audit, Seq 1551): 2 771 project entries, 2 214 of them dev3 worktrees, **2 130 pointing at directories that no longer exist**; 910 KB of a 1.9 MB file, 427 bytes per dead task. Cost is ~4 ms per Claude Code read/write cycle — not a latency problem. The real problem is unbounded growth inside another product's main state file, which survives uninstalling dev3, and which is a corruption/truncation surface for the user's other 557 projects.

## Investigation

The choice was "targeted delete on teardown + one-shot migration flag" vs "full sweep, run often". Measured the full sweep with the real module against a copy of the real 1.9 MB file, 20 runs: **median 8.58 ms** (min 7.6, max 243 — cold-cache outlier), 2 132 entries removed, 1 853 KB → 728 KB. Stat-ing 2 771 paths is included in that number.

At 8.6 ms a full sweep is cheaper to reason about than a migration flag, and self-healing: any teardown path we missed (project deletion, a crash between `git worktree remove` and the prune, a worktree deleted by hand) is cleaned by the next sweep.

## Decision

`src/bun/claude-json-prune.ts` handles `~/.claude.json` plus every managed Claude account's `.claude.json` (`listClaudeAccountDirs`). It exposes two functions and owns no schedule of its own — both are called from the shared seam in `src/bun/worktree-trust.ts` (`forget-worktree-trust-on-removal`), which the lifecycle already invokes after the `removeWorktree` / `removeTaskWorkspace` effects and once at startup:

- `forgetClaudeTrustEntries(targets, normalize)` — called from `forgetWorktreeTrust`, drops the just-removed worktree's entry by path (existence is irrelevant, the directory is gone by design).
- `sweepStaleClaudeTrustEntries(isUnderWorktreesRoot)` — called from `sweepStaleWorktreeTrust`, removes keys that are **both** under the dev3 worktrees root **and** point at a directory that no longer exists.

Path normalization and the "is this ours" test are the caller's, so Gemini and Claude Code can never disagree about which paths are dev3's. No migration flag, no one-shot marker.

**Fail closed.** Unreadable or unparsable file → log and return, never rewrite. A corrupt `~/.claude.json` breaks Claude Code entirely, and dev3 already broke Codex once this way (Seq 1540).

**Race with a live Claude Code.** The file is rewritten continuously (mtime was 103 s old mid-session). The prune stages a temp file next to the target, re-stats the original, and only `rename`s when `mtimeMs` and `size` are unchanged since the read; otherwise it retries up to 3 times and then gives up (`skipped: "busy"`), leaving the file alone. A `rename` is atomic, so a reader never sees a partial file — and Claude Code writes the same way (`.claude.json.tmp.<pid>.<ts>` + rename, observed on disk), so its writes always land as a whole file and always move mtime.

## Risks

- **Lost-update window.** If Claude Code rewrites the file within the same millisecond *and* to exactly the same byte size, the mtime+size check does not notice and its write is lost. Accepted: content hashing costs another full read for a window this narrow, and a lost `~/.claude.json` write is a tab of history, not credentials.
- **Startup sweep runs while agents from a previous app run are alive** in tmux. Same guard covers it; worst case the sweep skips and the next launch retries.
- **A worktree on an unmounted volume** would look "gone" and lose its trust entry. Only paths under the dev3 worktrees root are eligible, and the cost of a wrong prune is one trust dialog.

## Alternatives considered

- **Targeted delete on teardown only** (what `forgetWorktreeTrust` does by itself). Does nothing for the existing backlog, and nothing for a teardown that never ran — hence the startup sweep alongside it.
- **One-shot migration flag at startup.** Extra persisted state to get right, and it stops helping the moment a teardown path is missed. The sweep is 8.6 ms; the flag buys nothing.
- **A parallel prune of our own, hooked into the lifecycle next to Gemini's.** Two copies of "which paths are dev3's" drift; the shared seam was the reason to fold this in.
- **Sweep on a timer.** More writes into someone else's file for no benefit — entries only go dead at teardown.
- **Stop writing trust entries at all.** Would bring back the trust dialog on every task launch.
