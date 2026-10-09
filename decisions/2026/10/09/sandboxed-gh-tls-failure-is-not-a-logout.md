# A sandboxed gh TLS failure is not a logout

## Context
On macOS, Go's `crypto/x509` verifies certificates through `trustd` over Mach IPC. Claude Code's seatbelt sandbox blocks `com.apple.trustd.agent` by default, so `gh` (and every Go binary) fails with `tls: failed to verify certificate: x509: OSStatus -26276` while curl and git work (h0x91b/dev-3.0#1925, upstream anthropics/claude-code#23416). Worse, `gh auth status` words that failure as "The token in keyring is invalid", and `dev3 pr` answered it with "Run `gh auth login`" — a dead end agents kept repeating.

## Investigation
Claude Code 2.1.295 ships `sandbox.enableWeakerNetworkIsolation`, which adds `(allow mach-lookup (global-name "com.apple.trustd.agent"))` to the profile; its own description calls it a security reduction (a possible exfiltration path through trustd), default off. dev3 does not own the sandbox profile, so the real fix stays upstream or is the user's opt-in.

## Decision
`requireAuthenticatedGh` in `src/cli/commands/pr.ts` classifies before blaming credentials: a TLS signature in `gh auth status`, or in one read-only `gh api user` probe when status failed without it, exits `CLI_EXIT_CODE_GH_TLS_UNVERIFIED` (28) with `GH_TLS_HINT`; a probe that succeeds proceeds; anything else stays exit 23. Post-push `gh` failures keep exit 1 but carry the same hint and are never retried. One sentence in `skillPrLinkInstruction` covers raw `gh` calls.

## Risks
The probe costs one extra gh call, only on the failure path. Detection is string matching on gh/Go error text, which could change wording upstream.

## Alternatives considered
Calling the GitHub API with curl (needs the token in dev3's hands — rejected); an automatic retry wrapper (the failure is environmental, and retrying writes with an uncertain outcome is unsafe); enabling `enableWeakerNetworkIsolation` or disabling the sandbox for gh from dev3 (weakens the user's security without their decision — rejected).
