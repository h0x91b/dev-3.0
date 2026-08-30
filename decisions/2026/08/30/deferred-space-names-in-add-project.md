# Deferred space names in the Add Project dialog

## Context

`SpacePicker` always rendered the empty state "No spaces yet — type a name to create one", but `ProjectSpacesField` passed `onCreateNew` only in connected mode. In the Add Project dialog (deferred mode) the create row therefore never appeared and Enter did nothing, so the copy promised something the dialog could not do.

## Investigation

The gap is not accidental: `createSpace` in `src/bun/spaces-data.ts` rejects an empty member list ("A space is never empty"), and `setProjectSpaces` soft-deletes a space whose last member leaves. Creating the space eagerly from the dialog would need either an empty space (breaking the invariant) or a stray space left behind whenever the user cancels the dialog.

## Decision

The deferred value became `DeferredSpaces = { spaceIds, newNames }` (`src/mainview/components/ProjectSpacesField.tsx`). A typed name is held as `newNames` and shown as a chip and as an already-ticked picker row; `applyDeferredSpaces(projectId, value)` creates each name with the new project as its first member and then writes the whole membership set once. `SpacePicker.onCreateNew` is now required, so no host can show the promise without honouring it.

## Risks

A name typed in the dialog is not reserved: another window can create the same name first, and the dialog then creates a second space with that name. Space names are not unique anywhere in the app, so this is a duplicate row, not a failure. If the clone succeeds and space creation fails, the project still exists and only a toast reports the miss — same as before.

## Alternatives considered

Allow `createSpace` with no members and let the dialog clean up on cancel — rejected: it weakens a backend invariant to serve one form, and a crashed or force-closed dialog leaks an empty space. Rewording the empty state to hide creation in deferred mode — rejected: the user explicitly wanted to create a space right there.
