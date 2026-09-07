# Traffic obstacle routing and Follow

## Context

The user found Follow visually static and message wires crossing intermediate cards. Pair framing gave a request and its reverse reply the same camera target; the original simple doglegs only knew their endpoints.

## Investigation

Browser sampling confirmed a constant 75% zoom across the request/reply despite Follow being enabled. Routing tests reproduced same-row and multi-row crossings, including coordinator routes to distant workers.

## Decision

`nodes-routing.ts` retains clear doglegs and routes blocked ones through a shared orthogonal corridor grid with A* search. Every card is padded by 26 scene pixels to reserve room for the 12px rounded corners; impossible routes are omitted rather than crossing a card. Positions and direction remain unchanged.

`traffic-camera.ts` frames the complete exchange route during flight, then zooms to the recipient with smoothstep transitions. A reversed reply ends on the other task. Held/failed attempts settle on their actual stop point; manual navigation/pause cancels movement and reduced motion jumps directly. Faster replay shortens the camera sequence to fit its event interval.

## Risks

Dense routing costs more than a dogleg; a shared coordinate grid bounds it by card geometry rather than canvas pixels. Representative layouts of 100/500 cards took about 8/85ms locally; these are measurements, not guarantees. Route-first framing can become small for distant pairs, followed by a readable destination close-up.

## Alternatives considered

Pair-only framing was rejected because reciprocal messages never changed the view. Zooming only to the recipient would hide too much of the transit. A straight-line fallback would reintroduce crossing bugs, while copying the HTML demo's endpoint-only router would retain the same limitation.
