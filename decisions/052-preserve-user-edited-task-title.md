# 052 — Preserve user-edited task titles across agent sessions

## Context

GitHub issue #564: a user renames a task via the UI, then the agent starts and
the title gets reverted to a freshly synthesized auto-title. The dev3 skill
instructs agents to "synthesize a concise title and update it via
`dev3 task update --title`" if the existing title is long or truncated. The
agent doesn't know the title was already deliberately set by the user.

## Investigation

- `customTitle` field already exists (`src/shared/types.ts`) and `getTaskTitle`
  prefers it over the auto-generated `title`. The UI rename flow
  (`InlineRename`, `TaskDetailModal`) correctly writes `customTitle`.
- The CLI path `dev3 task update --title` (`cli-socket-server.ts` `task.update`)
  already set `customTitle` rather than `title`, but unconditionally
  overwrote whatever was there.
- `dev3 current` output exposed only the resolved title, so the agent had no
  way to know the title was user-edited.
- Net effect: the agent was *technically* following its skill ("rename if too
  long") with no signal that the user had already chosen a title intentionally.

## Decision

Three-layer defense (`src/bun/cli-socket-server.ts`, `src/cli/commands/current.ts`,
`src/cli/commands/task.ts`, `src/bun/agent-skills.ts`):

1. **Surface the signal.** `dev3 current` and `dev3 task show` now render the
   title as `<title> (user-edited — do NOT rename)` whenever `customTitle` is
   non-empty.
2. **Tell the agent.** `SKILL_TITLE_GENERATION` in `agent-skills.ts` instructs
   agents to skip the rename step entirely when the marker is present.
3. **CLI backstop.** `task.update` RPC silently refuses to overwrite a
   non-empty `customTitle` when `--title` is passed; the new `--force` flag
   exists for diagnostics but the skill tells agents never to use it.
   `--title ""` still clears the custom title (explicit reset).

`task.update` response shape changes from `Task` to
`{ task: Task; titlePreserved: boolean }`. The CLI handler accepts both
shapes for forward/backward compatibility with stale binaries.

## Risks

- Response-shape change is internal (only consumer is the dev3 CLI shipped
  from the same build), but a stale `dev3` binary against a newer app would
  still work because the CLI handler accepts both shapes.
- Agents that legitimately want to rename via CLI now need to pass `--force`.
  This is intentional; agents should not rename in practice — the UI is the
  rename surface.

## Alternatives considered

- **Prefix-matching the description** (reporter's first suggestion) was rejected
  because `customTitle` is a stronger, explicit signal than guessing whether
  the current title looks "user-y".
- **Skill-only fix.** Insufficient because older / different agents may
  silently ignore the marker; the CLI guard makes the protection robust.
- **Server returns an error** instead of preserving silently. Rejected — that
  would force callers to handle a new error path; preservation with a stderr
  notice gets the right behavior on the happy path.
