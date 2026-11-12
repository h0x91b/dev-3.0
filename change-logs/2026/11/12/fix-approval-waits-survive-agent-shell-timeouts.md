Agents waiting on a completion, cancellation, launch or hibernate approval no longer lose their shell call to a timeout: opencode and other generic-family agents are told to give those calls a 15-minute timeout, and the CLI prints a "still waiting" line every minute so Gemini CLI's 300-second silence limit does not kill it.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2263)
