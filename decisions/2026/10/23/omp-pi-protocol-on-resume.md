# omp and pi get the dev3 protocol on resume too

## Context

The omp and pi adapters skipped `--append-system-prompt` on resume (`-c`, `--resume <id>`, `--session-id <id>`), and their tests asserted it, as if the session kept the prompt. Hibernate → `dev3 task wake --resume` made that path routine.

## Investigation

On omp (2026-10-23): `omp -p --append-system-prompt "<rule>" "<question>"` answered from the rule; `omp -p -c "<question>"` without the flag answered UNKNOWN; `-c` with the flag re-appended answered from the rule again. omp's session files hold the dev3 protocol only as tool output, never as a stored system prompt. pi was not installed to test; omp is a fork of pi, so the same session model is assumed.

## Decision

`src/shared/agent-adapters/omp.ts` and `pi.ts` append the protocol file on every launch, resume included — the same as Claude (`claude.ts`) and Codex (`developer_instructions`). Only the task prompt stays fresh-only.

## Risks

If pi did keep the appended prompt, a resume would carry it twice; that costs context, while the old behaviour lost the protocol outright.

## Alternatives considered

- **Keep skipping on resume.** Rejected: a resumed agent with no protocol ignores the lifecycle rules (status, approvals, overview) entirely.
