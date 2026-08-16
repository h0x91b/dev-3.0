Short: Build with telemetry off

A build-time `VITE_TELEMETRY` flag can turn every analytics channel off. Setting `VITE_TELEMETRY=off` in the root `.env` compiles out the Google Analytics hits, the public-IP lookup that geolocates them, and the PostHog client, leaving feature flags on their shipped defaults. Unset still means on, so released builds and existing local builds behave exactly as before.
