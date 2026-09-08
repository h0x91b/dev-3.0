# Agent traffic becomes a destination, and entry replays the trailing hour

## Context

Agent traffic shipped as a fullscreen modal: a portal with a focus trap, an Escape
dismiss, a close `×`, and a BottomSheet on narrow widths. `PRODUCT_UX_BIBLE.md` §5.9
ruled in August that a 30-day log was "still an overlay rather than a ninth
destination". Living with it showed the cost of that ruling: the surface had no app
header, no Back/Forward, no breadcrumb, and no screen path in analytics, so
`⌘1–9` and the palette navigated *behind* it (App had to close it on every route
change so the destination would be visible at all), and GA4 could not tell how often
people look at traffic at all. Arseny reversed the ruling.

## Decision

- **A route, not an overlay.** `Route` gains `{ screen: "agent-traffic"; scopeProjectId? }`
  (`src/mainview/state.ts`) and `App.renderScreen` renders it under the ordinary shell.
  Every existing entry point already funnelled through `OPEN_AGENT_TRAFFIC_LOG_EVENT`,
  so the pill, the kebab row, the View menu and the palette needed no change — the
  listener navigates instead of setting a boolean. `⇧⌘M` toggles: it navigates in, and
  steps back when pressed on the screen; Escape does the same.
- **The field is `scopeProjectId`, not `projectId`.** Several call sites read a bare
  `"projectId" in route` as "the user is inside this project" (the Option+Tab task
  switcher, the header). The traffic screen is global, so a `projectId` field put a
  project in the breadcrumb and in the switcher's scope. The id seeds the screen's
  scope filter and nothing else, and `projectIdForRoute` deliberately ignores the route.
- **A ninth destination, by documented exception.** `max_top_level_items: 8` was
  "fully spent". The route costs the nav budget nothing: no nav item, no permanent
  header entry, invisible while the beta flag is off. Recorded next to the budget it
  excepts (`ux-architecture.yaml → navigation.global_nav.budget_exception`).
- **Entry autoplays the trailing hour, once.** `ENTRY_WINDOW = "hour"` is the window a fresh
  entry picks, and only that: `Live` keeps returning to its own 24 hours (`LIVE_WINDOW`), because
  the ruling was about what entering the screen does, not about re-defining a control the user
  presses deliberately. The period picker names the hour on screen, and the calendar days are
  untouched. A ref, not state, guards the "once": the hour's start slides with the clock, so
  `replayRecords` gets a new identity on nearly every render and a live append can
  arrive at any moment — an effect keyed off the data restarts the replay under the
  user's cursor. It arms on the first settled load, *including* a settled load that
  found nothing, so an empty window stays parked instead of springing to life when the
  next event lands. `prefers-reduced-motion` parks the cursor at the start of the window
  instead of playing, and a manual pause stands — nothing re-arms.

  The arming condition counts `playback.events`, not the message list, so it is ready for
  Seq 1823's union timeline: an hour with no messages but with task movements or notifications
  is not an empty window and must replay. The cursor placement sits behind one local seam
  (`startEntryReplay`), whose contract is "the first event at or after the window's start" —
  today index 0 of a window-filtered message list, and `playback.seekToTime(start)` the moment
  Seq 1823 lands it. `useTrafficPlayback.ts` is not touched by this task.
- **Back/Forward restoration is per entry.** History stores whole routes, so Back
  re-enters the screen as a fresh mount and it replays that hour again from its start.
  Cursor position is deliberately not restored: it belongs to a replay of a window
  whose bounds have moved by the time the user comes back.
- **The overlay is gone, not shimmed.** `AgentTrafficLog.tsx` → `AgentTrafficScreen.tsx`,
  the portal/focus-trap/Escape/`×`/BottomSheet shell deleted, `.traffic-backdrop`/
  `.traffic-dialog` → `.traffic-screen`/`.traffic-frame`, and the `trafficLogOpen`
  state plus its close-on-navigation effect removed from `App.tsx`.

## Risks

- **A restored session can land on the screen.** Route persistence restores it on
  relaunch and it will replay the hour on arrival. With the flag off an effect
  navigates to the dashboard instead, so the screen is never reachable-but-orphaned.
- **Autoplay is motion the user did not ask for.** Mitigated by the reduced-motion
  branch; the same effect never fires twice, so a jittery data feed cannot loop it.
- **Escape now navigates.** On this screen nothing else claims Escape (no terminal, no
  modal above it), and the period picker's popover consumes its own.

## Alternatives considered

- **Keep the overlay and add a route as well.** Two ways to reach one surface, and the
  repo forbids compatibility shims outright.
- **Restore the replay cursor on Back.** Rejected: the window has moved, so the index
  points at a different message than the one the user left on — a restored cursor
  would be confidently wrong.
- **Autoplay the whole 24-hour window (the old default).** Minutes of replay before
  the cursor reaches anything recent, which is not the question someone opens the
  screen with.
- **Make it a tenth-and-beyond nav item.** Rejected: a permanent nav entry for a
  flagged beta is exactly the toolbar creep the manifest's budgets exist to stop.
