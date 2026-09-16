# Gate dev3-typed input on an agent lifecycle receipt, not on a live pane

## Context

A task launched by another agent (`dev3 task move --status in-progress` from a
coordinator worktree) died within a second on a fresh Mac, 9 times out of 9
(h0x91b/dev-3.0#1785). The pane showed Claude Code's workspace-trust dialog with
`No, exit` highlighted, then `✗ Process exited with code 1`, and the rest of the
handoff note landed in the bare shell as `zsh: parse error`.

Two dev3 behaviours combine into that. `ensureAgentTrust` deliberately skips
pre-granting trust for a `foreignCode` task, so a reviewed branch faces its own
trust decision — every failing task was created with `--branch`. dev3 still
writes `.claude/settings.local.json` into that worktree, which escalates the
plain trust dialog into the "this folder pre-approves 2 tool permissions"
variant. `deliverLaunchHandoff` then typed the note about 15 s later on a test
that only asked whether a PANE existed, and its Enter answered the dialog.

## Investigation

Reproduced 1/1 in an isolated lab (throwaway git repo, own `CLAUDE_CONFIG_DIR`,
the user's real config untouched), claude 2.1.273:

- pasting text and pressing Enter at that dialog exits 1, exactly as reported;
- `SessionStart` does **not** fire while the trust dialog is up, nor while the
  first-run theme wizard is up;
- it fires about 0.7 s AFTER the human accepts, before the CLI prompt argument
  runs;
- `SessionEnd` fires on a clean exit carrying the same `session_id`.

So the harness already emits exactly the receipt that was missing, and dev3
installed neither event for Claude (Codex and Copilot already had `SessionStart`).

## Decision

`src/bun/agent-readiness.ts` holds a three-valued, per-app-run answer to "may
dev3 type into this task's agent": `ready`, `booting`, `gone`, `unknown`.
`deliverAgentPrompt` — the one seam every dev3-typed prompt passes through —
refuses `booting` and `gone` with `not-delivered`, so the handoff, `dev3 message`,
scheduled messages and the button hand-offs are all covered by one check.

Three things make the answer specific rather than a task-wide mood.

**A real generation token.** Every launch gets a `launchId`, injected by
`buildAgentEnv` as `DEV3_LAUNCH_ID` and echoed back by the agent's lifecycle
hook. A receipt naming a launch the task no longer knows is rejected. Clearing a
map would not have done this: the replaced agent's process is still running, and
its slow hook would simply arrive afterwards and look new.

A token only helps if nothing can walk around it, so a receipt that names NO
launch may not touch a task with a launch outstanding. That hole was real and
measured: a hand-fired tokenless receipt flipped a `booting` task to `ready`.
Tokenless receipts are still accepted when nothing is pending — an app restart, a
resumed session or an agent the user started by hand can only report that way,
and with no window open there is no generation for one to bless.

**Pane identity, and no borrowing.** A receipt carries the pane it came from
(`TMUX_PANE` / `DEV3_PANE_ID`, read by `src/cli/hook-identity.ts`), so a send
aimed at one pane is judged on that pane. A named pane dev3 has no evidence about
answers `booting` and never inherits the task's answer: a ready main agent may
not vouch for a pane whose own agent could still have a dialog open. The single
exception is a task with no record at all, which stays `unknown` — that is our
own ignorance, not evidence against the task.

**A strict answer for an unproved destination.** A send to "the task's agent"
picks its pane deep inside the backend, so dev3 cannot prove where the text
lands; while ANY pane of the task is booting, that send is refused.

A boot window closes on evidence only — a receipt, a session end, or the pane
ceasing to exist (`forgetAgentPaneLaunch`, called from `handlePaneExited`).
**Never on a clock**: elapsed time is not proof that a pane became ready or went
away, and a pane still sitting in its trust dialog must never be un-gated by its
own timeout. Callers that cannot wait forever bound their own DELIVERY instead
and say so out loud: `deliverLaunchHandoff` badges the card once the wait stops
looking like an ordinary boot and gives up with a toast at a ceiling, and a
scheduled message is RETAINED in its queue while the reason is `agent-booting`
rather than dropped, until `BOOT_RETAIN_MS` makes the outcome user-visible.

The one caller with no alternative — a bug-hunter pane's first prompt, pasted
into an agent created seconds earlier — waits through `waitForAgentReadiness`,
which bounds the wait and never decides to type.

## Risks

- A Claude worktree whose `SessionStart` entry is edited away would sit in
  `booting`. `task.promptSubmitted` is a second source of the same receipt, and
  the failure direction is refusing to type rather than typing into a dialog.
- An extra agent pane that dies inside its own dialog holds the task's
  unresolved-target sends until that pane goes away. Deliberate: the alternative
  is a timeout that un-gates a pane whose dialog is still open.
- An agent killed hard (pane closed, `kill -9`) emits no `SessionEnd`; the pane's
  death closes its window through `handlePaneExited`, but an agent that exits
  while its pane survives leaves a stale `ready`. Unchanged from before this
  record, and not closed here.
- The receipt depends on the CLI at `~/.dev3.0/bin/dev3` knowing
  `hook claude-session` AND forwarding `DEV3_LAUNCH_ID`. Both entry points
  install the running app's own CLI there at startup (`src/bun/index.ts`,
  `src/bun/headless-entry.ts`), so a normal install matches. An older CLI in that
  path now fails CLOSED rather than degrading: its `hook claude-prompt` carries no
  launch id, and a tokenless receipt cannot close an outstanding window, so every
  message to a freshly launched task is refused until the CLI matches. That is the
  deliberate trade for shutting the bypass — refusing costs a retry, failing open
  costs an agent. The `agent-readiness` logger warns on every refused receipt so
  the cause is visible. Reproducible in a QA-scoped instance, where `DEV3_HOME`
  deliberately points elsewhere.
- A harness with no lifecycle receipts answers `unknown` forever. That is the
  gate staying open, which is intended — but it also means any future consumer
  with a strict gate (PR #1789's graceful exit) covers Claude, Codex and Copilot
  only. Widening that coverage means giving the other harnesses a receipt.

## Alternatives considered

- **Pre-granting trust for foreign code.** Rejected: the one human trust decision
  per reviewed branch is the point of `foreignCode`, and the reporter measured
  that writing `hasTrustDialogAccepted` by hand did not suppress this dialog
  anyway.
- **A fixed delay before the handoff.** Rejected: it is the same bug with a
  different number in it. A human reading a trust dialog takes as long as it
  takes.
- **Expiring a stale boot window.** Rejected, and called out in the module so
  nobody adds it back: a timeout would un-gate the exact pane whose dialog is
  still open.
- **Letting an unrecognised pane inherit the task's answer.** Rejected: it is the
  same fail-open one level down, and it is exactly what a pane-targeted send
  exists to avoid. The cost is that a task whose receipts never carry a pane id
  refuses every pane-targeted send; that is visible in the logs and recoverable,
  where typing into the wrong pane is not.
- **Scraping the pane for known dialog text.** Rejected: a heuristic over every
  harness's startup screens, which would go stale on the next CLI release.
- **A `SessionStart` entry that also moves status.** Rejected: it would flip a
  finished task back to `in-progress` the moment somebody opened its terminal,
  and put a second owner on the board status.
