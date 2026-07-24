# 166 — The sharded test gate must not swallow suite failures (pipefail)

## Context

`build.yml` runs the test suites in a 5-way `test_shards` matrix where the job and
each suite step carry `continue-on-error: true`; the real gate is the aggregate
`test` job, which reads each shard's recorded `outcome` from an artifact. To make
a failure readable without opening individual shard jobs, the suite steps were
changed to `bunx vitest ... 2>&1 | tee <log>` so the aggregate could reprint the
failing test names.

## Investigation

That pipe silently disarmed the gate. GitHub's default shell for `run:` is
`bash -e {0}` — **without** `pipefail` (the logs show it verbatim:
`shell: /usr/bin/bash -e {0}`). Only an explicit `shell: bash` gets
`bash --noprofile --norc -eo pipefail {0}`. So the pipeline's exit status was
`tee`'s, always 0, and `steps.<id>.outcome` recorded `success` for a suite that
had actually failed.

Concretely on PR #1111: the first run correctly reported `shard 4/5: cli=failure`
(a real `tmux-audit` failure). After the tee change, the next run reported all
five shards green — while shard 4's log still contained
`FAIL tmux-audit/__tests__/tmux-audit.test.ts` — and the PR auto-merged with a
failing test. It took a revert (#1113) to get `main` clean.

## Decision

Every piping step in the shard matrix declares `shell: bash` so `pipefail`
propagates vitest's exit code into `outcome` (see `build.yml`, steps
`Run mainview tests` / `Run bun tests` / `Run CLI tests`). A regression guard,
`src/bun/__tests__/workflow-pipefail.test.ts`, fails if any workflow step pipes
into `tee` without an explicit `shell: bash`. The guard was verified by removing
`shell: bash` from one step and watching it name that step.

## Risks

- The guard only recognises `| tee`; a different pipe construct in a gating step
  would need the same treatment and is not detected.
- `pipefail` makes previously-green steps fail when any command in a pipeline
  fails, which is the intended behaviour but can surface latent breakage.

## Alternatives considered

- **`set -o pipefail` inside each `run:` block** — equivalent, but easy to forget
  in a new step and invisible in the step's metadata.
- **Write to a file and `cat` it afterwards instead of `tee`** — keeps the exit
  code, but loses the live streamed output that makes a long shard watchable.
- **Drop `continue-on-error` and gate on the shard jobs directly** — a bigger
  change to the sharding design (decision 162), and the aggregate job exists so a
  single required check covers all shards.
