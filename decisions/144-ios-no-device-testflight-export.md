# No-device TestFlight cloud export

## Context

Creating a conventionally signed iOS archive can require development provisioning and a registered device even though TestFlight needs a distribution-signed IPA. The release workflow must be runnable by an agent on a Mac with the owner's Xcode account but no connected or registered iPhone.

## Investigation

Xcode 26.6 successfully exports an unsigned `iphoneos` arm64 archive with automatic `app-store-connect` signing when `destination=export` and `-allowProvisioningUpdates` are supplied. The resulting app uses a cloud-managed Apple Distribution certificate and omits `keychain-access-groups` when the source entitlements are empty, while retaining the app identifier as the effective default Keychain group. The unsigned archive intentionally has empty `Team` and `SigningIdentity` metadata, so Organizer rejects it even though Xcode's `destination=upload` path can cloud-sign and send it directly. The account owner confirmed that the app implements none of Apple's listed encryption algorithms and relies only on OS-provided HTTPS/WSS/TLS and Keychain services.

## Decision

`ios/App/Info.plist` declares `ITSAppUsesNonExemptEncryption=false`, and `ios/scripts/archive-testflight.sh` fails closed unless that value remains false in the source and every available built artifact. The script builds and validates an unsigned device archive, then requires an explicit choice between a fully validated local IPA and direct App Store Connect upload. Only `--archive-and-upload` sets `destination=upload`; existing modes remain local or inspection-only. Post-export checks cover safe expansion, artifact cardinality, bundle metadata and privacy reasons, platform and architecture, required distribution entitlements, the effective default Keychain group, distribution summary, signature, and dSYM; sensitive `Packaging.log` and decoded-profile copies are removed.

## Risks

`-allowProvisioningUpdates` may create or refresh App IDs, certificates, and profiles, so it remains an explicit command-line opt-in. Direct upload is an external side effect and therefore has a separate mode whose name states that action; it cannot provide the local post-signing inspection available in export mode. The export-compliance declaration must be reassessed before release if the app starts implementing encryption instead of relying solely on Apple-provided services. The workflow depends on Xcode's distribution behavior and fails closed if encryption metadata, certificate type, entitlement shape, platform, architecture, or output structure changes.

## Alternatives considered

A development-signed archive preserves the traditional flow but reintroduces the registered-device and local-signing dependency. Reconstructing a signed archive from the exported IPA can satisfy Xcode's distribution engine, but it is undocumented, signs twice, and is not the production handoff. Answering the same export-compliance questions after every upload would discard a stable, owner-confirmed property that can be enforced in release metadata. Requiring an explicit Keychain group would change the app's capability surface only to satisfy a validation assumption.
