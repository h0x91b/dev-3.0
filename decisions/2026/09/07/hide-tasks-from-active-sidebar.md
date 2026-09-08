# Hide tasks from the Active Tasks sidebar

## Context

Working across several projects at once, you start a task and then set it aside for something more pressing. It stays started and unfinished, waiting until there is time to pick it up again. Every task set aside that way was still a row in the Active Tasks sidebar, next to the two or three actually being worked, so the list stopped being a jump list for the work in hand. Hibernating a set-aside task frees memory but keeps its row in the list, and completing or cancelling it throws the work away. What was missing was a way to take the row out of this one list and leave everything else about the task alone until it is picked up again.

## Investigation

Optional task fields already persist the way this needs (`draft`, `hibernated`), and sidebar view preferences already live in guarded `localStorage` keys. `setTaskPriority` already writes one value across a whole variant group and pushes a renderer update per variant, so the shape existed and could be copied. One case the priority path never had to handle is a launch overlapping a hide. Variant creation therefore reads visibility inside the same file lock as the setter.

## Decision

`Task.hidden` is an optional persisted boolean, and `setTaskHidden` writes it across the whole variant group. `ActiveTasksSidebar` drops hidden tasks from the list by default and owns a reveal toggle that persists per browser. The hide action lives on `ActiveTaskRow` and nowhere else, as the row's third control. At rest it hides only where a hover pointer exists — a pointer-capability test, not a width one, which is what makes an invisible tap target impossible. The reveal control renders only while something is hidden, and it sits in the filter row beside the funnel rather than in the header. Measured on a board with spaces: the header already carries the scope group's three buttons plus the collapse toggle, and a fifth control truncates the "Active Tasks" title (94px of label against ~94px of room). The filter row has space, and reveal is the funnel's own axis — which tasks are in this list. `is:hidden` is a first-class search token, offered by the funnel from the pool BEFORE visibility filtering and revealing hidden tasks by itself, so the one search that selects them cannot come back empty.

## Risks

Only the sidebar can reveal a hidden task, because the sidebar is the only place the action exists. The board shows no marker at all, though its funnel offers `is:hidden` so parked tasks are findable there. Hidden tasks still notify and can still ask for attention while absent from the default list; the reveal eye grows a red dot and says so in its label whenever one of them needs the user, and drops the dot once the rows are on screen and carry their own marker.

Four consequences were accepted rather than fixed, and they are written down here so the next reviewer finds the answer instead of re-deriving it. A variant added to a hidden group is created hidden, with nothing at the launch site saying so. Only the clicked row animates out, and its siblings vanish on the frame the write returns. A request that changes nothing springs the row back without a toast, which takes a client whose copy of the flag is already stale against disk, and the `taskUpdated` push then reconciles it. The 200 ms animation has no unit test, because `test-setup.ts` forces `prefers-reduced-motion: reduce` to true for every renderer test; it is cosmetic and was checked twice in a real browser instead.

The `docs/ux` per-file budgets were raised for this change, the yaml 116 to 117 KB and the decisions log 80 to 81 KB, with the reasoning in `src/bun/__tests__/ux-docs-budget.test.ts` beside the numbers. Both of this feature's manifest entries were folded to pointers at this record first, and `main` had arrived at 3 and 6 bytes of headroom, so the alternative was a feature documented nowhere. Folding other entries would have meant deleting a why that survives in no record.

## Alternatives considered

A local-only set of hidden ids would not travel to a phone over remote access, and it would have been the app's first per-task browser preference. Per-variant hiding would split one logical task in half. Putting the action only in the row's overflow menu would make a hidden task harder to recover, because the row that menu hangs off is exactly what disappears. The prototype also carried a toggle on the Kanban card, and it was removed. A board control for an effect that only the sidebar shows reads wrong, and it needed the card's inline-action budget raised from four to five.
