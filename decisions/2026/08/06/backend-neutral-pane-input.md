# 201 — Backend-neutral pane input: at-most-once with honest verdicts

## Context

tmux lets any process `send-keys` into a pane it does not render; the native backend had no
equivalent, and the agent-prompt path cannot express it because it picks the pane and adds
agent semantics. Terminal workflows need to name a pane and send exact input.

## Investigation

A PTY can accept bytes and lose the reply, so cross-process exactly-once is unachievable,
and native cannot prove a write at all: `write` is `void` and input frames carry no
correlation id. Pane ids and OS pids are both recycled, on both backends.

## Decision

One neutral vocabulary (`src/shared/pane-input.ts`), one entry point deriving routing from
the task (`src/bun/pane-input.ts`), and one schema deciding which reason is legal on which
verdict. Identity is strict: native pins both pids plus their registry start signatures from
the record the socket DIALLED, and tmux pins the session name plus a server generation token
read in the SAME sighting as the pane, its liveness and its copy-mode state. Pinning only
observes, one stage is one backend operation, and nothing here claims a lease or attaches a
client. Retrying means a new delivery id; `attempt` above 1 is a probe that never executes.

Scope, so the boundary is not re-argued: the seam owns deliveries whose caller ACTS on the
outcome — a prompt typed into an agent, and anything that reports success or failure back to
a user or another process. The raw `tmux.sendKeys` primitive keeps the rest and is not
deprecated: the interactive keystroke stream (`terminal-backend/tmux-port.ts` `writePane`),
cursor nudges like alt-click, and test harnesses. Those have no reader for a verdict, and a
per-keystroke pin, deadline and ledger record would only cost latency.

Stated rather than glossed: the TMUX arm has a production consumer (agent prompts), the
NATIVE arm has none, and `agent-prompt-native.ts` remains the native delivery
implementation. Two native paths is a real cost. It is not a deprecated stub — nothing is
kept alive for unmigrated callers — but it is unresolved, because the seam's native arm
refuses two cases that agent-prompt handles (it never attaches a binding, and never claims a
vacant writer lease), and whether an out-of-sight delivery may mutate writer ownership is a
design question, not a refactor. Convergence is tasked separately and lands one of: the
native arm gains bind-on-demand and vacant-claim, or it is deleted as unreachable.

## Risks

Native never returns `delivered` until its host can acknowledge input, and tmux `delivered`
means the server took the keys rather than that the pane's program read them — a pane in copy
mode fails the guard outright and reports `incarnation-changed`, so the first consumer must
exit copy mode before pinning instead of retrying. At-most-once holds within one executor
process, one pinned incarnation and the retention window; a stale `attempt: 1` after eviction
may execute. Ledger quarantine guards the native path, while on tmux the server serializes
commands across clients instead. The ledger's per-pane queue cleanup is deliberately not
pinned by a test: a stale resolved tail changes nothing a caller can observe, growth is
bounded by concurrently active panes rather than by total deliveries, and the only pin
available would be a test-only accessor on the production surface.

## Alternatives considered

Extending `terminal-backend/contract.ts` was impossible (single-process, single-view, no
lease concept), and a second cross-process routing model was rejected in favour of the
existing one. A hash as the dedup identity fails on collisions; an OS pid as either
backend's identity fails on recycling; a `pause` step invited a suffix to continue on a
newly resolved owner.
