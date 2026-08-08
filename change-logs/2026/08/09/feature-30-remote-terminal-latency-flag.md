Short: Snappier terminal over remote

The terminal over remote access no longer holds a keystroke echo for a full frame before sending it, and it now throttles its send cadence instead of piling frames into a socket the tunnel cannot drain — so sustained output stops rendering smoothly but behind reality. Both behaviours ship behind the project's first PostHog feature flag, which refreshes about every five minutes without a restart.
