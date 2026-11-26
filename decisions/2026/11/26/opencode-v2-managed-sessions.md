# Context

OpenCode V2's root TUI refuses `--model`, `--agent` and `--prompt`, and dev3 had no way to learn an OpenCode `ses_…` ID, so it could neither launch V2 with a preset's model nor resume a pane's exact conversation. V1 users must keep today's CLI behavior.

# Investigation

The V2 server API creates a session with `agent` and `model { providerID, id, variant }`, then accepts the first prompt separately; a TUI started with `--server <url> --session <id>` attaches to it without replaying anything. The server, not the TUI, runs the agent's tools. Electrobun's `before-quit` emitter decides synchronously and does not await async listeners.

# Decision

`CodingAgent.opencodeProtocol` (unset = V1) selects the transport for every preset of that agent: a CLI's protocol is a property of the agent, not of a model preset. For V2, `src/bun/opencode-server.ts` starts one password-protected `opencode serve` on loopback per pane session, with the full task env, creates or validates the session, and returns the TUI command. Callers record the session against an exact pane (tmux `%N` or the native sidecar) and only then call `startOpenCodePrompt`, which sends the brief once; behind a setup wrapper it waits for the setup success marker. Any failure before that rolls the pane and server back. Servers stop with their pane, task, terminal restart and app quit, and a stop counts only once the process group is verified gone (`terminatePidsVerified`); until then ownership is kept and new launches for the task are refused. `src/bun/verified-quit.ts` vetoes quit synchronously and retries it after verified cleanup, before any live-app service is stopped.

# Risks

A hard crash of dev3 leaves its servers running with no owner to stop them; crash recovery is out of scope. If a rollback cannot confirm cleanup, the attempted session binding is kept so a later cleanup can find the server, and quit stays blocked until termination is verified.

# Alternatives considered

`opencode mini` still takes `--model`/`--prompt` but is not the full TUI. Capturing the ID from a Codex-style hook or resuming "latest" cannot tell sibling panes apart. A per-preset protocol would let presets of one CLI disagree on how it is launched, and making V2 the default would silently change existing agents.
