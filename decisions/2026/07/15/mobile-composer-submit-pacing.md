# Context

The mobile composer previously sent prompt text through `TerminalHandle.paste()` and immediately followed it with two carriage returns. Codex can classify an unbracketed fast paste as a burst and treat both returns as pasted newlines, leaving the prompt unsent.

# Investigation

`ghostty-web` only emits DEC 2004 bracketed-paste markers when its terminal state says the application enabled that mode. Codex's paste-burst state keeps Enter in newline mode for a 120 ms suppression window; the existing composer test also exposed the fragile two-call transport contract.

# Decision

Add `TerminalHandle.submit()` backed by `submitPastedText()` in `src/mainview/terminal-submit.ts`. Submit immediately after bracketed paste, otherwise wait 150 ms after the paste before sending exactly one carriage return; keep `paste()` unchanged for Insert and raw key controls.

# Risks

The fallback adds a small delay only when DEC 2004 is not observed, and a closed terminal may discard the delayed Enter. The delayed path is intentionally safer than sending raw bracketed markers to an application that did not advertise the mode.

# Alternatives considered

Sending a second or modified Enter was rejected because it remains timing-dependent and can be interpreted as another newline by Codex. Forcing bracketed-paste escape markers was rejected because the composer also serves shells and agents that may not have enabled DEC 2004.
