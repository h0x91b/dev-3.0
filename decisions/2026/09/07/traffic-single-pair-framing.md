# Single pair framing for traffic

## Context

The user found the route-to-destination camera sequence distracting and preferred the calm original HTML demo. They asked to keep both tasks visible, center between them, retain a readable message, and place five workers per row below the coordinator.

## Investigation

The reference uses a single 500ms glide to the pair. The extra close-up in the previous implementation was an intentional addition that produced the reported double jump; identical framing on reciprocal replies is now desired.

## Decision

`TrafficNodes.exchange` uses the existing interruptible camera glide to one `frameExchange` target. The target is centered between card centers, with symmetric bounds containing both cards and the entire obstacle-avoiding route. No destination or stopped-message zoom remains. Faster playback shortens the glide to its event interval. Follow recalculates on viewport resize using layout dimensions, so a BottomSheet entrance transform cannot distort the camera bounds.

`nodes-layout.ts` uses five columns, expanding to six above 24 active workers. Message labels remain outside the transformed scene with 13px subject text and 11px direction text; flight capsules retain their screen size.

Manual cancellation belongs in the initiating handler, before Fit/Focus starts its own glide. A later Follow-off effect would cancel that new movement as well.

## Risks

Distant pairs require smaller cards to fit both endpoints. The screen-sized message label stays readable, and explicit Focus remains available. A five-column overview uses smaller cards on narrow screens; pair framing and manual zoom remain available there.

## Alternatives considered

The two-stage camera was rejected by the user after live viewing. Moving the center to a detour or message would violate the requested pair-centered composition; symmetric bounds include detours without shifting that center.
