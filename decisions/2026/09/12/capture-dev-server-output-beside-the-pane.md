# Capture the dev server's output beside the pane, never through it

## Context

A dev server's output lived in a terminal pane and nowhere else. tmux kept it in
the server's memory (`history-limit 250000`), a native pane kept `journal.ndjson`
(256 KB of base64 frames), and both died with the session. An agent could not
grep a stack trace, tail a build, or answer "why did it 500" without attaching to
a terminal it cannot read. Arseny asked for the output to land in a file next to
the worktree instead, with the path handed to the agent.

## Investigation

`rtk grep -rn "pipe-pane|pipePane" src` returned nothing: no capture of any kind
existed. The surveyed alternatives were the tmux scrollback (memory-only), the
native journal (bounded, base64, per terminal session rather than per dev server),
the app's own log (dev3's lines, never the devScript's), and `dev3 pane run` logs
(only for panes an agent starts itself).

Two capture points were possible. Running the devScript **through** a mirroring
process — the `dev3 pane run` shape — is one implementation for all platforms,
but it costs the dev server its tty: colours vanish from the pane the user
watches, interactive keys (vite `h`/`r`) stop working, and tooling changes
behaviour under a pipe. Capturing **beside** the process leaves the pane exactly
as it is, at the cost of two implementations.

A measured trap decided how the tmux leg is wired. Issuing `pipe-pane` as a
second tmux command after `new-session` attaches milliseconds too late: five
probe runs against a session whose first act was a `printf` lost the first line
in **four** of them. Chaining both into one invocation (`new-session … ;
pipe-pane …`) captured it in 3 of 3.

## Decision

Capture beside the pane, per backend, into one file at
`<taskDir>/logs/dev-server.log` (`devServerLogPath`, `src/shared/dev-server-log.ts`).

- **tmux**: `newSessionDetached({ pipeTo })` chains `pipe-pane -o` onto the same
  invocation (`src/bun/tmux/client.ts`), feeding the internal CLI verb
  `__dev-server-log` (`src/cli/commands/dev-server-log-sink.ts`).
- **native**: `runDevServer` passes `outputLogPath` down through the aux pane,
  the terminal contract, the multipane coordinator and the registry into
  `DEV3_NATIVE_SESSION_OUTPUT_LOG`; the session host writes it from the same PTY
  callback that feeds the journal (`src/bun/native-terminal-registry/host.ts`).
- Both write through `DevServerLogWriter` (`src/bun/dev-server-log.ts`), which
  strips escapes, collapses carriage-return redraws, flushes a held partial line
  after a second of quiet, and caps the file.
- Exposure: `DevServerStatus.logPath`, an `Output Log:` row in
  `dev3 dev-server status`, and `dev3 dev-server logs [--lines N]`.

**No rotation.** `AGENTS.md` forbids renaming anything under `~/.dev3.0/`, so the
writer trims the file in place (keeping the tail behind a notice) and each start
truncates what the previous run left. One path, always the same one.

## Risks

- A log can hold whatever the dev server prints, secrets included. It sits under
  `~/.dev3.0/worktrees/<slug>/<taskId>/logs/` and dies with the task directory;
  it is never uploaded and never enters `git status`.
- The native leg carries the path through five layers. `registry.start()`
  rebuilds its spawn options field by field and silently dropped it at first —
  caught by the E2E, and the reason that E2E exists
  (`src/bun/native-terminal-registry/__tests__/output-log.bun-e2e.ts`).
- Capture is per dev server today, one file per task. If a task ever runs several
  dev servers (Seq 1051's subject, deliberately untouched here), the name needs a
  discriminator — which is why every caller goes through `devServerLogPath`
  rather than the literal.
- Verified on macOS for both backends. The Windows leg shares the native code
  path but has not been run there.

## Alternatives considered

- **Mirror by wrapping the devScript** (the `dev3 pane run` shape): one
  implementation everywhere, rejected because it takes the pane's tty.
- **`tee` inside the generated wrapper**: POSIX-only, breaks the wrapper's
  exit-code capture (`$?` becomes tee's), and loses the tty as well.
- **Raise the native journal's cap and decode it on read**: keeps one mechanism,
  but the journal is per terminal session rather than per dev server, exists only
  on the native backend, and is a base64 frame log — not something to grep.
