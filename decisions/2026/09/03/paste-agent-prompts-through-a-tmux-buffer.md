# Paste agent prompts through a tmux buffer instead of typing them

## Context

Long `dev3 message` sends between two tasks arrived at the receiving agent with the
BEGINNING missing — the message started mid-sentence — four times in one session on
multi-paragraph bodies of roughly 1 500 characters and up. Losing the head is the worst
half to lose: the ask is at the top and the sign-off at the bottom, so the receiver keeps
the pleasantries and loses the instruction. Worse, the gap does not look like corruption:
one receiving agent filled it with a plausible, adjacent, and wrong mechanism and only
avoided writing that into a documentation change because it stopped to ask.

## Investigation

Measured on tmux 3.6a and Claude Code 2.1.258, bottom up.

1. **tmux → PTY is clean.** A raw-mode reader (`stty raw -echo; cat > file`) received
   `send-keys -H` payloads of 512, 1 500, 2 500, 3 500, 4 500 and 4 900 bytes byte-for-byte
   identical, every time.
2. **The JS layer receives everything too, but in pieces.** A Node script with
   `setRawMode(true)` got every byte — arriving as **1 022-byte chunks**: 1 500 bytes came
   as `[1022, 478]`, 4 500 bytes as `[1022, 1022, 1022, 1022, 412]`.
3. **The receiving CLI slices those chunks into separate pastes.** Sending a 3 163-byte
   envelope into a real `claude` pane with `send-keys -H` left the input box holding
   `[Pasted text #1 +10 lines][Pasted text #2 +6 lines][Pasted text #3 +8 lines]` — three
   independent pastes for one message. Nothing is lost when all three register; when one
   does not, a whole coherent chunk disappears and what remains starts mid-sentence.
4. **Bracketed paste collapses it to one.** The same payload wrapped in `ESC [200~` /
   `ESC [201~` produced a single `[Pasted text #1 +27 lines]`, head intact.

## Decision

`TmuxClient.sendKeysGuarded` no longer types literal text. Each literal chunk is loaded
into its own `set-buffer -b dev3-paste-<uuid> -- <text>` (argv, so no quoting and no hex)
and the guarded command list pastes it with `paste-buffer -d -p -b <name> -t <pane>`.
`-p` wraps the payload in bracketed paste **only when the running app asked for DEC 2004**,
so an agent CLI takes one message as one atomic paste while a plain shell still receives
plain text. Key steps still go through `send-keys`, and the guard, the marker and the
verdicts are untouched.

Buffer names are per-send because tmux buffers are server-wide; `-d` drops the buffer on a
successful paste and a `finally` deletes anything a refused guard left behind, so a message
body never lingers where `show-buffer` can read it. That cleanup is deliberately not
awaited — it must not extend a send that is already hanging.

`AGENT_MESSAGE_RECEIPT_THRESHOLD_BYTES` drops from 1 500 to 512. The old number came from
where the field reports started, not from where the risk starts: body plus envelope crosses
the first ~1 KB chunk boundary near 600 bytes, and two of the four reported losses were
under 1 500, so they arrived mangled with no `<full-copy>` path back to the text.

Verified end to end through the patched client: `sendKeysGuarded` driving a real tmux pane
running real Claude Code delivered a 3 163-byte envelope whole, the agent echoed its first
40 characters, and no `dev3-paste-*` buffer was left on the server. A send whose guard was
refused (stale server token) put zero bytes in the pane and left no buffer behind.

## Risks

- **The native backend is unchanged.** It writes bytes straight to a PTY it owns and has the
  same chunking, but `NativeTaskTerminal` exposes no way to ask whether the app enabled
  DEC 2004 — the mode is parsed in the terminal registry (`ghostty-live.ts`) and never
  plumbed to the writer. Wrapping unconditionally would type literal `[200~` into an app
  that did not ask for it. Left as it is rather than half-fixed and unverified.
- Text now reaches the app marked as PASTED rather than typed. Every caller of this seam is
  an agent prompt, where that is what is wanted, and a submit is always a separate `Enter`.
- A `set-buffer` that times out is reported as `indeterminate` even though nothing reached
  the pane. Pessimistic, and safe: the held-message path only sends its Enter on `delivered`.

## Alternatives considered

- **Wrap the text in `ESC [200~` / `ESC [201~` inside the hex.** One line, but it types
  literal `[200~` into any app that has bracketed paste off. `paste-buffer -p` gets the
  condition from tmux, which already tracks the pane's mode.
- **Chunk the text with delays between sends.** More sends is more ways to half-arrive, and
  it does not stop the receiver from treating each chunk as its own paste.
- **Lower the spill threshold so more messages become a file pointer.** Trades a truncation
  bug for making the receiver open a file for ordinary-length messages — the opposite of
  what the report asked for.
