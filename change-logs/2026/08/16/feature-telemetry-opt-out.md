Short: Build with telemetry off

A build-time `VITE_TELEMETRY` flag can turn every analytics channel off. Setting `VITE_TELEMETRY=off` (or `false`, `0`, `no`) in the root `.env` stops the Google Analytics hits, the public-IP lookup that geolocates them, and the PostHog client from running, leaving feature flags on their shipped defaults; crash logging to the local log file keeps working. Unset still means on, so released builds and existing local builds behave exactly as before.
