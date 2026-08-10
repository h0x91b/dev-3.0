# Trust the branch, not the project

## Context

GitHub issue #1315 reported that adding a directory as a dev3 project is silently
reused as approval for everything executable the repository later asks for:
`.dev3/config.json` `setupScript` and `cleanupScript` run during normal task
lifecycle, and `ensureClaudeTrust` writes `hasTrustDialogAccepted: true` plus
`enableAllProjectMcpServers: true` whenever the worktree holds a `.mcp.json`.

The reporter's own reproduction — add a repo you created yourself, watch its setup
script run — is defensible behaviour: the user cloned it and opened it in an editor.
The path they did not look at is the dangerous one. Pasting a pull-request URL into
the create-task description resolves through `resolvePrUrl`
(`src/bun/rpc-handlers/git-operations.ts`), which adds the **fork** as a git remote
and fetches its branch; `createWorktree` checks that branch out, and
`resolveOperationalProjectConfig` reads worktree config layers FIRST — so a
stranger's committed `setupScript` runs on the reviewer's machine, two clicks in,
with no warning anywhere (a grep over `src/mainview/i18n/translations/en/` found no
string about foreign or untrusted branches).

## Investigation

Seven ways a checked-out repo reaches a shell, not the three the issue names:
`setupScript`, `cleanupScript` and `devScript`; `env`, whose keys are validated by
name only (`ENV_KEY_RE` in `src/shared/env-text.ts`) so `BASH_ENV`, `NODE_OPTIONS`,
`GIT_SSH_COMMAND` and `DYLD_INSERT_LIBRARIES` all pass through into every session;
`builtinColumnAgents`, whose prompt is handed to an agent running with the user's
permissions; the pre-approved `.mcp.json` server command lines; and the committed
`.claude/settings.json` hooks that Claude Code honours once the folder is trusted.
Dropping the three script fields — the issue's own suggestion — therefore leaves a
working execution path behind.

## Decision

Whose code a task is about is decided **once, at creation**, from the ref it starts
on: `git.isForeignBranchRef` (`src/bun/git.ts`) classifies `origin/x` and
`forkOwner/x` as foreign and persists `Task.foreignCode`
(`createTask` in `src/bun/rpc-handlers/task-lifecycle.ts`; variants and attempts
inherit it). For such a task:

- `resolveOperationalProjectConfig` marks the worktree's layers untrusted, so they
  stop supplying `COMMAND_BEARING_KEYS` (`src/bun/repo-config.ts`). Everything that
  does not execute still resolves worktree-first, and the project's own checkout
  still supplies the commands — the task launches normally.
- `ensureAgentTrust` (`src/bun/rpc-handlers/tmux-pty.ts`) does nothing, so the
  branch's `.mcp.json` and `.claude` hooks meet the agent's own approval prompts.

The flag is the user's, not ours: `setTaskForeignCode` clears it after a confirm
that spells out what starts running (`TaskInfoPanel.ownForeignCode`). It forbids
nothing else — no transition is blocked and nothing is read-only. A `ForeignCodeMark`
glyph states it on the board and in the inspector, and the diff viewer badges any
changed file dev3 executes (`src/shared/executable-config-files.ts`).

`isForeignBranchRef` answers from `git remote`, never from `refs/remotes/<ref>`: a
merged pull request's branch is deleted upstream, and a ref check would then quietly
hand the task back its own trust. A git failure answers "foreign".

## Risks

- **Case D stays open, deliberately.** Once a pull request is merged, its
  `.dev3/config.json` lives in the trusted checkout and executes on the next task —
  as does any `git pull` that changes it. The RUNS badge is the mitigation (see it
  before merging); a content fingerprint on the trusted config would close it and
  was consciously deferred as a separate change.
- **Case C stays open.** A task with no `existingBranch` is created off a freshly
  fetched `origin/<base>`; a compromised upstream is trusted.
- A legitimate pull request that genuinely changes `setupScript` will not take
  effect until it merges, or until the user clicks through the warning. Accepted:
  that is the correct default.
- One trust dialog per reviewed branch, per agent. Accepted — it is the prompt's
  entire purpose.

## Alternatives considered

- **Approval receipts keyed on a content digest** (what the issue asks for). Needs a
  pause-for-user-input step the lifecycle machine does not have, a receipt store
  under `~/.dev3.0` where the on-disk invariants apply, and it re-prompts on every
  innocent edit — prompt fatigue would make the guarantee fictional.
- **Move the executable fields to `.dev3/config.local.json` only** (also suggested in
  the issue). Deletes the point of shared repo config — one committed setup script
  for a team — and still misses `env`, `.mcp.json` and the Claude hooks.
- **Two separate concepts: a computed provenance for security plus a user-facing
  review flag.** Rejected as over-engineering: one flag the user can clear, with the
  consequences spelled out, keeps the model honest — the risk moves to the person who
  took it, which is where it belongs.
