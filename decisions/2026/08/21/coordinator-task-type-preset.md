# Coordinator is a description preset, not a persisted task kind

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

## Decision

`COORDINATOR_PROMPT` in `src/shared/types.ts`, resolved through
`resolvePresetPrompt` against `Project.coordinatorPrompt` and
`GlobalSettings.coordinatorPrompt`. Nothing about the choice is persisted on the
task: the created task is an ordinary task holding the text it was given.

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

- The preamble is long, so it dominates the textarea. Mitigated by moving the
  caret to the end and scrolling the textarea down on injection, so typing lands
  in the user's own text rather than inside the prompt.
- A user who hand-edits the injected preamble and then switches type keeps their
  edited text: the strip step requires an exact prefix match. Deliberate — losing
  hand-written text would be worse than leaving it.
- Removing the PR-review toggle changes a shipped surface. Its behaviour is
  preserved, including the branch-box PR-URL paste, which now reports through
  `onPrResolved` instead of driving review mode directly.

## Alternatives considered

- **Persisted `Task.coordinator` flag** (like `draft` / `hibernated` /
  `foreignCode`), for a board badge and filtering. Rejected for now: the task
  card's inline-action budget is full at 4/4, and a flag with no behaviour behind
  it is decoration. Nothing here blocks adding it later.
- **A full task kind** with no worktree and tool restrictions. Rejected: the
  no-worktree half fights the lifecycle machine, and refusing tools is the
  agent's choice, not something dev3 can enforce.
- **Coordinator in the branch block, next to the PR-review toggle.** Rejected:
  unreachable on virtual projects, which is where a coordinator belongs most.
