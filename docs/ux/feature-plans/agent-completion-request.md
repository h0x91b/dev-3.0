# Feature plan — Agent-initiated task completion request

## Feature classification

- **User job:** decide whether an agent that claims to be done may complete its task (destroying worktree + tmux session).
- **Owning object:** Task. **Workflow:** task lifecycle (status transitions).
- **Feature class:** destructive action with mandatory human approval, AI-initiated.
- **Scope:** single task. **Frequency:** occasional (end of each agent task). **Risk:** destructive (session + worktree loss).

## Placement

- **Trigger:** CLI only — `dev3 task move --status completed`. No new UI entry point; the user-side trigger remains the existing drag-to-Completed / UI flows.
- **Surface:** the existing imperative `confirm()` Modal (`src/mainview/confirm.tsx`), same surface as the branch-merged prompt. No new surface, no nav change, no toolbar buttons — zero impact on complexity budgets.
- **Rejected placements:** persistent board badge / inbox (user explicitly chose ephemeral live dialog); toast (not blocking, too easy to miss for a destructive decision); native dialog (banned — remote/browser mode).

## Action hierarchy & tokens

- **Approve ("Complete task"):** semantic role `destructive`, concrete variant — the dialog's `danger` confirm button (`bg-danger`). Never primary-styled.
- **Cancel ("Keep session"):** semantic role `secondary`; receives `autoFocus` so Enter defaults to the safe choice.
- **AI identity treatment:** `agentInitiated` option renders an accent badge pill (robot glyph `\u{F06A9}` + "AI agent request") and `border-accent/40` dialog border — visually distinct from user-initiated confirms.
- Backdrop click / Esc = cancel. Triple protection against accidental approval: danger styling, cancel autofocus, explicit badge.

## Interaction

- Agent runs the CLI → blocking socket request (10-min client timeout) → push `agentCompletionRequested` → dialog. Approve → task moves to completed (normal `moveTask` path, `taskUpdated` push updates the board, navigation leaves the doomed task screen). Decline → CLI exit code 6 with guidance text for the agent.
- Duplicate requests for the same task join the pending decision — only one dialog ever shows.
- States: app window absent → CLI gets an immediate error; task already completed/cancelled → error; CLI timeout → dialog may remain, late approval still completes.

## i18n

Keys `app.agentCompletion*` + `confirmDialog.agentBadge` in en/ru/es `common.ts`.
