# Project groups, senderless messages and idle Follow

## Context

The user saw a timeline event addressed to task #3 while the graph stayed on an unrelated pair, and could not distinguish projects in All Projects. They also wanted an idle Follow camera to return to the whole scene.

## Investigation

`layoutTraffic` treated pair membership as evidence of traffic. A row with no recorded sender task has no pair, so its recipient was misclassified as quiet and hidden even though the timeline included it. All Projects loaded multiple projects but sorted their tasks into one grid and stacked their coordinators together.

## Decision

Count traffic membership from every known endpoint independently of routing. Senderless/self-directed messages show and highlight their recipient with a message label; no fictional sender or route is added. Project blocks each own their coordinator and worker bands, arranged two blocks per row with named headers. Inter-project routes use the shared obstacle router.

Follow frames exchanges, then returns to overview after 3.5 seconds of Live inactivity or automatic replay completion. Consecutive replay events reset the timeout, avoiding zoom oscillation; manual pause/seek preserves the selected frame. `useTrafficPlayback.ended` distinguishes automatic completion from a user pause. Idle overview includes project block bounds; normal quiet/hibernated disclosure remains intact.

## Risks

Many project blocks require a smaller overview scale; headings remain screen-sized and may truncate. Activity here means displayed message traffic, not an inferred pending reply or historical runtime state. Project privacy and the selected time window still limit the displayed data.

## Alternatives considered

Synthesizing a sender task would fabricate provenance. Grouping all coordinators above a shared grid obscures project ownership. Treating every stopped player as finished would move the camera while the user inspects a paused event.
