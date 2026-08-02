# 197 — Column agents own a pane by purpose, and their failures travel as a reason code

## Context

Moving a task to AI Review did nothing on a task marked `terminalBackend: "native"`,
which is every task created since the native rollout default flipped. Two independent
defects: `launchColumnAgent` still did a raw `tmux split-window` into `dev3-task-<id>`
(no such session on native — it died on the socket), and `machine.ts` handled the
resulting `columnAgentFailed` for `review-by-ai` by returning ONLY the fallback move to
Your Review, with no push. The card hopped back on its own and said nothing.

## Investigation

Reproduced on a native task through the card status menu. App log:
`launchColumnAgent START` → `tmux split-window failed {stderr: "can't find pane:
dev3-3b5f4867"}` → `Updating task {status: review-by-user}`, and zero `columnAgentFailed`
in the renderer. Custom-column agents did get the push; `review-by-ai` was the only
column that swallowed it, because its fallback was treated as sufficient.

## Decision

1. **The pane is owned by purpose, not by a remembered id.** `launchColumnAgent`
   (`src/bun/rpc-handlers/tmux-pty.ts`) now goes through `openAuxPane` with a new
   `AuxPanePurpose` value `columnAgent` (`src/bun/task-aux-panes.ts`), whose marker is
   the existing `col-agent.sh` temp path. The `col-agent-pane` id file is deleted: the
   purpose layer re-finds the pane by its launch command, so a repeated activation
   replaces the review agent instead of stacking a second one — and it still works
   after an app restart, which the id file did not. Plain `splitTaskPane` was rejected:
   it has no dedup, so it cannot express "exactly one review agent".
2. **A stopped task terminal is never resurrected.** An auxiliary-agent launch requires
   an already-live terminal; `openAuxPane` throws `AuxPaneUnavailableError` and the task
   is parked in Your Review with an actionable message. Auto-starting it would cut
   across the explicit hibernation/wake semantics of decision 184 and hand the user a
   runtime they never asked to start.
3. **The failure is reported as well as parked, and known failures are localized via a
   code.** `columnAgentFailed` gained `movedTo?: TaskStatus` and
   `reason?: ColumnAgentFailureReason` (`src/shared/types.ts`). `columnAgentFailureReason`
   in `src/bun/lifecycle/executor.ts` maps `AuxPaneUnavailableError` to
   `terminal-not-running`; `columnAgentFailureCopy`
   (`src/mainview/utils/columnAgentFailureToast.ts`) picks one of four localized keys
   from `reason` × `movedTo`. The renderer never reads the English `error` string —
   that is interpolated as diagnostics only, for failures the app cannot explain.

## Risks

- A future recognised failure means another `ColumnAgentFailureReason` value plus two
  keys × three locales. That is deliberate: the alternative is gluing localized
  fragments together, or matching on English.
- `auxPaneTitle("columnAgent")` is the generic "Column Agent" in the native pane picker,
  because the label is derived from the launch command and cannot know which column
  launched it. The pane's own title (OSC) is still the real column name.

## Alternatives considered

- **Keep the pane-id file and only branch on backend.** Rejected: it re-creates the
  per-backend split the seam exists to remove, and the file is still lost on restart.
- **Parse the error text in the renderer** to detect the terminal-not-running case.
  Rejected outright — backend wording would silently break the UI.
- **Let the fallback move stand alone** and rely on the user noticing the card moved.
  Rejected: that is the shipped bug.
