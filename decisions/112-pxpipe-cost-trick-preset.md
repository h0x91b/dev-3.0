# 112 — pxpipe "cost trick" preset + token-saving proxy panel

## Context

The pxpipe project (github.com/teamchong/pxpipe, `npx pxpipe-proxy`) is a local proxy that
renders bulky LLM context (system prompt, tool docs, old history) into dense PNGs to cut input
tokens — ~3.1 chars/image-token vs 1 char/text-token, claimed ~59–70% bill cut, and it works
best with Fable 5. We wanted a first-class dev3 way to launch Claude through it.

## Investigation

Verified on npm/GitHub: the package is real and active (MIT, teamchong), Fable 5 is its
best-supported model. Two hard caveats drove the design: (1) it is **lossy** — the author
documents silent confabulations on exact strings (IDs/hashes/code identifiers), dangerous for a
coding agent; (2) an early version was deprecated with "token-savings were overstated
(baseline-accounting bug)", so the savings claim is not to be trusted blindly. Conclusion:
ship it, but opt-in, clearly experimental, and off by default.

## Decision

- New `AgentConfiguration.requiresPxpipeProxy` flag + a `claude-fable5-cost-trick` preset in
  `DEFAULT_AGENTS` (`src/shared/types.ts`) that sets `ANTHROPIC_BASE_URL` to
  `http://127.0.0.1:47821` (`PXPIPE_PROXY_PORT`/`PXPIPE_PROXY_BASE_URL` constants). Existing
  `config.envVars` plumbing carries the URL to the spawned `claude` (no `agents.ts` change).
- Gate = `GlobalSettings.pxpipeProxyEnabled` (default off). The preset is its own **Model**
  group (`groupLabel: "Fable 5 (cost trick)"`) so it reads as a distinct model choice, while its
  Mode derives normally (`Auto · Medium`). That whole Model group is always **shown** in the
  Provider→Model→Mode picker but rendered **disabled** until enabled; clicking the disabled Model
  option fires a clickable toast that deep-links (via the `OPEN_SETTINGS_SECTION_EVENT` window
  event + `Route.section`) to the new settings section. `Select` gained `disabled` options +
  `onOptionDisabledClick`; `agentPicker.groupRequiresPxpipeProxy` decides which Model group is
  gated.
- Backend `src/bun/rpc-handlers/pxpipe-proxy.ts` (status/start/stop): `resolveBinaryPath`-style
  `which npx` check, port-47821 owner detection via `port-scanner` (`findPortHolders` +
  `getDescendantPids` to tell our managed pid/descendants from a foreign squatter), detached
  `npx -y pxpipe-proxy` spawn, pidfile at `~/.dev3.0/pxpipe-proxy.pid` (additive — no on-disk
  layout violation). Start is non-blocking (first `npx` run downloads the package); the UI
  polls status to observe `starting → running`.
- New Global Settings section `PxpipeProxySettingsSection` with the master toggle, an
  experimental callout, live status (npx / port owner / running / foreign conflict), Start/Stop,
  and a credit link to github.com/teamchong/pxpipe. The dashboard link lives **inside** the
  status block and only while `running` — it targets the fixed proxy port, so it is dead until
  the proxy is up.
- User-facing copy is deliberately framed around **speed and cost** (slower, but typically ~2×
  cheaper, accuracy virtually unchanged) rather than the lossy caveat below — the observed
  accuracy drop is negligible in practice, and the earlier "trades accuracy for tokens" wording
  read as more alarming than the reality warrants.

## Risks

- Lossy proxy can silently corrupt exact strings in code — mitigated by off-by-default +
  prominent warning, not by code. Users opt in knowingly.
- The proxy is a child of the app process (dies on app quit); status simply shows stopped and
  the user restarts. No auto-start.
- Third-party unaudited local proxy sees all Anthropic traffic (local-only, 127.0.0.1) — noted
  in the warning; acceptable for an opt-in experiment.

## Alternatives considered

- **Preset only, user runs the proxy manually** — rejected: no npx/port feedback, poor UX.
- **Auto-start the proxy when the preset is selected** — rejected: hides a heavy/experimental
  dependency behind a launch; explicit Settings control is safer.
- **Hide the preset until enabled** — rejected: the user explicitly wanted it discoverable, so
  it stays visible-but-disabled with a link to enable it.
