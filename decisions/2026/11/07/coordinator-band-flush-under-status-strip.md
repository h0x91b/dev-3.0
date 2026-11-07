# Coordinator band flush under the status strip

## Context

`decisions/2026/11/06/coordinator-role-band-not-a-hue.md` inset the role band (`mx-1 mt-1`, `rounded-lg`) so that in light theme the In Progress strip (Lc 0 against `accent-fill`) would not merge with it. On a dark card the inset reads as a thin dark line between the status strip and the band, and the maintainer asked on 2026-11-07 for the band to be one continuous blue block under the strip. The same request made a coordinator's title accent in one-line rows, where only a small chip marked the role.

## Decision

`TaskRoleBand` (`src/mainview/components/TaskRoleBand.tsx`) sits flush under the status strip, full width, square. Status stays readable from the left rail, which carries it on every card. `COORDINATOR_TITLE` (`text-accent-emphasis`) paints the coordinator's title in the Active Tasks sidebar (`ActiveTaskRow`), the dashboard coordinator rows and the task switcher; board cleanup keeps a neutral title, matching its neutral band. `accent-emphasis`, not `accent`, because `accent` text measures only Lc 46 on dark surfaces; the pins are in `src/mainview/__tests__/contrast-check.test.ts`.

## Risks

A coordinator in In Progress in light theme shows strip and band as one blue block; the rail still names the status. `accent-emphasis` on the selected sidebar row and the selected switcher row measures Lc 57–62, under the 60 non-body floor; the selected state is already marked by its tint and ring.

## Alternatives considered

Keep the inset and fill the gap with accent (the same pixels as flush, with more markup); a light hairline between strip and band (a second seam, which is what was asked to go); `text-accent` for the title (Lc 46 on dark).
