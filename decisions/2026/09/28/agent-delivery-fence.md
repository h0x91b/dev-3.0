# Fence dev3's input to an agent once it has exited

## 1. Context

Every dev3 write into a pane ends in one guarded tmux command (`sendKeysGuarded`). The guard proved the pane was still there, not that the agent dev3 launched was still reading it. After any exit (updater SIGTERM, `/exit`, a crash) the `keepShell` wrapper hands the pane to a shell. A peer message, hand-off or scheduled prompt was then typed into that shell and **executed**, while the sender was told `delivered`. Reproduced by Seq 2016's fixtures.

## 2. Investigation

Every result below was measured on tmux 3.6a in disposable fixtures. The report and fixtures are in `~/dev3-reports/agent-delivery-fence/`.

**Timing cannot be the barrier.**
- A timed drain after the close let the shell execute 808 lines that tmux had accepted before the close but had not yet written. The trigger was a 3 s server stall.
- A sentinel queued in the same command list as the close arrives after every such byte. With it, 16 500 of 16 500 lines were saved and nothing was executed.

**The kernel loses input in a cooked tty.**
- It drops everything past 1 KiB of an unterminated line.
- A Ctrl-C flushes the whole input queue.
- Hence the tty is switched raw right at the agent's exit.

**Everything must be read.**
- A save loop that stops reading, at a cap or on a failed write, leaves bytes for the shell, which then **executes them**.

**Only one sentinel per close.**
- `0x1f` is readline's undo key.
- A second sentinel arriving after the handover erased the user's draft.
- So only the compare-and-set winner queues one, and every other closer reads the winner's nonce back.

**Wrappers are run by the user's login shell with the shebang ignored.**
- So the fence body is POSIX sh, parsed and run under bash, zsh and dash.

## 3. Decision

**The fence value.** A pane option `@dev3_agent_input`, owned by the launch wrapper:
- `open:<launchId>` while its agent runs;
- `closed:<launchId>:<exit code>` after it exits.

It is read in the same sighting as the pane, pinned into `PaneIncarnation.agentFence`, and compared inside the one guard. A closed fence is the retryable reason `agent-exited` (`src/shared/pane-input.ts`, `src/bun/pane-input.ts`, `pane-input-tmux.ts`, `tmux/client.ts`).

**The open.** It is a compare-and-set too (N4-R1). The wrapper opens only a pane with **no** fence, stores a per-attempt opener nonce in the same list, and trusts only a read-back of both.
- Re-running a generated script in the same pane therefore never reopens its launch: a closed fence stays closed, and every pin of the first run stays refused.
- A non-empty fence is **never modified** by a new wrapper.
  - An `open:<x>` found there is a live parent this run is nested in (an agent running a launch script), whose own close, sentinel and shell must stay valid.
  - A closed or malformed value stays as it is, so the guard keeps refusing.
  - The run proceeds unfenced and says so.
- The opener nonce is validated **before** tmux is touched, so a failed nonce opens nothing.

**The close.** `agentFenceCloseLines`, in `src/bun/agent-fence-wrapper.ts`, spliced by `buildCmdScript`:
1. The wrapper ignores INT, QUIT and TSTP, and switches the tty raw.
2. It closes the fence by compare-and-set, in one tmux command list that also stores a nonce and queues its sentinel.
3. It saves everything until that sentinel. The save is capped at 1 MiB plus one read; the excess is discarded and counted, and a failed write falls back to showing the bytes on screen.
4. Only then does it restore the tty and signals and start the shell.

**When the wrapper cannot close.** Its tmux binary is gone, for example during an app-bundle swap. Then:
- it writes `~/.dev3.0/agent-fence/<launchId>.close` and **starts no shell**;
- every app instance sweeps that one flat, additive directory at startup and every 2 s (`src/bun/agent-fence.ts`), and runs `TmuxClient.closeAgentFence`, the same compare-and-set;
- the instance then acks with the nonce it read back;
- a pin that sees a pending request refuses the write.

**Where the fence is armed.** Only the innermost keepShell script that runs the agent gets one (`agentFenceFor` in `tmux-pty.ts`):
- tmux tasks only, and only with the committed absolute tmux binary;
- never through a `PATH` tmux or the `~/.dev3.0/bin` shim.

**Held messages** (`agent-message-hold.ts`, `agent-prompt.ts`). A step refused with `agent-exited` returns `exited`:
- nothing more is typed into that pane;
- text that landed before the exit is saved and never retyped (I3), so the turn is not stranded;
- the rest moves only to the pane that replaced **that agent** (R-D3), in front of anything already held there;
- a replacement is matched by **identity, never by position**: same agent, config, family, account and conversation id, on a pane id the task did not have when the message arrived, live, and exactly one of them. Positions shift when the registry drops a closed pane's entry, and identical siblings exist. With no conversation id yet, or with two candidates, the messages wait and are saved at the bound (`findReplacementPane`);
- with no replacement, the rest waits for 10 minutes and is then saved and dropped.

**Every drop saves its texts first** (I5), through `saveUndeliveredAgentMessages`. A write that fails is retried every quiet window and reported as lost only past the bound (S-1). A direct prompt whose Enter met a closed fence keeps a copy of its text too (W-1).

**The blocked wrapper backs off** after ~6 s of silence and wakes every 3 s. Measured: ~15 external processes per second became ~1.5 (P3).

**Hand-started agents** (user decision D4, 2026-09-28): an agent the user starts by hand in the fallback shell gets no dev3 input until a managed restart.

## 4. Risks

These are stated limits; none of them is solved here.

- **Kernel drops at the exit.** Bytes that land between the agent's exit and the tty switch (milliseconds) are subject to the cooked-mode kernel drops.
- **A blocked pane is reported delivered.** While a wrapper waits for an app close, tmux accepts dev3 input, so callers record `delivered`. The input really reaches only the raced-input file. The late-close badge informs the user; it changes no verdict.
- **Mixed versions.** A pre-fence dev3 running side by side ignores the option on the normal path.
- **No shell until a close.** A pane whose wrapper never gets closed (no app ever runs, or an app acks without a sentinel) has no shell until the user closes it. Nothing typed there is executed.
- **Save retries live in memory.** Messages whose file could not be written are lost if the app restarts during the 10-minute retry, like every held message (the hold is in-memory by design).
- **A narrow reordering.** Messages relocated into a pane whose own hold is mid-release can land behind that release's leftovers. That is out of order, not lost.
- **A nested foreground program.** While a program nested in a live agent reads the tty, deliveries pinned to that parent go to whoever reads it. That is the same as before the fence, for any nested program.
- **Legacy wrappers.** Panes launched before this change stay unfenced until relaunch or resume.
- **Native backend and Windows** have no fence.
- **An agent that leaves the tty raw.** Its shell inherits that raw tty, as it did before this change; under dash no command then runs at all.

## 5. Alternatives considered

- **A process-evidence gate** (`ps` for the agent). Rejected: it misreads wrappers and renamed binaries, and it is a stale snapshot.
- **A wrapper-side wait before the shell.** Rejected: it either discards input or passes it to the shell (Seq 2016 fixtures B, C, D).
- **A side file checked only at pin time** (D2(c)). Rejected in review: a sender that pinned before the file passes the guard later.
- **A timed drain.** Rejected by measurement: 808 lines were executed.
