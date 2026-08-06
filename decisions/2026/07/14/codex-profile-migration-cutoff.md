# 129 — Gate Codex profile-file migration at 0.134.0

## Context
Codex 0.134.0 rejects legacy `profile = "dev3-*"` selectors and `[profiles.dev3-*]` tables in the main config when dev3 launches a named profile. Dev3 already has a per-profile-file migration, but its version cutoff was too old and startup could fail to find Codex from an app-bundle PATH.

## Investigation
The upstream rejection landed in the 0.134.0 release line, while dev3's existing cutoff was 0.131. The startup path installed skills and patched Codex before resolving the user's shell environment, so `codex --version` could return no version and incorrectly select the legacy writer.

## Decision
Keep the existing version-gated migration, but set its profile-file cutoff to 0.134.0. Remove the complete managed dev3 profile namespace, including nested tables, from the main config on that branch; write the three per-profile files as before. Defer the startup config pass until shell PATH resolution completes, while preserving the direct install-skills path for callers that already have a normal PATH.

## Risks
Unknown or unavailable Codex versions still use the legacy fallback to avoid writing files unsupported by older installations. A missing PATH export can therefore postpone migration until a later trust/config pass, but it will not make the app write the modern format blindly.

## Alternatives considered
Always writing per-profile files was rejected because older Codex versions do not load them. Keeping the 0.131 cutoff was rejected because Codex 0.134 is the first release that enforces the legacy-config rejection relevant to the current launch flag. Running the probe before shell resolution was rejected because app bundles inherit a minimal PATH.
