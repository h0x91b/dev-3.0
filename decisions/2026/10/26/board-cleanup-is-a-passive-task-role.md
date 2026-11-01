# Board cleanup is a passive task role

## Context

Long-lived boards accumulate finished, duplicated, parked and uncertain work. A coordinator's delegation brief is unsuitable for an audit because reading a board must not wake or redirect its agents.

## Decision

Add `board-cleanup` to the existing task-type picker, CLI and role-preamble machinery (`src/shared/types/task-type.ts`, `BOARD_CLEANUP_PROMPT` in `prompts.ts`). It receives a card label and a red dashed card border (the coordinator's green one, in danger colour), ordinary priority sorting and unconditional manual completion. The default scope is the owning project; an explicit request in the user's brief enables an all-project audit, including a central task on Operations. No new destination, board control or persisted scope format is needed; the existing prompt-preset placement rule applies.

The brief requires evidence, preservation checks, a durable report and exact user-selected targets before requesting any destructive approval. It stays compact because it travels in the task description on Windows; launch-budget tests cover Codex, Cursor and OpenCode with 2,500 additional user characters. `dev3 tasks list --open --json` supplies a read-only, paged inventory that includes drafts, hibernated and custom-column tasks. Draft edits persist the type alongside the description.

## Risks

Role instructions guide an agent; they do not restrict its available tools. Approval dialogs can auto-approve, so opening a dialog is not an acceptable substitute for explicit chat authorization. Stale runtime hints, missing PR evidence and unique work must produce an INVESTIGATE recommendation, not closure. Existing data files keep their paths and receive only the already-supported optional task-type value.

## Alternatives considered

Reusing Coordinator would inherit delegation, prominent sorting and unrelated management instructions. A global cleanup destination or toolbar button would spend navigation and density budgets on an occasional workflow. A separate scope property and control would duplicate the editable task brief; explicit all-project wording provides the central workflow without another setting. Automatic closure by task age would discard work without evidence.
