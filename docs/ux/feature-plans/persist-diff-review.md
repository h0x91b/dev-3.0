# Feature plan — Persist inline diff review + Reset review

Status: `Proposed` · Surface: `diff_review_viewer` (`TaskDiffViewer.tsx`) · Class: `configuration`-adjacent durability fix + one `destructive` action.

## Problem

Inline review comments live only in in-memory React state (`inlineComments` useState, `TaskDiffViewer.tsx` ~L1569) and are wiped on diff reload / unmount (~L1842-1873). "Saving" a review = copying XML to the clipboard (navigation guard `onSave`, ~L1656). The clipboard is volatile — an accidental terminal text-selection clobbers it and the entire review (often 10+ comments over a long diff) is lost with no recovery.

## Decision (from UX review + user)

1. **Persist** `inlineComments` to `localStorage`, keyed **per task** (`task.id`). Survives unmount, diff reload, and app restart.
2. Clear **only** via an explicit **`Reset review`** button (and, optionally, after a successful copy — to confirm with user during impl).
3. Clipboard is transport, not store.

## Placement & hierarchy

Inside the existing **Review-export card** in the left Files aside (`TaskDiffViewer.tsx` ~L2826-2915):

- **`Copy review`** stays the single `primary` (`bg-accent` solid, full-width, success-tint on copied). Unchanged.
- **`Reset review`** is **new**, placed **below** Copy:
  - Semantic role `destructive`, low-emphasis. Concrete: ghost-danger — `text-danger border border-danger/30 bg-transparent hover:bg-danger/10`, same `h-8` height, NOT full-width-solid (must not compete with Copy or read as a primary).
  - Visible **only** when `reviewExportEntries.length > 0`.
  - Click → `confirm({ title, message, danger: true })` (React confirm service, `src/mainview/confirm.tsx` — never a native dialog). On confirm: clear state + remove the localStorage key.
- **No separate "persisted draft" indicator.** The existing count badge (~L2848) already communicates "N saved comments" — adding a chip would be affordance-creep. Optionally tweak the body copy when entries exist; do not add a new element.

## Behavior changes beyond the button

- **Restore on load instead of wipe:** the payload-effect (~L1842-1873) currently does `setInlineComments({})` on every diff (re)load. Change to *restore* from localStorage for this `task.id` instead of unconditional wipe. Stale line numbers after a rebase are acceptable (user resets if needed) — matches the "persist until Reset" decision.
- **Drop the discard-on-close guard:** `requestClose` (~L1629) shows a "discard review?" confirm via `hasUnsavedReviewRef`. With persistence, leaving discards nothing, so this guard is now misleading — remove it (or repurpose `hasUnsavedReviewRef` away from "unsaved"). The convenience auto-copy-on-leave (`navigationGuardRef.onSave`, ~L1656) may stay.

## States

- 0 comments → Reset hidden; card shows empty/hint state (unchanged).
- ≥1 comment → Reset visible.
- After Reset confirmed → localStorage key removed, `inlineComments` `{}`, card returns to empty state.
- localStorage unavailable / quota → wrap read/write in try/catch (match existing `readStoredReadState`/`writeStoredReadState` pattern, ~L861-879); fall back to in-memory only.

## Accessibility / interaction

- Reset reachable by Tab; icon+label (not icon-only) so no tooltip dependency. `aria-label` on the button.
- Confirm dialog owns focus; Esc cancels.

## i18n (new keys, `infoPanel` domain, en/ru/es)

- `infoPanel.diffReviewReset` — button label (e.g. "Reset review").
- `infoPanel.diffReviewResetConfirmTitle`
- `infoPanel.diffReviewResetConfirmMessage`

## Likely files to change (implementation)

- `src/mainview/components/TaskDiffViewer.tsx` — LS persistence helpers (key `dev3-inline-diff-review-v1` per task), restore-on-load, Reset button + confirm, drop discard guard.
- `src/mainview/i18n/translations/{en,ru,es}/infoPanel.ts` — new keys.
- `src/mainview/components/__tests__/TaskDiffViewer*.test.tsx` — persistence round-trip, reset clears, restore-on-remount, 0-comment hides reset.
- `change-logs/2026/06/19/feature-persist-diff-review.md` — changelog (one file for the task).
- `src/mainview/tips.ts` + tip i18n — 1 "Did you know?" tip (user-facing feature).

## What NOT to implement

- No new top-level destination / nav item.
- No control added to the inspector or global header.
- No native dialog for the confirm.
- No solid-danger or accent fill on Reset.
- No separate draft-status indicator element.
- No server/RPC persistence — localStorage only (review is local, ephemeral-ish working state).
