# Directional drops and anchored message bubbles

## Context

The user preferred a calm stream indicating message direction, with violet drops for every outcome except failed delivery. They asked to remove bubble metadata and reported that manual panning pinned an unrelated message to the viewport's top edge.

## Decision

`TrafficNodes` emits three round drops per attempt, 500ms apart at normal pace. Held and unconfirmed attempts traverse the full route; only not-delivered remains red and stops short. Faster replay compresses the train to finish within its event interval. The 1× preset is calibrated to the former 0.75× pace (1.5 times faster than unchanged 0.5×); 2×/4×/8× multiply that new baseline, while 0.25× retains its relative pace. All presets then apply a shared 0.9 speed factor; 1× is the default (about 1.63 seconds per event). `useTrafficPlayback.intervalMs` synchronizes the event timer, camera and drops. Drops remain finite, screen-sized and absent under reduced motion; they do not increment message counts.

`TrafficMessageBubble` shows only the message with a rounded tail with its fill overlapping the body edge to hide the seam, ending at the route midpoint (or known recipient for senderless messages). It follows the scene anchor, flips below near the top, and hides when that anchor is offscreen instead of pinning itself to an edge. Delivery details remain in the inspector and log.

## Risks

Movement now encodes direction rather than proof of delivery. Three drops visualize one attempt, not three messages. Unknown sender provenance stays unknown; notification persistence remains deferred to Seq1813.

## Alternatives considered

Yellow held drops stopping halfway confused the user and disrupted the visual flow. Repeating indefinitely would imply continuing traffic. Clamping an offscreen anchor into the viewport created the reported floating-label bug.
