# Gate the agent-traffic readout and log behind an experimental setting

## Context

The agent-traffic readout and its 30-day log shipped in PR #1534 (see
`decisions/2026/08/25/agent-traffic-readout-and-log.md`) as always-on UI: a labelled row in the
header's overflow kebab, an unread-earned pill next to it, `⇧⌘M`, two native-menu rows, a palette
command and a discovery tip. Immediately after the merge the feature was asked to become opt-in
until it has been lived with, because it touches the header — the one surface where a permanent
control is expensive — and because the readout's value is unproven outside multi-agent workflows.

## Decision

`GlobalSettings.experimentalAgentTraffic` (default off, only an explicit `true` is a stored opt-in,
sanitized in `src/bun/settings.ts`) is the single gate, exposed as a second toggle in Settings →
System → Advanced Experience next to Terminal BiDi.

**Off means no trace, not a greyed control.** Every one of the six surfaces disappears:

| Surface | Where the gate is |
|---|---|
| Header pill, kebab row, phone sheet row | `AgentTrafficIndicator` returns null (after its hooks) |
| Log overlay, `⇧⌘M`, the open event, arrival re-reads | `App.tsx` |
| Keymap listing (overlay + rebind editor) | `FLAGGED_SHORTCUTS` in `keymap.ts` |
| Palette command | `availableCommands` in `commands.ts` |
| Native View + Help rows | `agentTrafficItems()` reading `MenuContext.agentTrafficEnabled` |
| Discovery tip | `availableTips` in `tips.ts` |

The value is mirrored in a module flag (`src/mainview/agent-traffic-flag.ts`, fed from
`globalSettings` by one effect in `App.tsx`, exactly like `terminal-bidi/flag.ts`) because four of
those six consumers are registries, not components. React consumers read the hook
(`useAgentTrafficEnabled`) so a toggle takes effect without a reload.

The native menu is the one place where the gate **hides** instead of disabling: `meetsContext` greys
items out, which is right for "no task selected" and wrong for a feature the user has switched off.

Delivery is untouched — messages are still written to `data/<slug>/messages/*.jsonl` and the toast
still fires — so switching the beta on later reveals the history already on disk.

## Risks

- Six gates, one flag: a seventh surface added later can forget it. The guard is
  `src/mainview/__tests__/agent-traffic-flag.test.tsx`, which asserts every surface in both states.
- Three existing suites (`keymap`, `tips`, `commands`) assert full-registry invariants and now switch
  the flag on deliberately. If a future flag lands without doing the same, those suites fail loudly
  rather than silently weakening — acceptable.
- Unread state stays per browser, unchanged by this work.

## Alternatives considered

- **Revert the feature.** Throws away working, tested UI to answer a question a flag answers better.
- **Ship it on and let users hide it.** The complaint is about the header spending a slot by default;
  an opt-out would still spend it on first launch for everyone.
- **Gate only the header control.** Leaves `⇧⌘M`, two menu rows, a palette command and a tip
  pointing at a surface that is otherwise unreachable — the worst of both.
