# 181 — Artifact CDN availability over SRI fail-closed

## Context

The artifact starter pinned cdnjs payload bytes with Subresource Integrity. In practice, a provider re-serving semantically equivalent bytes caused otherwise valid charts and controls to fail completely, which made the report format less reliable for users and agents.

## Investigation

The artifact's security boundary is the opaque-origin iframe with `sandbox="allow-scripts"`; CDN code can read the report it powers but cannot reach the dev3 application, cookies, or local files. SRI therefore protected artifact content at the cost of a brittle exact-byte contract, while exact versions in CDN URLs already keep the authoring API stable.

## Decision

Artifact templates keep exact library versions in their cdnjs URLs and omit `integrity` and `crossorigin` attributes. `AUTHORING.md` tells agents not to add integrity hashes, and offline fallbacks remain required for every CDN-backed control.

## Risks

A compromised CDN payload can read or transmit the artifact's own content and make network requests allowed by the artifact CSP. The iframe sandbox still prevents access to dev3 state; reports requiring stronger provenance should bundle reviewed local assets instead of loading a CDN.

## Alternatives considered

Keeping SRI was rejected because exact-byte drift repeatedly disabled reports. Inlining or app-vendoring every library would restore offline provenance but increase bundle size and pipeline complexity; that remains a separate future option.
