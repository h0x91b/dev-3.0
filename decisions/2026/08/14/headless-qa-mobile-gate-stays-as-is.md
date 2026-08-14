# Headless UI QA: the mobile gate stays as is, the skill documents it

## Context

A vent (2026-07-24) reported that the repo's own browser-QA guidance is unusable in headless
Chromium: the app's mobile detection reads the physical `screen.width`, headless allegedly reports
a small screen regardless of the viewport, `MobilePortraitGate` then covers the page and marks the
app `inert` — screenshots work, clicks do not. The suggested fixes were a copy-paste init script in
the skill, or loosening the detection in `src/mainview/hooks/useMobile.tsx`.

## Investigation

Measured on `agent-browser` 0.6.0 against this task's dev server:

- `set viewport 1440 900` then `open` → `screen.width = 1440`, no gate, no `inert`; clicking
  "Productivity stats" navigated normally.
- No viewport set at all → `screen.width = 1280` (headless default), also above the 1024 breakpoint.
- `set viewport` *after* `open` + `reload` → `screen.width = 1440` as well.
- `set viewport 844 390` (phone-sized landscape) → `screen.width = 844`, gate on, `inert` on.

So the tooling does emulate `screen.*` alongside the viewport, and the only way to reach the inert
state today is to ask for a phone-sized viewport — which is the gate doing its job.

Swept across the common resolutions (2560×1440, 1920×1080, 1600×900, 1440×900, 1366×768, 1280×720,
1024×768, 768×1024, 390×844): `screen.width` always equalled the requested width, no gate, no
`inert`, and a real click on "Productivity stats" navigated at every size that renders the button.
Only landscape 844×390 gated, and there `snapshot -i` returns zero interactive elements — the
cheapest signal that the page is inert rather than empty.

## Decision

No product change. `useMobile.tsx` keeps reading `screen.width` and `MobilePortraitGate` keeps its
`inert` behavior. `.claude/skills/debug-ui/SKILL.md` gains: the "`set viewport` before `open`, width
≥ 1024" ordering in the flow, an `agent-browser snapshot -i` beat that proves the page is drivable
rather than only screenshot-able, and a gotcha naming the gate as the cause of an inert app with a
one-line `eval` diagnostic.

## Risks

A future `agent-browser` (or another driver) could pin `screen.*` to the real headless display and
resurrect the symptom for desktop-sized QA. The gotcha says so explicitly and names an app-side
escape hatch as the response at that point.

## Alternatives considered

- **Loosen the detection** (fall back to `innerWidth`, or an automation bypass) — rejected: it
  changes real mobile behavior to fix a problem that no longer reproduces; the comment in
  `useMobile.tsx` explains why `innerWidth` was refused.
- **Ship the init script from the vent** — rejected: `agent-browser` 0.6.0 has no init-script
  command, and the override it works around is unnecessary here.
