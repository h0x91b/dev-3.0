# The git bar's actions follow repo state, and only text-authoring ones go to the agent

## Context

The task git bar has eight buttons (Diff, Commit, Rebase, Push, PR, Auto PR, Merge, Refresh). Three of them — Commit, Create PR, and the conflicting Rebase — hand off to the agent; the rest run generated scripts in a pane (`git-ops-visible-terminal`, `git-op-panes-decisions-in-typescript-not-two-dialects`). Nobody had written down which case is which, so the remaining buttons had no principle to follow, and four defects had accumulated:

1. `pushGitOpSpec` ran a plain `git push origin HEAD`. After any rebase-then-push the branch has diverged and git refuses non-fast-forward. The pane printed `✗ Push failed (exit 1)` and **no toast fired at all** — the toast path only covers a throwing RPC, and opening a pane always succeeds. `BranchStatus` had no divergence-vs-remote number, so the UI could not even know.
2. `mergeGitOpSpec` squashed into the main clone's **local** base branch and never pushed. With a remote, the work looked landed while `origin/<base>` never heard about it. On conflict it left the user's own project checkout mid-merge with no guidance line.
3. No `foreignCode` gating anywhere in the bar or the handlers: a PR-review task could push and merge a colleague's branch by mis-click.
4. Nothing asked whether origin is GitHub. `isPublicGitHubHost` only chose a token env var, so a GitLab/Gitea remote got PR buttons whose agent prompt runs `gh pr create`.

## Investigation

Defect 4 was first fixed the obvious way — a pure `isGitHubRemoteUrl` matching `github.com` / `*.ghe.com` in `git remote get-url origin`. It passed a nine-case unit test and the whole suite, and **the mandatory browser pass caught it disabling Create PR on this very repo.** dev-3.0's origin is `git@github.com-personal:h0x91b/dev-3.0.git`: an SSH config alias, the standard way to keep two GitHub accounts apart, and exactly what this developer uses. The real host is invisible in the URL.

Measured directly, `gh` gets all three cases right where the URL cannot:

| Repo | `gh pr list` says |
|---|---|
| origin via the `github.com-personal` SSH alias | `[]` — resolves fine |
| origin on gitlab.com | `none of the git remotes configured for this repository point to a known GitHub host` |
| no remote at all | `no git remotes found` |

So the question was wrong. It is not "is this URL GitHub" but "can `gh` operate here", and only the tool that will run the command can answer it.

The user considered two wider redesigns — a state-driven "one primary next step" pipeline, and routing every button through the agent — and rejected both. Eight buttons stay; the defects get fixed.

## Decision

**The rule, written down: an action goes to the agent when it must AUTHOR text or exercise JUDGMENT (commit message, PR body, conflict resolution). Everything else is a deterministic pane script.** Push is never an agent handoff. This is what the code already did; naming it stops the next button from being decided by mood.

Concretely:

- **`BranchStatus` gains `remoteAhead` and `remoteIsGitHub`** (`src/shared/types.ts`, computed in `getBranchStatusImpl`). `remoteAhead` reuses the existing `git.getBehindOriginCount`. `remoteIsGitHub` comes from **gh's own verdict**, read off the `gh pr list` call that PR detection already makes every poll — no extra round trip. `github.isNotAGitHubRepoError` matches gh's two definitive messages and nothing else, so a timeout, a 502, a missing binary or an auth prompt all leave the answer `true`: **a false negative kills a working button, a false positive costs one wasted agent turn.** `createPullRequest` asks the same question through `github.isGitHubRepo` (`gh repo view`).
- **Push escalates itself** (`pushTask`, `pushGitOpSpec`): when the branch diverged it fetches, resolves `origin/<branch>` with the new `git.resolveRef`, and runs `git push --force-with-lease=<branch>:<sha>`. The plain path gained `-u`. The renderer reads the same `remoteAhead` to rename the button to **Force push** with danger styling and to confirm the click — it cannot *ask* for a force, so label and command cannot disagree.
- **Merge pushes the base branch** when there is a remote (`mergeGitOpSpec`'s `pushBase`), as the last and therefore verdict-bearing step, behind a confirmation naming the PR/CI bypass. Without a remote it is unchanged.
- **`assertOwnBranch`** refuses `pushTask` / `mergeTask` / `createPullRequest` for a foreign-code task; the bar removes those three buttons rather than disabling them. Diff and Rebase stay — they serve the review.
- **`createPullRequest` refuses a non-GitHub origin**, and both bar and sheet drop the PR buttons there while keeping Push live.
- **A pane failure now raises a toast**, keyed per operation, in the `rpc:gitOpCompleted` listener.

## Risks

- `-u` on the plain push is new behaviour: it writes upstream tracking on task branches that previously had none. Desirable, but it does change `@{upstream}` for anything reading it.
- The lease sha is read in TypeScript, not expanded in the shell, per the dialect decision record. Git compares it against origin's real value during the handshake, so there is no race — proven in `git-op-pane.bun-e2e.ts`, which pushes from a second clone and checks the stale lease refuses and the other commit survives.
- `remoteIsGitHub` now depends on gh's wording. If gh ever rephrases either message the check silently reverts to "always GitHub" — i.e. back to today's behaviour, not to a broken button. `github.test.ts` pins both strings as copied from a live run.
- Merge's confirmation fires whenever `hasRemote`, including with an open PR (the message then names the PR). It does not block the local squash — sometimes that is genuinely wanted.

## Alternatives considered

- **Classifying the remote by its URL.** Built, tested, and killed by the browser pass — see Investigation. An SSH config alias makes the host unknowable from the URL, and reading `~/.ssh/config` to resolve aliases is guesswork on a naming convention.
- **Unconditional `--force-with-lease` on Push.** Rejected: the bare form needs a remote-tracking ref, errors out when there is no upstream, and leases against a STALE ref when one exists — which silently overwrites an unfetched push. The protection evaporates exactly when it is needed.
- **Delete Merge when a remote exists, or hard-wire it to `gh pr merge`.** Rejected by the user: it kills the solo "squash and push main, no PR" flow, which is this product's positioning, and breaks the no-remote mode outright.
- **Route every git button through the agent.** Rejected: 10–60 s per push, an agent turn stolen mid-task, context spent on `git push`, and a delivery channel whose own type is three-valued (`delivered` / `unconfirmed` / `not-delivered`).
- **Collapse the bar to one primary next step plus an overflow.** Designed and rejected by the user for now; the analysis and the thirteen standard scenarios live in the task's notes.
