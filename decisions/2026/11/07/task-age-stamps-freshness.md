# Task age stamps: two clocks, freshness-tinted

## 1. Context
h0x91b/dev-3.0#2181 asked for task age on Kanban cards. Cards showed no time at all; the Active Tasks row showed only time since the last status change (`movedAt`). The user wanted both clocks — when a task was created and when it was last active — on the card and in the sidebar.

## 2. Investigation
Six placements were mocked on the live board (pair of stamps, arrow, freshness-tinted pair, lifeline bar, words, split between `#seq` and the status rail). Every To Do task has `movedAt = null`, so "last activity" must fall back to `createdAt`. The compact formatter printed months as `M`, which reads as minutes at `text-nano`.

## 3. Decision
`TaskAgeStamps` (shared by `TaskCard` and `ActiveTaskRow`): calendar + created age in `text-fg-muted`, clock + `movedAt ?? createdAt` coloured by `freshness()` in `utils/statusAge.ts` (accent <15m, accent/70 <2h, fg-2 <24h, fg-muted after). Cards tick on one shared 15s clock (`useSharedNow`). The card header never wraps, so `useShedOnOverflow` drops the created stamp, then both, on crowded headers (coordinator/hibernated badges). `compactAge` prints months as `mo`.

## 4. Risks
The shedding is JS-measured, which the 2026-08-07 narrow-row decision rejected for width-driven rows. Here overflow depends on content (which badges a task has), not on the box width, so a container query cannot express it; the hook only re-expands on a wider box or changed content, so it cannot oscillate. Freshness uses the accent colour, which also marks interactive text; it is limited to one stamp per card. A stamp whose text grows by one character between ticks is not re-measured until the card re-renders.

## 5. Alternatives considered
A lifeline bar (+18px per card) and the `#seq`/rail split (needs a rail rule change) were the runners-up; words (+28px) and hover-only (invisible on touch, unscannable) were rejected. A settings toggle was dropped because the stamps add no height.
