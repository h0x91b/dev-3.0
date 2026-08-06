# 155 — Live Ghostty parsing outside the Bun.Terminal callback

## Context

The tmux-removal roadmap (STATE-005, seq 1228) needs the isolated native-session
host to maintain real terminal screen state while Bun.Terminal streams output.
Seq 1185 showed that running Ghostty WASM inside a Bun.Terminal data callback on
native Windows Bun 1.3.14 returns a negative WASM allocation pointer (decision
146), so the spike kept raw capture parser-free and answered TUI queries with a
static responder.

## Investigation

`regression-probe.ts` preserves the failing shape (parser created up front,
`ingest()` + `readResponses()` inside the callback) as runnable evidence, and
runs the same workload through the deferred pipeline. The deferred path is clean
on macOS/Linux/Windows CI; the callback path remains the expected Windows repro.
A real-TUI matrix (pwsh 7, Neovim, Claude, Codex) through the live host showed
semantic reconstruction equality with a fresh-core ground-truth replay, ~1 ms
p95 drain latency, and Neovim's startup DSR queries answered live by the parser.

## Decision

The host's data callback performs only bounded work: journal record, client
fanout, and a byte-capped enqueue into `ParserEventQueue`; `LiveParserPipeline`
(`live-parser.ts`) drains the queue on a scheduled event-loop macrotask — the
only place Ghostty runs — and writes parser-generated replies (DSR/DA/mode)
back to the same PTY. Replies are PTY *input* while the parser only sees PTY
*output*, so no feedback loop exists; Ghostty emits one reply per query
(exactly-once asserted in unit tests and E2E). Memory is bounded end to end:
queue byte/event caps with explicit drop accounting, a fixed-scrollback Ghostty
core, a capped-scrollback snapshot (`parser-state.json`, atomic + fail-closed
versioned), and the existing 256 KiB journal. The first dropped chunk flips the
pipeline to a terminal `overflowed` verdict (parsing stops, last good state
kept) instead of silently rendering a corrupt screen; any parser error flips it
to `failed` while the host keeps serving raw bytes. Everything is opt-in via
`DEV3_NATIVE_SESSION_LIVE_PARSER=1`; protocol v1 and default host behavior are
byte-identical.

## Risks

On Windows, ConPTY (conhost) is itself a terminal emulator: it answers DSR
queries from the app directly, owns the title, and re-renders the alt screen
into the primary buffer instead of forwarding `?1049`. The parser mirrors
whatever ConPTY emits, so Windows checks assert ConPTY-translated semantics
(exactly-once replies hold on both platforms — query/answer paths are
disjoint). Overflow and failure are terminal states with no resynchronization —
recovery is STATE-006. The ground-truth stream tap is unbounded and therefore proof-only
(env-gated, never default). Host RSS with the WASM core measured ~86–129 MB in
the macOS matrix; Windows budgets are recorded in `LIVE-PARSER-MATRIX.md` and
must be revisited before any multi-session production shape.

## Alternatives considered

Parsing directly in the callback — the reproduced Bun 1.3.14 Windows failure.
Keeping the spike's static query responder — answers only a fixed probe set and
diverges from renderer semantics, while Ghostty answers whatever it parses.
Reconstruction by replaying the bounded journal tail — a trimmed byte tail cuts
mid-escape-sequence and loses setup state, so the semantic snapshot is the
reconstruction path instead.
