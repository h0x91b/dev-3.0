# 124 — Scheduled agent message ("Send later")

## Context

Glossary — **Scheduled message**: a one-shot piece of text the user (or the agent
via CLI) queues to be delivered into a task's **live agent** at a later moment
("send at 14:00" / "send in 30 min"). It is the messaging counterpart to a
**deferred launch** (`scheduledLaunch`, "Start in…"), which defers *spawning* a
task — a scheduled message instead pokes an **already-running** agent. Users
wanted to feed a follow-up, remind, or say "continue when CI is green" without
babysitting the terminal. The two primitives already exist: delivery into a live
agent pane (`sendPromptToAgentPane` in `src/bun/rpc-handlers/git-operations.ts`,
used by the Create-PR / rebase-conflict handoffs) and the one-shot timer pattern
(`src/bun/scheduled-launch-scheduler.ts`).

## Decision

Persist a `scheduledMessages: ScheduledMessage[]` **queue** on the `Task`
(mirrors `scheduledLaunch`; explicitly NOT designed to survive a tmux-server or
host restart). Each item is `{ id, text, at, target }`. `target` is either
`{ kind: "agent" }` (default — resolved dynamically at fire time via
`resolveAgentPromptTargetPane`, because the agent pane is recreated with fresh
ids) or `{ kind: "pane", paneId }` (a concrete live pane picked from a list;
raw, ephemeral id). A new `src/bun/scheduled-message-scheduler.ts` (30 s tick,
structural copy of the launch scheduler) fires due items by typing the text and
then Enter (auto-submit) into the resolved pane.

Entry points: (1) a `ScheduleMessageModal` opened from the active task (card
menu / info panel), built on a shared `SchedulePicker` extracted from
`LaunchVariantsModal` (in/at modes, range ≤ 99 h / today–tomorrow); (2) a clock
button in `TerminalComposer` (browser/touch) that opens the same modal seeded
with the composer text; (3) CLI `dev3 message [--in <dur>|--at <hh:mm>] "text"`
— bare form sends immediately, `--in`/`--at` schedules, task auto-detected from
cwd. The action is offered only when the task has a **live agent session**.
Pending items support **cancel** and **send-now** (no inline edit — cancel and
recreate).

Fire-time semantics:
- **Agent busy** (mid-generation, not at a prompt) → send anyway, best-effort;
  the agent queues the input. Identical to the existing PR/rebase handoff.
- **Target unresolvable** (agent exited / pane dead / task in a terminal status /
  tmux dead) → mark undelivered, **notify + drop**, never retry.
- **App offline at due time** but the session survived the restart → fire late
  and notify it slipped; if tmux itself died there is nothing to deliver to, so
  this collapses into the notify + drop path.
- **Successful fire while the app is open** is silent (the user sees it land in
  the terminal); only late-fire and drop raise a toast/attention.

## Risks

`send-keys` into a busy or prompt-waiting agent can land text in an unexpected
input state (a y/n confirmation, a menu) — accepted, because the existing
Create-PR / rebase handoff buttons already carry exactly this risk. A stored
`paneId` is valid only within one tmux-server lifetime; by decision we do not
attempt restart survival, so a stale id simply takes the notify + drop path.
Agent-authored `dev3 message --in` lets an agent schedule a poke to itself —
intended ("wake me later"), so no loop guard.

## Alternatives considered

- **Extend Automations to target an existing task's agent** — Automations
  *create new tasks* on an rrule; retargeting them to inject into a live agent
  conflates recurring task-creation with one-shot messaging and is a much larger
  refactor. Rejected.
- **Symbolic-role target only** (`agent` / `active-pane` / `dev-server`, resolved
  at fire) — more robust across restarts, but the user explicitly dropped the
  restart-survival requirement, so a concrete `paneId` is simpler and sufficient
  (agent still stays a dynamic role).
- **Single scheduled message that overwrites** (like `scheduledLaunch`) —
  rejected; a queue is natural for messages ("in 5m X, in 30m Y").
- **Wait-until-idle before delivering** — idle detection is unreliable and delays
  delivery; best-effort send chosen instead.
