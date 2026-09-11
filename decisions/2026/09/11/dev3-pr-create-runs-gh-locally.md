# `dev3 pr create` runs git and gh locally, and gates on gh before pushing

## Context

Opening a pull request from a task used to be a handoff: the UI types a prompt into the
agent's pane and the agent runs `git push` and `gh pr create` itself
(`createPullRequest` in `src/bun/rpc-handlers/git-operations.ts`). Agents therefore
re-derived the same recipe every time — including the origin-task footer, which is easy
to forget or to paste with the wrong task id.

## Decision

`dev3 pr create` (`src/cli/commands/pr.ts`) does it in one command, entirely in the CLI
process: `gh --version` → `gh auth status` → `git rev-parse` → `git push -u` →
`gh pr create` → optional `gh pr merge --auto --<strategy>`. `dev3 pr auto-merge` is the
same last step for a pull request that already exists (`--off` clears it). Both are routed
in `main.ts` next to `doctor`/`inline-html`, before socket resolution, so they work with
the app closed.

**Every prompt that used to spell out the `gh` recipe now names these commands**, which is
the point of the change — the recipe existed in three places and the footer was the part
that got dropped:

| Prompt | Was | Is |
|---|---|---|
| `createPrAgentPrompt` (`rpc-handlers/git-operations.ts`, the UI's Create PR button) | "run git push, then gh pr create", plus the footer line to copy | "run `dev3 pr create …`", and do not run git push / gh yourself |
| `skillPrLinkInstruction` (`shared/agent-skill-content.ts`, the protocol body and system prompt) | the footer template with `<TASK_ID>` to fill in | open it with `dev3 pr create`; the footer is the command's job |
| `ASK_DEV3_SKILL_CONTENT` step 9 (`bun/agent-skills.ts`) | UI-only description | names both commands for an agent |
| `AGENTS.md` Git section | `gh pr merge --auto --squash` | `dev3 pr auto-merge`, with the bare-`--auto` trap named |

The handoff consequently stopped reading settings and stopped building the deep-link line:
both gates live in one place now.

Three choices worth stating:

- **The `gh` check runs before the push**, with its own exit code 23
  (`CLI_EXIT_CODE_GH_UNAVAILABLE`). Discovering a logged-out `gh` after the push leaves a
  branch on the remote and no pull request, which reads as a half-done command.
- **The footer comes from `shared/deep-link.ts`**, the one source the UI handoff used to
  read too, and is dropped under the same two conditions (no `dev3://` handler on this platform, or
  `prOriginTaskLink === false`).
- **`prOriginTaskLink` is read straight out of `~/.dev3.0/settings.json`** rather than
  through `src/bun/settings.ts`. That module pulls the backend logger and data layer into
  the CLI's static import graph, which `cli-startup-graph.test.ts` exists to keep light;
  this is one boolean, and `doctor.ts` already reads the same file directly.

## Risks

**A valueless switch eats the next token, and that bit hard.** `parseArgs` gives a bare
`--flag` the following non-flag token as its value, so `dev3 pr auto-merge --off 1722`
arrived as `off="1722"` with no positional. Read as "off is not set", it did the opposite
of the request — it ENABLED auto-merge on the branch's own pull request, and #1722 merged
itself once CI went green. `requireValuelessFlag` now refuses a switch that carries a
value and names the fix (`dev3 pr auto-merge 1722 --off`); `--draft` and a valueless
`--description` are refused the same way. Any switch added to `dev3 pr` later must go
through it — for a command that can merge code, "guess the intent" is not an option.

The protocol body is capped (`AGENT_SKILL_BODY_LIMIT`), and the new instruction is longer
than the footer template it replaced on non-macOS hosts: the tightest composed body
(Codex on Windows) is left with about 80 characters of slack. The next section added there
has to cut prose, not raise the cap.

The default base branch comes from the task's stored `baseBranch`, so a task whose branch
was later retargeted by hand gets the old base unless `--base` is passed. Reading
`settings.json` inline means a future rename of that field has two call sites; both are
named in the comment.

## Alternatives considered

Route it through the app's RPC and reuse `createPullRequest`: rejected because that path
is a *handoff* (it types a prompt at an agent) and because it would make opening a pull
request require a running app. Keep it a handoff and only document the recipe better:
rejected — the footer and the base branch were exactly what got dropped.
