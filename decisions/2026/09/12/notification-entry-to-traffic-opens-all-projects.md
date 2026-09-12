# A notification click opens agent traffic at all projects, never the board in view

## Context

Every entry point to the `agent-traffic` destination seeded the screen's project
filter from the route it was opened from (`projectIdForRoute(state.route)`), and the
screen turns that seed into its scope: `useState(projectId ?? ACTIVE_PROJECTS)` in
`AgentTrafficScreen.tsx`. Standing on one board and clicking an agent-message toast
about traffic on **another** board therefore opened the screen filtered to the board
in view — so the message that raised the toast was filtered out of its own
destination, and the screen looked empty.

## Investigation

The toast's click handler (`App.tsx`, the `rpc:agentMessage` effect) calls
`openAgentTrafficLog()`, which fires one window event; the single `onOpen` handler
did the route-to-scope translation for every opener alike. The payload already
carries `projectId` (receiver) and `fromProjectId` (sender), so scoping to either
end was available — and rejected: a toast is an arrival the user did not choose, and
the thing they want to see is the traffic, not one board's slice of it.

## Decision

`openAgentTrafficLog()` takes a scope: `"current-project"` (the default, unchanged
for the header readout, ⇧⌘M, the View menu and the command palette) or
`"all-projects"`, which navigates with no `scopeProjectId` at all. Only the agent-
message toast passes `"all-projects"`. No project id means the screen's own default
scope, "All active projects" — so this reuses existing scope state rather than adding
a filter or a control. Bible §5.7's traffic exception now reads "opens traffic at all
active projects, else the **receiver**"; the receiver remains the destination with the
beta off, because its terminal is where the text landed and the reply gets typed.

## Risks

A user who keeps one board in view and reads only its traffic now gets a wider stage
from a toast click than from ⇧⌘M. That asymmetry is deliberate — the scope dropdown is
one click away — and the alternative hides messages the notification just announced.

## Alternatives considered

Scope to the sender's or the receiver's project: still a filter the user did not ask
for, and a cross-project pair has two right answers. Make every entry point global:
loses the useful "this board's traffic" reading of a deliberate entry from a board.
Update the scope of an already-open screen: nothing to fix — a toast is suppressed
while this window sits on the traffic screen.
