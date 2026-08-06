# Mobile portrait orientation gate

## Context

The phone UI is designed around narrow portrait viewports, but rotating a phone to landscape exposes the dense desktop header and toolbar. That layout is not usable on the remote/mobile form factor.

## Investigation

The existing `useMobile()` device-class signal is distinct from the reactive `<768px` layout signal, so a landscape phone can cross the narrow layout breakpoint. The standard Screen Orientation API is limited and may reject locks outside fullscreen, requiring an in-app fallback.

## Decision

Use `usePortraitOrientation()` to attempt `screen.orientation.lock("portrait")` on mobile, fullscreen transitions, and user gestures. `MobilePortraitGate` renders a localized blocking prompt and marks the underlying app inert whenever a mobile viewport remains in landscape; desktop windows are unaffected.

## Risks

Unsupported browsers will require the user to rotate manually, and a rejected lock may leave the prompt visible until the viewport becomes portrait. The gate is intentionally non-dismissible because the landscape UI is not a supported mobile state.

## Alternatives considered

Rotating the desktop layout with CSS was rejected because it creates incorrect input and hit-target geometry. A settings toggle was rejected because portrait is a device constraint, not durable user configuration; relying only on `screen.orientation.lock()` was rejected because the API is not universally available or permitted.
