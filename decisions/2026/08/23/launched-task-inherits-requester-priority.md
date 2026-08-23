# Launched task inherits the requester's priority

## Context

An agent asking the user to set another task running (`dev3 task move --task seq:N --status in-progress`, or `dev3 task create --scratch --run`) produced a task on the default P3 band. A P0 investigation spawning three helpers therefore watched them sink below every P4 on the board — issue #1496.

## Decision

Two changes, both in the approval path:

1. **Inheritance.** `resolveLaunchPriority` (`src/bun/cli-socket-server.ts`) resolves the band the launch will use: the target's own `task.priority` when set, otherwise the requesting task's. `Task.priority` is `undefined` until someone sets it explicitly, which is exactly the "no priority was specified" signal — a scratch peer and a `task create` without `--priority` both qualify. The value travels to the dialog as `AgentLaunchRequest.defaultPriority`.
2. **Override.** The launch dialog's subject-card priority badge became a picker (`TaskDialogSubjectCard.onPriorityChange`, an opt-in the other dialogs do not pass). The pick rides in `AgentLaunchChoice.priority` and is mirrored to the pending request, so an auto-approval that fires with nobody watching still uses it. `launchTaskWithAgentChoice` applies it through `data.setTaskPriority` — priority is group-wide, so it cannot go in the single-task `taskPatch` — before dispatching the move, and re-reads the task so the lifecycle event carries fresh state.

The fallback lives on the bun side (`choice.priority ?? defaultPriority`), not in the dialog: an auto-approval with no client attached carries no launch choice at all.

`PriorityPicker` had to move too. It was a `z-50` portal using `useEscapeKey`, which inside a `z-[60]` dialog meant invisible *and* Escape-closes-the-whole-dialog — the exact failure `utils/overlay-layers.ts` documents. It now registers via `useOverlayLayer` at `z-[9999]`, matching `Select`.

## Risks

- Inheritance reads "explicit P3" and "never set" as the same thing, because `CreateTaskModal` deliberately omits `priority` when it equals the default. A user who consciously picked P3 on a To Do task will see it inherit P0 from a P0 requester. The dialog shows the band and lets them fix it, and no other stored state distinguishes the two cases.
- `PriorityPicker` no longer registers an Android back layer (`useOverlayLayer` does not, `useEscapeKey` did), so hardware Back with the picker open now closes the surrounding surface. This matches every other portalled panel in the app.

## Alternatives considered

- **Inherit unconditionally**, ignoring the target's own priority — rejected: it silently overwrites a band the user set by hand.
- **A separate labelled priority row in the dialog**, like `CreateTaskModal` — rejected: the subject card already shows a priority badge in the identity row, so this duplicates it and leaves two numbers on screen that can disagree.
- **A `--priority` flag on `dev3 task create --scratch --run`** — not done. It would let an agent request a band, but the issue asks for inheritance plus a user control, and every extra launch knob is one more thing an agent can get wrong.
