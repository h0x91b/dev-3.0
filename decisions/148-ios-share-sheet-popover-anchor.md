# 148 — iOS share sheet needs an explicit popover anchor

## Context

A user on TestFlight crashed after tapping "share" on a review report inside a
task's "Your review" screen. `MediaShareSheet` (`ios/App/Features/Media/MediaShareSheet.swift`)
wraps `UIActivityViewController` in a `UIViewControllerRepresentable` presented via
SwiftUI `.sheet` from `TaskArtifactViewer` / `TaskImageLightbox`.

## Investigation

On iPad, UIKit presents `UIActivityViewController` as a popover and raises
`NSGenericException` ("you must provide location information for this popover")
unless its `popoverPresentationController` has a `sourceView`/`sourceRect` or
`barButtonItem`. SwiftUI's `.sheet` does not supply one. The code never set an
anchor. This could not be reproduced on the only installed simulator runtime
(iOS 26.5): that version coerces the wrapped controller to a sheet presentation,
so it presents cleanly on both iPhone and iPad. The crash surfaces on the older
iOS versions the app still supports (17/18), which is why the simulator masks it.
Verified via UI automation that the share flow works on iPhone and iPad on 26.5
both before and after the change.

## Decision

`configurePopoverAnchor(for:)` in `MediaShareSheet` now anchors the controller's
`popoverPresentationController` to the controller's own view, centered, with no
arrow — applied in both `makeUIViewController` and `updateUIViewController`. The
guard is a no-op when the controller is not presented as a popover, so iPhone and
newer iOS are unaffected.

## Risks

Low. When the presentation is not a popover, `popoverPresentationController` is
nil and the method returns early. Anchoring to a centered, arrow-less rect only
changes iPad popover placement, which is invisible because `.sheet` presents it
as a centered card anyway.

## Alternatives considered

- Replace the UIKit bridge with SwiftUI's native `ShareLink` (as `DiagnosticsView`
  uses): cleaner and handles the popover automatically, but `ShareLink` is a
  declarative button and the artifact/image bytes are fetched asynchronously after
  the tap, so it does not fit the current load-then-share flow without a larger
  rewrite. Deferred.
- Present `UIActivityViewController` imperatively from the top-most view
  controller: more code and more state to manage than anchoring the existing
  controller.
