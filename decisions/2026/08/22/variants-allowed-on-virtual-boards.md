# Variants are allowed on virtual (Operations) boards

## Context

`LaunchVariantsModal` hid the `+ Add variant` button whenever `project.kind === "virtual"`.
The guard landed with the virtual Operations board itself (`f0e0290b0`, PR #725) and its
comment gave two reasons: there is no git diff to compare parallel attempts against, and
"a shared fixed folder would have multiple agents clobbering each other". A user hit the
empty footer slot and read it as a regression.

## Investigation

The clobbering claim is over-broad, and the disproof was already on disk. The Operations
board held a live variant group (`groupId 87537dfb`) whose two tasks each had their own
existing work dir — `ops/operations/2fae9007/work` and `ops/operations/0f5c3bd4/work`.
`git.virtualWorkDir` (`src/bun/git.ts:850`) keys the folder on `shortId(task.id)`, and a
variant is its own task, so the managed case structurally cannot collide.

The one regime that can is an explicitly chosen folder: `task-lifecycle.ts:476-479`
deliberately copies `sourceTask.opsWorkDir` onto every variant, so a user-picked folder is
shared by construction. That collision is structural but **unobserved** — no one has run
two variants against one picked folder and watched them interfere.

The second reason (no git diff) never justified hiding the control either: variants are
parallel attempts, and comparing them by reading their terminals is how operations work
anyway.

## Decision

Removed the `isVirtual` guard in `src/mainview/components/LaunchVariantsModal.tsx` — the
button renders on every board kind. The inverted assertion lives in
`LaunchVariantsModal.test.tsx` ("offers the Add Variant button on virtual boards too").
The task card's `+ Variant` (`TaskCard.tsx:1189`) was already unguarded and stays that
way; it was never the defect.

## Risks

The picked-folder regime stays unguarded and is the real hazard: variants launched from a
task with `opsWorkDir` set all target that one folder. Deliberately left alone rather than
guarded silently — a warning at launch time (the existing `ops.create.workDirConflict`
wording covers the hazard) is proposed separately and needs a decision of its own.

## Alternatives considered

- **Keep the guard, add a muted line explaining it** (mirroring `ops.gitUnavailable` in the
  inspector git bar). Rejected once the harm was disproven: it would have explained a
  restriction that should not exist.
- **Remove the card's `+ Variant` instead**, making the guard consistent. Rejected for the
  same reason — it removes working functionality on a false premise.
- **Guard only when `opsWorkDir` is set.** Correct in principle, but the collision there is
  still unobserved, so it is proposed separately rather than folded in here.
