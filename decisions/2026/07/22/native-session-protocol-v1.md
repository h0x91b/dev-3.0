# 154 — Native-session transport protocol v1 (frozen)

## Context

Seq 1216 (parent 1141, tmux-removal roadmap) freezes the wire behaviour of the
isolated native-session registry (decision 151) as a deliberately small **local**
protocol v1. The registry's loopback-TCP WebSocket already carried versioned JSON
control frames, but had no explicit handshake, no way to return a version
rejection (a mismatched frame was silently dropped), no request/response
correlation, and no error shape. This is not a generic RPC framework, auth
system, or capability-negotiation platform — the token merely preserves the
protection a tmux Unix socket got from filesystem permissions.

## Decision

In `src/bun/native-terminal-registry/protocol.ts` (pure, vitest-tested) plus thin
host/client adapters:

- **Hello handshake.** The client's first frame is `hello{v, sessionId, id}`,
  parsed version-agnostically (`decodeHello`) so the host can answer a foreign
  version. `evaluateHello` returns `welcome` on a v1/session match, else one
  explicit `error` (`bad-request`/`version-mismatch`/`not-found`); the host sends
  it and closes only that socket, leaving host + shell + other clients alive.
- **Request `id` only on correlated pairs** — `hello→welcome`, `status→status`.
  `resize`/`stop` are fire-and-forget; `stopping`/`exit` are unsolicited events.
- **One compact `error{v, type, code, id?, message?}`** with codes `bad-request`,
  `unauthorized` (HTTP 401 at upgrade), `version-mismatch`, `not-found`,
  `conflict` (a second hello), `internal-error` (caught throw). Nothing
  speculative.
- **Robust rejection.** Oversized TEXT frames (`> MAX_CONTROL_FRAME_BYTES`),
  malformed frames, bad tokens, and unsupported versions are rejected without
  crashing, mutating registry state, or killing the host/shell. Additive unknown
  fields on a known type are ignored.
- **Token check unchanged.** Still `?token=` → HTTP 401; no accounts/roles/refresh.

## Risks

The `hello`/`welcome`/`error` frames are wire-only, so they touch neither
`record.json` nor the frozen `~/.dev3.0/` layout (AGENTS.md invariants). The
module stays out of the production import graph (guarded by `isolation.test.ts`)
and never touches tmux, so production terminal flows are unaffected. The only
behavioural change to an existing consumer is that `connect()` now blocks on the
handshake — bounded by the connect timeout.

## Rule for a future breaking change

Bump `NATIVE_SESSION_PROTOCOL_VERSION` and handle the new number explicitly. Never
negotiate a major/minor in-band, add capability discovery, generate schemas, or
silently reinterpret a foreign version — a mismatched client always receives
exactly one `version-mismatch` error and the host stays alive.

## Alternatives considered

Keeping only the per-message `v` gate was rejected: it silently drops a mismatched
frame and cannot return the explicit version-mismatch the ticket requires.
HTTP-subprotocol / header negotiation at upgrade was rejected as capability
negotiation, explicitly out of scope. A generic request/response bus with ids on
every frame was rejected — ids belong only where a reply must be correlated.
