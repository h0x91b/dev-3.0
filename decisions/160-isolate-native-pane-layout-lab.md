# 160 — Isolate the native pane layout lab

## Context

The tmux-removal roadmap needs evidence that dev3 can own pane layout and preserve independent terminal-view identity before a production backend or transport is selected. Coupling that proof to current tmux state or the in-progress native session work would make the experiment irreversible and confound renderer feasibility with process integration.

## Investigation

Directional focus only needs normalized pane rectangles derived from split orientation and ratio; it does not require DOM geometry or tmux coordinates. Stable logical pane IDs can also key fake stream sessions independently from React component instances, allowing remount and serialized restore behavior to be tested directly.

## Decision

`src/shared/split-tree.ts` owns a pure immutable versioned tree whose restore boundary validates the complete structure before returning a value. The renderer lab under `src/mainview/labs/native-pane/` keys bounded fake sessions by pane ID, is reachable only from View → Debug, and has a source sentinel that rejects tmux, RPC, PTY, and production terminal imports.

## Risks

The fake streams do not represent native process or terminal-emulator performance, so the recorded baseline covers layout, subscription, timer, and resize work only. A future production integration may reuse the model but must deliberately bridge it to backend ownership instead of importing backend concerns into the tree.

## Alternatives considered

Reusing tmux layout strings was rejected because it would preserve the dependency this proof is meant to remove. React-owned pane IDs were rejected because remounts could cross-wire stream identity, and connecting the lab to Bun.Terminal or the native session protocol was rejected as outside this renderer-only ticket.

