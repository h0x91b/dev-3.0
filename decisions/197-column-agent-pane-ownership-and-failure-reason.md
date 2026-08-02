# 197 — Column agents own a pane by purpose, and their failures travel as a reason code

## Context

Moving a task to AI Review did nothing on a task marked `terminalBackend: "native"` — every task created since the native rollout default flipped. `launchColumnAgent` still opened the review agent with a raw `tmux split-window` into `dev3-task-<id>`, which a native task does not have. Worse, `machine.ts` answered the resulting `columnAgentFailed` for `review-by-ai` with only the fallback move to Your Review, so the card hopped back and said nothing.

## Investigation

Reproduced on a native task through the card's status menu: `launchColumnAgent START` → `tmux split-window failed {stderr: "can't find pane: dev3-…"}` → `Updating task {status: review-by-user}`, with no `columnAgentFailed` reaching the renderer. Custom-column agents did get that push; `review-by-ai` was the one column that swallowed it.

## Decision

The pane is owned by purpose, not by a remembered id: `launchColumnAgent` (`src/bun/rpc-handlers/tmux-pty.ts`) goes through `openAuxPane` under a new `AuxPanePurpose` value `columnAgent` (`src/bun/task-aux-panes.ts`), and the `col-agent-pane` id file is gone. That purpose is marked `provenReplace`, so `replaceAuxPanes` closes **every** pane it owns and re-reads the pane set to prove they are gone — a launch that cannot prove it refuses rather than risk two agents in one worktree. Proof includes the LOOKUP, not just the close: both backends have production paths that turn an undecidable read into an empty list (`readPaneSet` catches every recovery exception, a `null` pane set becomes `[]`, an unreadable per-pane record becomes `command: []`, a tmux error becomes no rows), so the replacement path reads through `readPaneSetStrict` / `nativeTaskPaneCommandsStrict` and refuses via `AuxPaneUndecidableError` unless the empty list was actually observed. A stopped task terminal is never resurrected (that would cut across decision 184's explicit wake); the task is parked in Your Review with an actionable message instead.

The failure is reported as well as parked. `columnAgentFailed` carries `column: ColumnAgentIdentity`, `movedTo?: TaskStatus` and `reason?: ColumnAgentFailureReason` (`src/shared/types.ts`); `columnAgentFailureCopy` (`src/mainview/utils/columnAgentFailureToast.ts`) picks one of four localized keys from `reason` × `movedTo` and localizes a built-in column's name from its status. The report rides on the fallback move and is emitted *after* that move's column write, because a rejected or failed write stops the effect run — a toast claiming a move that never landed is worse than silence. The renderer never reads the English `error` string; that stays diagnostics for failures the app cannot explain.

## Risks

Each new recognised failure costs another reason value plus two keys × three locales — deliberate, because the alternatives are gluing localized fragments or matching on English. The strict read costs an extra ownership sweep on each replacement, and it refuses in cases the tolerant read would have sailed through — that is the point, but it does mean a flaky pane set now blocks AI Review instead of silently double-launching. `auxPaneTitle("columnAgent")` is the generic "Column Agent" in the native pane picker, since the label is derived from the launch command and cannot know which column launched it; the pane's own OSC title is still the real column name.

## Alternatives considered

Keeping the pane-id file and branching on backend was rejected: it re-creates the split the seam removes, and the file is lost on restart. Parsing the error text in the renderer was rejected outright — backend wording would silently break the UI. Bare `splitTaskPane` cannot express "exactly one", and best-effort closing cannot either. Letting the fallback move stand alone is the shipped bug.
