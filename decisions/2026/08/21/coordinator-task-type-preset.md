# Coordinator is a persisted task type on top of a description preset

## Context

Coordinator tasks have been run by hand for weeks: a long-lived task whose agent
manages other tasks and never writes code (the prototype is the task that
carries the `Координатор доски dev3` title, seq 1141). Every rule it follows was
written into its notes after something went wrong. The ask was to make that a
first-class choice at task creation, "the way PR review already is".

## Investigation

"The way PR review already is" turned out to name a mechanism that is easy to
mistake. `builtinColumnAgents` is the AI Review *column* agent and is unrelated.
The create-flow feature is the `This is a PR review` toggle, which resolves a
prompt (project override → global setting → built-in) and injects it as a
preamble into the description, separated by `---` from whatever the user typed.

That mechanism answers three questions for free, which is why it was copied
rather than replaced:

- Per-task editable: the preamble is plain text in the description textarea.
- Versioned: the text is frozen into the description at creation, so editing the
  template never changes the behaviour of a coordinator that is already running.
- Delivery is provable: a task's description *is* its agent's first prompt, so
  there is no separate channel that can silently fail to load.

A skill-based variant was rejected on exactly that last point. Skills load
lazily, so an agent can finish a session having never read one — the silent
success class the prototype's own notes rank as a product-level red flag.

Also measured, since a different model default was an open question: the
prototype runs on `builtin-claude` / `claude-auto-opus5-medium`, which is the app
default (`src/bun/settings.ts`). No preset-specific agent or model is implied.

The choice not to persist anything did not survive contact with the user: after
seeing the picker he asked for a stored type, so the board can mark a coordinator,
sort it first, and keep it out of the auto-completion path. That is the shape
below.

## Decision

Two layers, and they are deliberately separate.

**The prompt.** `COORDINATOR_PROMPT` in `src/shared/types.ts`, resolved through
`resolvePresetPrompt` against `Project.coordinatorPrompt` and
`GlobalSettings.coordinatorPrompt`, injected into the description above the
user's own text (`withPresetPrompt` / `withoutPresetPrompt`, same file).

**The type.** `Task.taskType`, whose only value is `"coordinator"`. It gates
exactly three things:

- `taskSortRank` lifts a live coordinator by `COORDINATOR_SORT_OFFSET` (−10), so
  it sits above every live priority band on every surface that sorts through the
  one shared comparator. The lift is skipped while the task is hibernated or its
  session is dead — a lift would advertise an agent that is not there.
- `taskCompletesManually(task)` is true for any coordinator, so merge detection
  never offers to close it. **Derived, never stored twice**: the lifecycle facts
  (`lifecycle/state.ts`) and both merge-watch paths (`lifecycle/activities.ts`)
  ask the helper, so no writer — CLI, hook, or UI — can leave a coordinator
  auto-completing. The completion-owner control in `TaskInfoPanel` shows it on
  and refuses the click rather than offering a toggle the lifecycle would ignore.
- The card and the sidebar row carry a dashed `--success` border **and** a
  `Coordinator` chip. Both, because colour alone is not an accessible signal, and
  because the dashed border loses to the selection ring when a task is open in a
  split.

`pr-review` is the second stored type, added on the user's request once the first
one existed. The two are deliberately not equally loud: a coordinator gets the
border, the chip and the sort lift; a PR review is only named on the card, with no
border and no rank change, because it is an ordinary task with a job rather than a
task that outranks the board. Nothing keys behaviour off it — it exists so the
board can say what a task is, and so `--type` can move a task between the two.

Adding it forced one merge: the built-in review preamble used to be a translated
string (`createTask.reviewPrompt`), which the bun side cannot read. It is now
`DEFAULT_PR_REVIEW_PROMPT`, an English constant beside `COORDINATOR_PROMPT`, and
the three locale copies are gone. Same reasoning as the coordinator prompt — an
agent reads it, and one copy has to serve both the create flow and the CLI — plus
the new one that two paths resolving "the built-in review prompt" differently
would be a silent divergence. Users who want it in their language override it in
Settings.

**Conversion, and why it is not just a field write.** `dev3 task update --type
coordinator|standard` (CLI socket `task.update`) does three things in one step:
writes the field, rewrites the description's role preamble (strip-then-build, so
a repeat cannot stack two copies), and delivers the role change to the running
agent through `deliverAgentPrompt`. The field alone would produce a task the data
calls a coordinator while its agent was never told — a badge every human and peer
agent reads and the agent behind it does not honour. The CLI reports which of the
four outcomes happened (`delivered`, `unconfirmed`, `not-delivered`,
`no-session`) on stderr, because a role change nobody could deliver must not read
like a success.

Promotion is the user's call: the shipped agent skill puts it in the same
protected class as priority — an agent must never promote or demote a task on its
own initiative, least of all itself.

**Freezing and rewriting are not in conflict.** The preamble is frozen into the
description at creation so that editing the *template* (Settings, or the project
override) never changes a coordinator that is already running. Conversion
rewrites that description because it is an explicit act on one named task, asked
for by the user. A template edit still reaches nobody retroactively. Read as one
rule: only an explicit act on a task may change that task's text.

**The strip is written to lose nothing.** `withoutPresetPrompt` runs over a
description a human has been editing for hours, and the failure it must not have
is eating their words — a badge that lies is recoverable, deleted text is not.
Verified case by case against the real function rather than reasoned about:

| Description the user left behind | Result |
|---|---|
| Their own `---` rule inside their text | Boundary matched at exactly `prompt.length`, so their rule survives |
| Preamble hand-edited, no longer matching | Nothing removed; the stale copy stays and the fresh preamble goes above it |
| Plain task, no preamble and no rule | Nothing removed |
| Separator deleted, typing continued | Everything after the preamble is returned |
| Description is exactly the preamble | Empty, because nothing followed it |

The fourth row was a real defect found by this review: the function returned an
empty string whenever the separator was absent, so a user who deleted the `---`
line and kept writing lost every word of it. Reachable by hand in one gesture —
delete the rule, keep typing — and invisible to the suite that existed, because
that suite only exercised text the builder itself had produced.

**Do not make the strip greedier.** The stale duplicate the second row leaves
behind looks like a bug and is not: a duplicated paragraph is recoverable in one
edit, a deleted one is not recoverable at all. Every way of removing that
duplicate — matching the last `---`, searching for the separator anywhere,
fuzzy-matching an edited preamble — reintroduces the fourth row on someone's real
description. The five rows above are pinned by tests in
`src/mainview/__tests__/types.test.ts`; a change here must keep all five.

Placement: a `Task type` radiogroup (`TaskTypePicker` in `CreateTaskModal.tsx`)
directly under the description. The PR-review toggle was removed from
`BranchSelector` and folded into it — two controls doing the same thing (writing
a preamble into one field) in two places is the scattered-control anti-pattern,
and the toggle sat far from the field it silently rewrote. The three types are
mutually exclusive, so a radiogroup with a visible `Standard` beats two
independent switches whose "off, off" state meant something unstated. PR review
is disabled until a branch exists and absent entirely on virtual projects, where
no branch can ever exist — while a coordinator needs no branch at all, which is
the decisive reason it could not live in the branch block.

The prompt is a plain English constant, deliberately not an i18n string. An
agent reads it, every rule in it was written in English after a real failure, and
a translation that softens one clause changes behaviour. Users who want it in
their own language override it in Settings. This diverges from the PR-review
prompt, which is localized; that one is twelve generic lines, not a behavioural
contract.

## Risks

- **A coordinator outranks a P0.** Asked for explicitly, and worth writing down
  rather than rediscovering during an incident: a live coordinator sits above a
  P0 fire in the active-tasks view. Several coordinators stay ordered among
  themselves by their own priority, then by the activity clock, then `seq` — the
  ordinary in-band rules, unchanged.
- **`taskType` is a new key in `tasks.json`, which every installed version on
  the machine reads.** Checked rather than assumed: `rawLoadTasks` parses with
  `JSON.parse(...) as Task[]` and mutates the parsed objects in place, never
  enumerating fields, and `rawSaveTasks` writes those same objects back. So an
  unknown key survives a rewrite — an older build that opens the board does not
  demote coordinators. This holds for every version sharing that loader shape,
  which is all that can be verified from here.
- **Conversion cannot reach an agent that is not live.** A task with no worktree
  gets `no-session`; it reads the rewritten description when it starts, which is
  why the description is rewritten and not only the session told.

- The preamble is long, so it dominates the textarea. Mitigated by moving the
  caret to the end and scrolling the textarea down on injection, so typing lands
  in the user's own text rather than inside the prompt.
- A user who hand-edits the injected preamble and then switches type keeps their
  edited text: the strip step requires an exact prefix match, so the promoted
  description carries a fresh preamble above their edited copy. Deliberate and
  chosen in that direction — a duplicated paragraph is visible and deletable,
  hand-written text is not recoverable.
- Removing the PR-review toggle changes a shipped surface. Its behaviour is
  preserved, including the branch-box PR-URL paste, which now reports through
  `onPrResolved` instead of driving review mode directly.

## Alternatives considered

- **A boolean `Task.coordinator`** (like `draft` / `hibernated` / `foreignCode`)
  instead of a typed field. Rejected: the create-flow already offers three
  mutually exclusive kinds, and a boolean per kind is how "off, off" ends up
  meaning something unstated. A named type also reads correctly in `dev3 task
  show` and in `--type`.
- **Refusing conversion while the agent is running**, leaving the promotion to
  task creation only. Rejected: it makes the honest case (a task that turned out
  to need coordinating) impossible, and telling the live agent is cheap and
  already built.
- **Forcing `manualCompletion: true` at conversion instead of deriving it.**
  Rejected: a second source of truth that any later writer can flip back, for a
  guarantee that must not be flippable.
- **A full task kind** with no worktree and tool restrictions. Rejected: the
  no-worktree half fights the lifecycle machine, and refusing tools is the
  agent's choice, not something dev3 can enforce.
- **Coordinator in the branch block, next to the PR-review toggle.** Rejected:
  unreachable on virtual projects, which is where a coordinator belongs most.
