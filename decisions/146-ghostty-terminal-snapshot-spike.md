# 146 — Ghostty-compatible terminal snapshot spike

## Context

The tmux-removal roadmap needs proof that raw PTY output can preserve enough
headless terminal state for a fresh renderer after reconnect, without changing
the production terminal path. The spike must cover buffer semantics, Unicode,
resize history, real terminal output, and bounded cost measurements while
remaining disposable.

## Investigation

`ghostty-web` exposes the renderer's DOM-free Ghostty core and semantic reads but
no state export/import; an ordered byte/resize journal therefore gives exact but
unbounded replay. Xterm headless plus serialize and grapheme addons produced a
compact ANSI snapshot, but differential replay changed Ghostty's shrink/grow
history, so matching ordinary cells was insufficient; the full comparison and
costs are in `src/bun/prototypes/terminal-state/README.md`.

## Decision

Select Ghostty for parser compatibility and keep version 1 as an isolated,
fail-closed event journal tagged `ghostty-web@0.4.0`; binary output is base64 and
resize order is explicit, and creation asserts that the installed package still
matches that identity. Do not persist or promote version 1: production work
requires a bounded Ghostty-native export/import seam and a new format version
with a stated compatibility window. Removal is deletion of the prototype
directory and its two package scripts; no daemon, migration, user state, or tmux
cleanup exists.

## Risks

Journal bytes and replay latency grow with session lifetime, while per-client
memory is inflated because the probe isolates each raw terminal in a separate
WASM instance after shared-instance create/free churn corrupted grapheme reads.
Windows Bun 1.3.14 also returned a negative allocation pointer when Ghostty ran
inside the PTY capture callback, so raw capture no longer instantiates the
parser; terminal-query responses are an explicit TUI-only option. Metadata
coverage is intentionally incomplete, and the spike omits transport ordering,
backpressure, privacy, compression, integrity, images, and rich shell metadata.

## Alternatives considered

Xterm headless serialization was rejected because renderer-incompatible resize
semantics outweigh its compact format. A custom VT parser was rejected because
dev3 would own alternate-screen, Unicode-width, and escape-sequence parity;
direct `libghostty-vt` export/import remains the preferred follow-up once a
stable bounded API is available.
