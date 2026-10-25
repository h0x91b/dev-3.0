# Observe Claude's native idle transition after interruption

## Context

Escape leaves Claude running at its input prompt, but its `Stop` hook does not run on user interruption. The task therefore stayed in Agent is Working. Has Questions is the existing lane for a turn that needs user input without claiming completion, also used for API failures and permission waits.

## Investigation

Isolated PTY fixtures with a local fake Anthropic API reproduced this on macOS Darwin arm64 with Claude Code 2.1.308 and 2.1.310 (2.1.310 SHA-256: `ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd`). The [official hooks reference](https://code.claude.com/docs/en/hooks) excludes interruptions from Stop and cancelled tools from PostToolUseFailure; live traces confirmed neither event on Escape. An interrupted transcript marker exists after streamed output, but cancelling before the first token writes no marker, and statusLine is not reliably refreshed.

Claude's own `sessions/<pid>.json` instead changes from `busy` to `idle`, with `statusUpdatedAt` identifying the edge; permission requests use `waiting`. Stop executes while the registry is still busy, so it can disarm interruption observation before the normal idle transition. `scripts/verify-claude-escape.py <pinned-binary> <mode>` replays `stream`, `before`, `tool`, `approval`, and `normal`; the tool case proves the fixture's sleep subprocess started and was cancelled, and normal sends Escape at an already-idle prompt.

## Decision

`ClaudeSessionWatches` observes only the exact interactive session reported by a managed pane's prompt hook, matching its session id, cwd and process identity. Metadata polling detects explicit state edges; no elapsed-silence threshold, transcript inspection, terminal parsing, keystroke interception or process killing is involved. Native `DEV3_PANE_ID` and tmux `TMUX_PANE` use the same observer, including account and project-pinned config directories.

The prompt handler serializes registration and working status with the idle callback, then records traffic; Stop/SessionEnd disarm the corresponding turn. Only an active working/review lane with every recorded agent pane positively idle can move to Has Questions. Generation checks, fresh file reads and status guards reject stale callbacks, replacement processes and later prompts; lifecycle teardown and app shutdown release observations.

## Risks

The registry is an undocumented Claude interface: unknown shapes, missing files, dead processes and unobserved peer panes produce no inferred transition. Observation starts at the next managed prompt after an app restart; an already-running turn with no new prompt is not retroactively classified. Live coverage is macOS; native/tmux pane identity and Windows hook generation are covered by fixtures, not a live Windows Claude installation. Idle describes the foreground agent turn, not completion of deliberately detached background jobs.

## Alternatives considered

PostToolUseFailure alone misses both tool cancellation and token streaming; transcript markers miss pre-token cancellation. StatusLine and terminal titles are UI-dependent, and an Escape key can dismiss unrelated UI. An inactivity timeout cannot distinguish thinking, a hung tool, or a stopped turn. A standalone prompt status command was replaced with the serialized handler because it could race an old idle callback; recording runs afterwards so a traffic-log failure cannot prevent the working transition.
