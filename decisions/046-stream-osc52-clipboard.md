# 046 — Buffer OSC 52 clipboard sequences across PTY chunks

## Context

Long terminal selections can produce OSC 52 clipboard payloads that are larger than a single PTY data chunk. `pty-server.ts` previously parsed OSC 52 with a per-chunk regex, so split payloads were forwarded as ordinary terminal output and never reached the clipboard callback.

## Investigation

Short selections worked because tmux emitted the complete OSC 52 sequence in one callback. Drag-selecting through scrollback, especially in Home Terminal, made the base64 payload large enough to split before the BEL/ST terminator, so `handleOsc52` saw only fragments.

## Decision

`src/bun/pty-server.ts` now keeps a per-session `osc52Buffer`, waits until a full OSC 52 sequence is available, then decodes it and strips it from the output stream. `src/mainview/TerminalView.tsx` also sends native ghostty selections through a backend clipboard RPC so WKWebView clipboard permission quirks are not the only copy path.

## Risks

Malformed OSC 52 sequences without a terminator stay buffered until more PTY data arrives. This mirrors the existing UTF-8 streaming decoder trade-off: correctness for split control sequences is more important than immediately flushing a broken sequence to the terminal.

## Alternatives considered

Re-adding tmux `copy-pipe-and-cancel "pbcopy"` bindings was rejected because it duplicates the server-side clipboard abstraction and is macOS-specific. Relying only on `navigator.clipboard.writeText()` was also rejected because Electrobun's WKWebView can reject it outside a direct user activation.
