# Bound Codex startup probes

## Context

Two desktop launches stopped logging between Claude and Codex trust preparation while the UI remained on Connecting. The original incident's exact blocking instruction could not be sampled; `codex --version` was an unbounded synchronous operation in that interval, and two sibling `--help` probes had the same failure mode.

## Investigation

A delayed binary through the real version probe prevented every heartbeat tick for 2,245 ms before this change. With the asynchronous implementation, a nonresponsive binary returns unknown after 2,004 ms while 95 heartbeat ticks run; the deadline also covers pipes held open after child exit. See `docs/investigations/2026-09-12-ui-connecting.md` for incident evidence and its limits.

## Decision

`src/bun/codex-config.ts` shares pending version/help probes across startup and launch, drains both streams concurrently, and races the entire operation against a two-second deadline. Failure kills the child with SIGKILL and cancels readers without awaiting their completion; unknown versions skip version-dependent config writes. Launch command assembly and skill installation propagate asynchronous completion through callers.

## Risks

An overloaded or broken executable can exceed the deadline; existing config is retained and help detection uses its existing fallback. Results, including failure, are cached for the process lifetime, matching the previous launch-cache policy; restarting retries detection. Other external commands still need separate deadline audits.

## Alternatives considered

A synchronous timeout still blocks all RPC and heartbeat work for its duration. Racing only child exit leaves inherited output pipes unbounded, and assuming a legacy version on timeout can rewrite a modern configuration incorrectly.
