# No-device TestFlight cloud export

## Context

Creating a conventionally signed iOS archive can require development provisioning and a registered device even though TestFlight needs a distribution-signed IPA. The release workflow must be runnable by an agent on a Mac with the owner's Xcode account but no connected or registered iPhone.

## Investigation

Xcode 26.6 successfully exports an unsigned `iphoneos` arm64 archive with automatic `app-store-connect` signing when `destination=export` and `-allowProvisioningUpdates` are supplied. The resulting app uses a cloud-managed Apple Distribution certificate and omits `keychain-access-groups` when the source entitlements are empty, while retaining the app identifier as the effective default Keychain group.

## Decision

`ios/scripts/archive-testflight.sh` builds and validates an unsigned device archive, then optionally asks Xcode to cloud-sign a local IPA without uploading it. Post-export checks cover safe expansion, artifact cardinality, bundle metadata and privacy reasons, platform and architecture, required distribution entitlements, and the effective default Keychain group allowed by the decoded Store profile, plus the distribution summary, signature, and dSYM; sensitive `Packaging.log` and decoded-profile copies are removed.

## Risks

`-allowProvisioningUpdates` may create or refresh App IDs, certificates, and profiles, so it remains an explicit command-line opt-in. The workflow depends on Xcode's export behavior and therefore fails closed if certificate type, entitlement shape, platform, architecture, or output structure changes.

## Alternatives considered

A development-signed archive preserves the traditional flow but reintroduces the registered-device and local-signing dependency. Requiring an explicit Keychain group would change the app's capability surface only to satisfy a validation assumption, while a manual Organizer-only flow would leave the release artifact and its invariants unverified.
