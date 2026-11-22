# Task header: one tree for collapsed and expanded, hidden parts built only when drawn

## Context

After the task header moved onto its slot (`task-header-slot-frame`), a React Profiler harness (the real `TaskHeader` beside a memoized fake terminal, happy-dom, five interleaved runs against `3e08eb8bd`) showed it slower than before: mount 36.7 vs 33.1 ms, five task updates 56.9 vs 52.0 ms, four collapse toggles 148 vs 118 ms. Step 3.2 splits the bars into more items, which would multiply any per-item cost.

## Investigation

Toggles: the desktop return was `collapsed ? <tree A> : <tree B>`, two differently shaped trees, so every toggle unmounted and remounted all four regions and their controls (26 commits for 4 toggles). Mount and updates: bypassing `SlotItems` entirely and rendering the clusters directly cost the same as the slot path once the code was warm, so the slot layers were not the cause. The real cost was JSX built on every render but never drawn: the slot frame hoisted the narrow summary bar and actions sheet out of the `if (narrow)` branch, so a desktop header built them on every render. Each dev-mode element captures an owner stack. The details body (hidden while collapsed, the default) and the narrow status `BottomSheet` were built eagerly too, before 3.1 as well.

## Decision

`TaskHeader.tsx` renders the desktop header as one tree whose classes depend on `collapsed`. The bar rows keep their element positions, and only the details body and drag handle mount conditionally, so a toggle re-renders and never remounts. The narrow clusters, the details body and the status sheet are functions called where they are drawn, so a render builds only what is on screen. Same five-run harness after the change: mount 33.4 vs 34.7 ms, updates 53.4 vs 55.3 ms, toggles 85 vs 128 ms (baseline measured interleaved under the same load), 14 commits instead of 26.

## Risks

Absolute numbers come from a dev build under happy-dom and swing a couple of ms with machine load. Only interleaved comparisons count, and production React pays far less per element. A future edit that brings back `collapsed ? … : …` around the bars would quietly restore the remount; `TaskTerminalHeaderRenders` guards the terminal, not the header's own subtree.

## Alternatives considered

Memoizing each region's cluster: the clusters close over most of the header's state, so the memo would miss on every render. Stripping slot layers (wrapper div, surface provider, per-item boundary): measured no gain, and the boundary is what isolates a crashing item.
