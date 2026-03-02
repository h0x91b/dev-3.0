# 009 — XProtect Kills Unsigned PR Builds

## Context

PR build DMGs started producing broken `.app` bundles — the `launcher` binary in `Contents/MacOS/` was silently missing, making the app unlaunchable.

## Investigation

- macOS Sequoia's XProtect received a signature update that flags Electrobun's `extractor` binary (which becomes `Contents/MacOS/launcher` in the app bundle).
- XProtect silently deletes the binary within ~1 second of it being written to disk. No UI, no logs, no warnings.
- Only the `extractor` is affected — other binaries (`bun`, `bsdiff`, etc.) survive because they carry real Developer ID signatures.
- Tested every copy method (`cp`, `ditto`, `rsync`, `cat >`, `Bun.write`, `strip`, `codesign --sign -`) — all fail. Content-based detection, not hash-based.
- Files inside mounted DMG volumes are immune to XProtect scanning.
- Release builds are unaffected because they use real Developer ID code signing + notarization.

## Decision

Removed PR nightly builds entirely. The PR CI workflow now only runs type checking (`bun run lint`), tests (`bun run test`), and a Vite build check to catch syntax errors. Full signed builds remain in the release workflow where code signing prevents XProtect interference.

## Risks

- No downloadable PR artifacts for manual QA. Acceptable tradeoff — release builds work, and PR validation still catches code errors.
- If Electrobun properly signs their `extractor` binary in the future, PR builds could be restored.

## Alternatives considered

- **DMG injection workaround** (`fix-dmg.ts`): Writing the launcher inside a mounted DMG works for the build, but XProtect deletes it again when the user copies the app from DMG to `/Applications`.
- **Ad-hoc codesigning**: Doesn't help — XProtect still flags the binary.
- **Adding Developer ID signing to PR builds**: Increases attack surface for PRs from forks and adds complexity for no significant benefit.
