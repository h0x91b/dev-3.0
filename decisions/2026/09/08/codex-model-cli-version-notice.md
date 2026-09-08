# Codex model/CLI mismatch is a notice, not a gate

## Context

The default Codex preset (`codex-default`) pins `gpt-6-astra`. On a Codex CLI
that predates the model, the launch prints `Model metadata for 'gpt-6-astra' not
found`, reaches the API anyway, and dies on a 400 saying the model "requires a
newer version of Codex". Nothing in that chain mentions dev3 or the preset, so
the failure reads as an auth or config problem (issue #1667). dev3 already
probes `codex --version` for config syntax and never consulted it here.

## Investigation

The reporter observed failure on 0.144.4 and success on 0.153.4; neither is the
boundary. Bisecting `codex-rs/models-manager/models.json` through the openai/codex
contents API per release tag (2026-09-08) puts the model's first appearance at
`rust-v0.153.1` — `rust-v0.153.0` does not carry it. `model-provider-info/src/lib.rs`
gains it later still, between 0.153.1 and 0.153.4.

Two things stayed unverified and shaped the decision. The 400 is issued by the
API, which enforces a client-version floor of its own; probing it costs a paid
request, so whether 0.153.1–0.153.3 actually launch is untested. And the local
probe is cached for the app's lifetime, so a binary upgraded underneath a running
dev3 reports the old version.

## Decision

Requirements live in `src/shared/agent-model-cli-requirements.ts` as a
model → minimum-version map (`CODEX_MODEL_MIN_CLI_VERSION`), keyed on the MODEL
rather than on a preset so a hand-built preset with the same model is covered
identically. `evaluateCodexModelSupport` returns `too-old` only when both the
floor and the installed version are known.

`applyModelVersionNotice` (`src/bun/rpc-handlers/tmux-pty.ts`) wraps the launch
in `buildModelVersionGateWrapper` (`rpc-handlers/shared-pure.ts`) when the verdict
is `too-old`. The wrapper prints the mismatch, the floor and how to upgrade, waits
up to 20 seconds for a keypress, and then **runs the original launch unchanged**.

It is deliberately a notice and not a block: the failure being fixed is opacity,
and a stale probe or an untested 0.153.x must not be able to stop a launch that
would have worked. `launchModel` on `ResolvedAgentCommand` carries the model after
provider pinning and API-profile overrides, and is undefined under a third-party
backend or a routed model — the vendor's floor says nothing about those endpoints.

`src/bun/__tests__/agent-model-cli-requirements.test.ts` fails when a builtin
Codex preset names a model absent from the map, so adding a preset for a fresh
model forces its author to state the requirement (`null` is a valid answer).

## Risks

The floor may be too low if the API's own client gate is stricter than 0.153.1;
a user between 0.153.1 and 0.153.3 would then see the old opaque 400 with no
notice. Raising the entry is a one-line change. The 20-second wait delays an
unattended launch that hits the mismatch — bounded, and only on a mismatch.

## Alternatives considered

**Change the default preset off `gpt-6-astra`.** Downgrades the default for every
user to fix a minority's CLI.

**Substitute a compatible model automatically.** Produces a working agent, but a
silently different model is its own opaque failure.

**Block the launch outright** (the issue's option 1). A stale or wrong probe then
takes away a preset that works; nothing about the reported pain requires it.

**Pattern-match the upstream 400 in the pane** (the issue's option 2). Needs
terminal-output scanning dev3 does not do, and only fires after the pane dies.
