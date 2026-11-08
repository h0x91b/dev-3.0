# Coordinator band flush under the status strip

Amended on 2026-11-08: the Active Tasks sidebar's filled title bar (`COORDINATOR_TITLE_BAR`) was removed at the maintainer's request; the sidebar title is now plain accent text, with the role chip staying on the identity line.

## Context

`decisions/2026/11/06/coordinator-role-band-not-a-hue.md` inset the role band (`mx-1 mt-1`, `rounded-lg`) so that in light theme the In Progress strip (Lc 0 against `accent-fill`) would not merge with it. On a dark card the inset reads as a thin dark line between the status strip and the band, and the maintainer asked on 2026-11-07 for the band to be one continuous blue block under the strip. The same request made a coordinator's title accent in one-line rows, where only a small chip marked the role.

## Decision

`TaskRoleBand` (`src/mainview/components/TaskRoleBand.tsx`) sits flush under the status strip, full width, square. Status stays readable from the left rail, which carries it on every card. `COORDINATOR_TITLE` (`text-accent-emphasis`) paints a coordinator's title in the dashboard coordinator rows, the task switcher and the Active Tasks sidebar (`ActiveTaskRow`), where the role chip stays on the identity line below. A full-bleed filled bar was tried in the sidebar and rejected as too heavy. Board cleanup keeps a neutral title, matching its neutral band. `accent-emphasis`, not `accent`, because `accent` text measures only Lc 46 on dark surfaces; the pins are in `src/mainview/__tests__/contrast-check.test.ts`.

## Risks

A coordinator in In Progress in light theme shows strip and band as one blue block; the rail still names the status. `accent-emphasis` on the selected switcher row measures Lc 58–68, partly under the 60 non-body floor; the selected state is already marked by its tint. On the selected Active Tasks row (`accent/20` over base) it measures Lc 62 dark, 58 light.

## Alternatives considered

Keep the inset and fill the gap with accent (the same pixels as flush, with more markup); a light hairline between strip and band (a second seam, which is what was asked to go); `text-accent` for the title (Lc 46 on dark).
