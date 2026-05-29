# UX Glossary — dev-3.0

Shared UX vocabulary, specialized for this project. Generic terms first, then dev-3.0-specific ones.

## Destination

A stable place users navigate to. In dev-3.0 a destination is a **screen** in the `Route` union (`dashboard`, `project`, `task`, `settings`, …), not a URL.

## Action

A command that changes state or performs work. Classified here as: primary, object, git, dev-server, lifecycle, configuration, destructive, expert-shortcut.

## Surface

A UI container that owns a class of interaction: global header, application menu (native), Kanban board, task card, task info panel (inspector), modal, popover, context menu, settings, sidebar, toast.

## Primary action

The one main safe action for the current screen/flow. Styled `bg-accent`. Max one visible per screen.

## Destructive action

Delete, remove, cancel, reset, hard refresh. Styled with `text-danger`/`bg-danger`, requires confirmation, never uses primary styling.

## Configuration

A durable change to project/app behavior (scripts, columns, labels, theme, locale, gh account). Lives in Global or Project Settings.

## Complexity budget

A project-specific cap on visible controls per surface (e.g. ≤2 inline actions on a task card, ≤4 visible toolbar actions). Exists because of dev-3.0's documented toolbar-button-creep history.

## Inspector

The `TaskInfoPanel` — the contextual control surface for the active task (git, dev server, scripts, notes, tmux, open-in). The densest surface in the app.

## Variant / Attempt

Multiple parallel agent runs of the same task (spawn variants / add attempts). Each gets its own worktree + terminal; shown via variant dots on the card.

## Custom column

A user-defined Kanban column with a name, color, optional LLM instruction (when the agent should move tasks here), and optional auto-spawn agent config.

## Token

A semantic CSS custom property (`bg-accent`, `text-fg`, `border-edge`, `--success`…) mapped to Tailwind. Components must use tokens, never raw hex — except `STATUS_COLORS`.

## Status color

Per-status hex (`STATUS_COLORS` / `STATUS_COLORS_LIGHT`) used inline for column headers, card borders, and dots. The one documented exception to the no-hardcoded-color rule.
