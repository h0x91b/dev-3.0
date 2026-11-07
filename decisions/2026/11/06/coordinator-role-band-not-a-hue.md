# Coordinator role band, not a hue

## Context

#2186 marked coordinators with lime hazard tape, a 2px lime dashed border and a lime badge; #2156 gave board-cleanup cards a red dashed border. Stripes are the caution idiom, dashed meant draft, coordinator and cleanup at once, and identity surfaces are accent, never warning or danger (UX bible §5.6, §6). The maintainer chose V1 (solid accent band) on 2026-11-06 from three measured mocks.

## Investigation

Every hue near-collides with the status palette (OKLCH): lime sits 20–34° from Completed green and `--warning` (Lc 0 against both in dark), rose 21–28° from Cancelled and danger, violet 5° from Review-by-colleague. `accent-fill` is ≥ 96° from Completed, Review, warning and danger, and 16–18° from In Progress indigo. APCA (`src/mainview/contrast-check.ts`), dark / light: white on `accent-fill` −77 / −79; band vs card −27 / +70; band vs raised −28 / +68; halo ring `accent/.5` over card −17 / +36 (`accent/.3` fails at −8). The proposed neutral cleanup fill `bg-elevated` measures Lc 0 against the card in both themes, so cleanup uses `fg/30` with `text-fg` ink: band vs card −19 / +34, ink −78 / +63.

## Decision

Change the kind of device, not the colour. `TaskRoleBand` (`src/mainview/components/TaskRoleBand.tsx`) draws an opaque 22px band between the card's status strip and identity row: glyph + role name, and for a coordinator the "N created" lineage count (moved out of the body). `mt-1` keeps a sliver of card between strip and band, load-bearing in light theme where accent vs In Progress is Lc 0. A coordinator card gets `COORDINATOR_CARD_HALO` instead of a second border. Sidebar and dashboard rows use `TaskRoleChip`; the dashboard row keeps a `w-1 bg-accent-fill` strip. Dashed is draft-only again; `--coordinator`, `--coordinator-ink` and the tape CSS are gone. `src/mainview/__tests__/contrast-check.test.ts` pins every pair above.

## Risks

Accent is near In Progress indigo; mitigated by the sliver and by the band being a labelled surface. The card grows ~24px; one coordinator per project makes that negligible.

## Alternatives considered

V2 rose band (new token, near danger in light theme); V3 rose edge + chip (keeps a second identity border next to the status edge); keep tuning the lime (no hue on the wheel is free).
