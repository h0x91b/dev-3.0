# 197 — Column agents own a pane by purpose, and their failures travel as a reason code

## Context

Moving a task to AI Review did nothing on a task marked `terminalBackend: "native"` — every task created since the native rollout default flipped. `launchColumnAgent` still opened the review agent with a raw `tmux split-window` into `dev3-task-<id>`, which a native task does not have. Worse, `machine.ts` answered the resulting `columnAgentFailed` for `review-by-ai` with only the fallback move to Your Review, so the card hopped back and said nothing.

## Investigation

Reproduced on a native task through the card's status menu: `launchColumnAgent START` → `tmux split-window failed {stderr: "can't find pane: dev3-…"}` → `Updating task {status: review-by-user}`, with no `columnAgentFailed` reaching the renderer. Custom-column agents did get that push; `review-by-ai` was the one column that swallowed it.

## Decision

The pane is owned by purpose, not by a remembered id: `launchColumnAgent` goes through `openAuxPane` under a new `AuxPanePurpose` value `columnAgent` whose marker is the existing `col-agent.sh` temp path, the `col-agent-pane` id file is gone, and `replaceAuxPanes` closes every pane the purpose owns and re-reads the set to prove they went — a launch that cannot prove it refuses rather than risk two agents in one worktree.
Proof covers the LOOKUP too, because several production paths turn an undecidable read into an empty list (`readPaneSet` catches every recovery exception, a `null` pane set becomes `[]`, an unreadable pane record becomes `command: []`, a tmux error becomes no rows), so the replacement path reads through `readPaneSetStrict` / `nativeTaskPaneCommandsStrict` and, at the root, through `recoverPaneSet(..., { strict: true })`, which throws `PaneOwnershipUnknownError` before reconciling an unknown-owner pane away.
The line is drawn at whether there was anything trustworthy to read: no record and no coordinator file mean the pane really is gone and it is swept exactly as before, while a record that is present and cannot be believed — corrupt, foreign-schema, or claiming another pane's or coordinator's identity (`isBoundTo`, and the `record.sessionId`/`paneId` check in `probePane`) — marks the pane ownership-unknown, and `recoverPaneSet` keeps such a pane in the record and in the returned tree even on the tolerant path, so neither renderer polling nor a cached layout can erase the evidence before a strict launch reads it.
A stopped task terminal is never resurrected (that would cut across decision 184's explicit wake); the task is parked in Your Review and the failure is reported, with `columnAgentFailed` carrying `column: ColumnAgentIdentity`, `movedTo?` and `reason?`, `columnAgentFailureCopy` exhaustively picking one of four localized keys, and the push emitted only after the fallback move's column write lands — so the toast can never claim a move that did not happen and the renderer never reads the English `error` string.

## Risks

Each new recognised failure costs another reason value plus two keys × three locales — deliberate, because the alternatives are gluing localized fragments or matching on English. The strict read costs an extra ownership sweep on each replacement, and it refuses in cases the tolerant read would have sailed through — that is the point, but it does mean a flaky pane set now blocks AI Review instead of silently double-launching. `create` is strict too, so a coordinator record that is present and unbelievable now blocks STARTING a terminal for that task rather than being silently overwritten — the sharpest edge of this change, accepted because overwriting it orphans whatever live processes it described, with nothing left pointing at them. `auxPaneTitle("columnAgent")` is the generic "Column Agent" in the native pane picker, since the label is derived from the launch command and cannot know which column launched it; the pane's own OSC title is still the real column name.

## Alternatives considered

Keeping the pane-id file and branching on backend was rejected: it re-creates the split the seam removes, and the file is lost on restart. Parsing the error text in the renderer was rejected outright — backend wording would silently break the UI. Bare `splitTaskPane` cannot express "exactly one", and best-effort closing cannot either. Letting the fallback move stand alone is the shipped bug.
