# 085 — recharts for the Productivity Stats charts

## Context
The stats dashboard first shipped with hand-rolled chart components (flex-div bars,
a raw `<svg>` polyline area). They had real bugs: bars overflowed the axis baseline
and there was no hover/tooltip, so values weren't readable. The project otherwise
keeps dependencies minimal.

## Decision
Adopted **recharts** (`recharts@3.x`, React 19 compatible) for the series charts
(`BarChart`, `AreaChart`) and the per-agent donut (`AgentPie`). It gives correct
axes/margins, accessible hover tooltips, and a `PieChart` — one library covers all
three needs. Self-rolling tooltips + responsive sizing for each was more code and
more bugs than the dep is worth here.

## Risks
- recharts applies colors as SVG **attributes**, where CSS `var()` does **not**
  resolve. Charts must receive already-computed colors, so `useChartColors`
  (`src/mainview/components/stats/useChartColors.ts`) reads the design tokens via
  `getComputedStyle` and re-reads on `data-theme` changes (same pattern as `Gauge`).
- `ResponsiveContainer` needs `ResizeObserver`, absent in happy-dom — mocked in
  `src/mainview/test-setup.ts`.
- Bundle size grows; acceptable for a desktop app.

## Alternatives considered
- **Keep hand-rolled charts** — rejected: the overflow/tooltip bugs kept recurring
  and a polished, themeable tooltip is non-trivial to do well by hand.
- **nivo / visx** — nivo is heavier (many packages); visx is lower-level and would
  need as much glue as the hand-rolled version. recharts hit the sweet spot.
