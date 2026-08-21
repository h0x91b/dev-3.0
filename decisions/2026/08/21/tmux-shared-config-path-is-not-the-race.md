# The shared tmux config path is not a race — tmux never dies from a bad config

Closed as not-a-bug. Read this before you reach for `/tmp/dev3-tmux-dark.conf` to explain
`TmuxError: tmux -f failed (exit 1): server exited unexpectedly`.

## 1. Context

Every dev3 tmux server on a machine starts from one fixed config path,
`TMUX_CONF_DARK_PATH` / `TMUX_CONF_LIGHT_PATH` in `src/bun/tmux/config.ts`, written at
module load and passed via `-f` by `TmuxClient.newSessionDetached` and
`spawnAttachedSession`. The same module load also rewrites the Catppuccin plugin
directory (`writeCatppuccinPlugin`, 7 files) and the shell-init directory
(`writeShellInit`, 5 files), all at fixed paths under `DEV3_TEMP_ROOT`.

Two overlapping runs on one machine produced `server exited unexpectedly`, and the shared
path was the obvious suspect: a developer machine routinely runs the app plus a throwaway
test server at once, so the path is shared between processes. The hypothesis was a torn
read — `writeFileSync` truncates before it writes, so a tmux server parsing the file mid-write
would see an incomplete config.

## 2. Investigation

**The hypothesis is false, and the falsification is cheap and decisive.** tmux 3.6a — the
version dev3 pins — treats config errors as messages, not as fatal. Four ways to hand it a
broken config through `-f`, each run against a real server:

| What tmux was given | `new-session -d` result |
|---|---|
| Unterminated quote mid-line (what a half-written file looks like) | exit 0, server alive |
| `source` of a file that does not exist | exit 0, server alive |
| Completely empty file | exit 0, server alive |
| A `-f` path that does not exist at all | exit 0, server alive |

So no corruption of the conf, the plugin directory, or the shell-init directory can produce
`server exited unexpectedly`. Three further checks agree:

- **Torn read, forced.** A writer process replaying the module-load writes in a tight loop
  (17 468 rewrites of both confs plus both directories in 8 s) against a reader starting real
  tmux servers with `-f`: **0 failures in 250 starts.** Baseline with no writer: also 0/250.
- **Overlapping runs, forced.** `guarded-send.bun-e2e.ts` run overlapping 14 times
  (three rounds of two, then two rounds of four): **all 14 printed ALL CHECKS PASSED.**
- **Reading-level proof there is nothing to clobber.** `buildThemeConfig` is pure; its only
  varying input is `DEV3_TEMP_ROOT`. Two processes that share the path share the root, so
  they write byte-identical content. Vitest processes get their own `DEV3_TEST_ROOT`
  (`test-isolation.ts`) and never share the path at all — only the live `*.bun-e2e.ts`
  scripts and the app itself use the real `/tmp`.

**Adjacent measurement, recorded here because a reader chasing tmux weirdness wants it next
to the above.** The tmux *socket* directory is a path root too, and it sits outside the dev3
home entirely. It is redirectable only by `TMUX_TMPDIR`, and nothing in this codebase sets
that variable — the single mention is a stale comment at `src/bun/__tests__/pane-exit-e2e.ts:75`
naming a variable no code assigns. Verified by running it both ways:

| Env passed to tmux | Where the socket landed |
|---|---|
| `TMUX_TMPDIR=/tmp/probe` | `/tmp/probe/tmux-501/` — moved |
| `TMPDIR=/tmp/probe` alone | `/tmp/tmux-501/` — **not** moved |

`test-isolation.ts` sets `TMPDIR`, `TMP` and `TEMP` but not `TMUX_TMPDIR`, so isolating the
dev3 home does not isolate the socket directory: an instance pointed at a scratch home still
mints sockets into the shared system temp dir. Anyone setting `TMUX_TMPDIR` must set it for
*every* tmux invocation — a client that disagrees with the server looks in the wrong
directory and sees no server at all.

## 3. Decision

**No code change.** The shared path stays as it is. The residual torn-read window is real
(under 100 µs) but harmless twice over: tmux tolerates a corrupt config, and the content is
identical anyway. An atomic write plus rename would close it in ~15 lines reusing
`atomicWriteFile` (`src/bun/atomic-write.ts`), and was deliberately **not** shipped — a
hardening that fixes nothing observable is worse than nothing here, because it retires the
question without answering it.

**The reported error therefore has a different, still-unfound cause.** Two leads were not
chased, named here so the next person starts where this stopped:

1. **Stale tmux socket files.** 1 158 dead socket files in the temp socket directory, 340 of
   them `dev3-live-*`, largest family `dev3-seam` (295). The names are keyed by process id
   and macOS recycles process ids, so a fresh run can land on a name that already has a file.
2. **Resource pressure under the full runner.** `scripts/run-terminal-e2e.ts` runs ~20 live
   scripts; a server that cannot fork looks exactly like this error.

## 4. Risks

The torn-read window survives. If dev3 ever moves to a tmux build that makes config errors
fatal, or starts writing content that differs between processes sharing one root, this
decision must be revisited — the atomic-write fix is the answer then, not a per-server path.

## 5. Alternatives considered

- **Per-server config path keyed by socket** — rejected: it leaves the Catppuccin plugin
  directory shared, which the config `source`s by absolute path, so the collision it claims
  to remove is still there.
- **Content-addressed path** — rejected: without an atomic write a same-content writer still
  truncates the same path, so it narrows nothing while adding path churn in the temp dir.
- **Atomic write plus rename** — correct as engineering, rejected as an action here for the
  reason in §3. It is the documented answer if the risk in §4 materialises.
- **Making the error message honest** — nothing to make honest: the message is tmux's own,
  and it is accurate. The config path was never involved.
