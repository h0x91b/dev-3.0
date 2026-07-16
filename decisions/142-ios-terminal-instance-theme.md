# iOS terminal instance theme

## Context

The native iOS chrome follows the device appearance, but each shared PTY belongs to a dev3 instance whose resolved theme also selects the Claude or Codex launch theme. Rendering that PTY with the phone appearance can mix a light default canvas with dark ANSI backgrounds from the instance-owned process.

## Investigation

Simulator QA reproduced the mixed canvas only with Light device appearance against a Dark instance; changing the same live view to Dark immediately restored a uniform terminal without replacing the PTY. `getGlobalSettings` already returns both `theme` and `resolvedTheme`, while `setTmuxTheme` applied changes without broadcasting the existing `globalSettingsUpdated` push.

## Decision

The iOS AppStore retains a provenance-checked instance terminal theme and updates it from refetches and typed live settings pushes. The terminal resolves valid `resolvedTheme`, then an explicit light or dark preference, then the backend default of dark; native chrome continues to use the device appearance.

## Risks

An older server that omits theme fields renders the terminal dark, matching the backend default but potentially differing from its native chrome. A settings fetch failure retains the last proven theme until a current-server refetch or push succeeds.

## Alternatives considered

Always-dark rendering was rejected because explicitly light instances must remain light. Porting a full ANSI-background filter was rejected because it would reinterpret application-owned terminal output and expand the fix beyond shared-PTY theme ownership.
