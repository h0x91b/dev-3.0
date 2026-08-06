# 183 — Default compare ref is always `origin/<base>` when the remote ref exists

## Context

`detectDefaultCompareRef` (`src/bun/git.ts`) picks the diff/rebase/branch-status comparison target for a project when nothing configures it explicitly. Since #338 it ran `git shortlog -sne --since="2 weeks ago"` and, if the base branch had **one or fewer distinct committer emails**, returned the *local* base branch instead of `origin/<base>` — the assumption being that a solo repo's local `main` is as good as the remote one.

That assumption is wrong in dev3. dev3 fetches `origin` but never fast-forwards the main clone's local base branch, so local `main` drifts behind after the first merged PR and every diff/"N commits ahead" readout silently compares against stale history. A freshly cloned solo repo hits this immediately: comparison default resolves to `main`, not `origin/main` (reported for a project cloned over SSH).

## Investigation

The heuristic also mis-fires on committer identity: `parseRecentCommitters` dedupes by lowercased email, so `Arseniy Pavlenko <h0x91b@gmail.com>` + `h0x91B <h0x91b@gmail.com>` collapses to one committer even when the repo has real history. Reproduced on the reporter's repo — shortlog printed two author lines, one email, so the "solo" branch was taken.

## Decision

Removed the committer heuristic and `parseRecentCommitters` entirely. `detectDefaultCompareRef` now resolves in order: `origin/<base>` if it exists → `origin/main` / `origin/master` if an `origin` remote has them → the local base branch as last resort. The existing side effect that points the local base branch's upstream at `origin/<base>` (for `main`/`master`) is unchanged. Users who want local comparison still set `defaultCompareRef` / `defaultCompareRefMode: "local"` explicitly.

## Risks

- Repos with an `origin` that is never fetched (offline/archived remotes) now compare against a stale remote ref instead of a live local branch. Acceptable: dev3 fetches origin on its own poll cycle, and the explicit config escape hatch exists.
- Existing projects that already persisted the auto-detected `main` into `projects.json` or `.dev3/config.json` keep it — the change only affects unset projects, by design (an on-disk value is a user choice).

## Alternatives considered

- Keep the heuristic but fix the email dedupe (count commits, not identities): still leaves solo repos comparing against a branch dev3 never updates.
- Auto fast-forward the main clone's local base branch on fetch: touches the user's checkout behind their back; rejected.
- Default `defaultCompareRefMode: "remote"` in `DEFAULTS` and drop detection: loses the `origin/main` fallback for a repo whose configured base branch has no remote counterpart.
