# Completion ownership reads as a mode, not as another toggle

## Context

A user turned on "I'll complete it myself" (`manualCompletion`), then reported the
missing post-merge completion prompt as a bug. The control gave them nothing to
connect the two: a 33px icon-only chip in the inspector's Context bar, tinted with
the same `--accent` blue the watch bell two slots away wears when it is on. Blue in
this app means "a toggle is on"; it does not mean "dev3 stopped suggesting
something". The state was also unreadable without hovering — the person glyph and
its badge differed only by a 4px tick, and the badge was drawn in both states.

## Decision

The active state now carries three cues instead of one (`TaskInfoPanel.tsx`,
`manualCompletionToggleButton` and its action-sheet row; `TaskIcons.tsx`,
`CompletionOwnerIcon`; `index.css`, `.th-owner-badge-idle`):

- **Amber, not accent** — the `warning-paper` / `text-warning-strong` /
  `border-warning/30` recipe the hibernate button already uses in this panel. Yellow
  is this app's "deliberate hold"; red means "destroys something you cannot get
  back" and green means finished, so neither may carry an intentional mode.
- **A persistent label** — the chip spells the mode out whenever it is on and the
  panel is not `tight`, in the merge dialog's own words
  (`task.manualCompletionEnabled`, "I’ll complete it myself"). That dialog's third
  button is where most people turn this on, and a shortened echo of it ("I decide")
  did not read as the same thing. Colour never carries the state alone; `tight`
  folds the words back and leaves shape plus hue.
- **A shape difference** — idle draws a bare person and reveals the whole badge only
  on hover (a preview of what the click does); active keeps the badge and fills it.

Off is unchanged and deliberately quiet: grey, wordless, bordered like its
neighbours. The copy now states the consequence rather than the mechanism — the
enabled tooltip and accessible name end in "dev3 won't suggest completing this task
after a merge", and the phone's action row carries the same as a second line, since
a phone has no tooltip. No lifecycle behaviour changed.

## Risks

- Amber is now worn by two controls in the same panel (hibernate, in the Session
  bar; this chip, in the Context bar). They are in different clusters and only this
  one carries a word, but a third amber control would blur the hue's meaning.
- The narrow summary bar still shows nothing — the state lives one tap away in the
  actions sheet. Putting an indicator on that bar is a placement change under the
  UX bible's §12.6 shed rules and was left to a `/ux-principal` pass.

## Alternatives considered

- **Keep the accent blue and only fix the copy.** The tooltip already explained it;
  the user never hovered. Hover-only explanations do not fix a glanceable state.
- **Danger red.** Louder, and wrong: it reads as an error or a destructive action,
  which is exactly the misreading being fixed.
- **Show the label in both states.** Costs 156px of bar permanently for the default
  state, which needs no explanation; see
  `decisions/2026/07/25/inspector-bars-adapt-to-panel-width.md`.
- **A perpetual pulse or glow on the active chip.** Attention cost with no end, on a
  state that lasts for the life of the task.
