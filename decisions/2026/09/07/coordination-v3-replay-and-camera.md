# Coordination v3 replay and camera

## Context

The user rejected the first Experiment 2 implementation as visually different from the supplied Coordination v3 HTML. It copied the earlier concept's short cards and brackets, omitted playback and camera controls, and left the inspector permanently open.

## Investigation

Coordination v3 uses a stable three-column grid, larger cards with overview text, screen-sized compact labels, thin violet message routes and a bottom event transport. Its Follow camera frames both endpoints; Focus frames one task. The demo also contains synthetic activities and reconstructed histories that production cannot assume exist.

## Decision

`TrafficNodes.tsx` and `nodes-layout.ts` follow v3's geometry, semantic zoom, directional capsules and 500ms camera movement. `TrafficPlayback.tsx` and `useTrafficPlayback.ts` replay only existing recorded messages, freezing the sequence while live data continues arriving. The last event receives a full dwell; changing presentation or scope releases playback timers.

The node inspector opens on demand. Follow is with zoom/fit; explicit Replay restores Follow and task details expose Focus. Current completed/cancelled labels remain visible and hibernated tasks stay grey in a lower band; replay reveals its parked endpoints without changing task state. Route verdicts/counts follow the replay cursor while geometry stays stable.

## Risks

Replay does not reconstruct past task statuses, PRs, overviews or activity; the transport states this. Fit can zoom below reading size on large boards, where semantic zoom displays status cells; users use Focus or zoom to read details. Reduced motion removes glides and flights while preserving transport and text.

## Alternatives considered

Adding Play to the old layout would retain the visual mismatch, so the grid and card hierarchy were ported together. Copying demo activity counters or invented history was rejected: motion must describe recorded attempts. The existing overall feature gate, default Experiment 2 preference and supported Experiment 1 remain intact.
