# Task notes: capped preview in the inspector, full log in its own overlay

## Context

`TaskNotes` rendered every note of a task inline at the bottom of `taskDetailsBody`, which both the desktop inspector and the narrow actions `BottomSheet` share. On a note-heavy task the sheet measured 45 900 px of scroll, almost all of it notes.

## Investigation

Measured across `~/.dev3.0/data` (2 376 tasks, 985 with notes):

- **2 999 of 3 030 notes are agent-written** (`source: "ai"`); only 31 came from a human. Notes are a log, not a form.
- Median task: **1 note, 790 chars**. p90: 5 notes. p99: 22 notes / 38 509 chars. Worst: **143 notes / 313 321 chars**.
- Half the note-bearing tasks (492) hold at least one note over 600 chars; average agent note 929 chars, longest 22 032.
- Only the AI branch of `NoteItem` is unbounded — it renders a plain `whitespace-pre-wrap` div. User notes already sit in a fixed-height `textarea`, which is why they never produced a wall.

So the wall comes from the *tail* of an agent-written log, while the common case is one short note that is genuinely useful at a glance.

## Decision

Three changes, none of which moves notes off the object's surface:

1. `NoteItem` takes `clamp` — an agent body folds to `line-clamp-6` with a `Show more` / `Show less` toggle. Overflow is measured **while folded** (`scrollHeight > clientHeight`) and the verdict kept across the expand, so the toggle never appears on a note that already fits.
2. `TaskNotes` takes `variant` (`preview` | `full`) and `onShowAll`. The preview keeps the **newest 3** notes, shows the total count beside the title, and renders one `Show all N` row.
3. `TaskNotesOverlay` (new) holds the full log: `BottomSheet` on narrow — after closing the actions sheet, so sheets never stack — and a centered dialog on wide. `TaskInfoPanel` owns the open state.

`TaskDetailModal` (archived tasks) is already a dedicated surface, so it takes the clamp and keeps the full list.

## Risks

- The newest-3 cap hides older notes behind one click on tasks with 4+ notes (17% of note-bearing tasks). Mitigated by the count badge, which makes the hidden volume visible.
- Overflow detection depends on layout: a body measured before fonts settle could mis-report. In practice the effect re-runs on content change and the failure mode is a missing toggle on a marginal note, not lost content.

## Alternatives considered

- **Move notes wholesale behind a row + count badge** (the original proposal). Architecturally cleaner, but the median task holds exactly one note — >75% of tasks would pay a tap to fix the 5% tail.
- **Virtualize the list.** Solves rendering cost, not the scroll wall; the cap makes it unnecessary (a full log is ~143 clamped bodies).
- **Clamp only, no cap.** 143 notes × 6 lines is still ≈ 23 000 px.
