# GitHub Copilot CLI as a first-class harness

## Context

Issue h0x91b/dev-3.0#1771 asked for GitHub Copilot support. The subject is the
**standalone `copilot` binary** (installed here as 1.0.83 via
`brew install --cask copilot-cli`), not the older `gh copilot` extension, which is
a shell-suggestion helper with no agent loop, no session, and no hooks.

Everything below was measured against that installed, authenticated CLI on macOS,
not taken from documentation — the docs and the binary disagreed twice.

## Investigation

**Hooks exist and are enough.** A `$COPILOT_HOME/hooks/*.json` file fires
`sessionStart`, `userPromptSubmitted`, `userPromptTransformed`, `preToolUse`,
`permissionRequest`, `postToolUse`, `agentStop` and `sessionEnd`, with camelCase
JSON on stdin. The documented repository-level `.github/hooks/` source was never
consulted in a fresh checkout (`--log-level debug` shows only the policy dir), so
dev3 installs at user level only.

**The payload names no event.** Unlike Codex's `hook_event_name`, only
`permissionRequest` carries a `hookName`. So the event travels as an argv:
`dev3 hook copilot <event>`.

**`permissionRequest` is not a "waiting for the user" signal.** It fires on every
permission evaluation, including ones `--allow-all-tools` approves silently —
verified with and without that flag. Mapping it to `user-questions` would park a
working task in Has Questions on its first tool call.

**Waiting for the human is a tool, not an event.** Copilot asks through
`ask_user` — the tool `--no-ask-user` disables — and it does not return until the
answer is in. So `preToolUse` is read for `toolName === "ask_user"` and mapped to
`PermissionRequest`, and the matching `postToolUse` releases the task by itself.
That is the whole `user-questions` signal; no new event and no new hook.

**There is no system-prompt flag, and the obvious substitute does not work.**
`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` only *lists* an `AGENTS.md` in the system
prompt for the model to open later; its text never arrives. Measured: with an
instructions file saying "begin every reply with BANANA", the answer was `4`.

**A `sessionStart` hook's `additionalContext` does arrive.** Same file, delivered
through the hook: the answer became `BANANA 4`. End-to-end with the real
generated hooks file and the real handler, the 27 930-character dev3 protocol
lands in context — same prompt measured at 14.8k tokens without the
`DEV3_TASK_ID` guard and 21.3k with it.

**`--effort` is not universal.** `copilot --model auto --effort xhigh` exits with
`Model "auto" does not support reasoning effort configuration` and never starts —
`auto` resolves the model per turn, so it carries no reasoning setting. Copilot
also has no top-level `effortLevel` config key: the only persisted one is
`subagents.agents.<name>.effortLevel`. Effort is therefore a per-launch flag on a
named reasoning model, and the adapter drops it on `auto` rather than shipping a
pane that dies on open.

**Model names are catalog-wide but entitlement is per-account.** The binary's own
shell-completion script carries 27 model ids; on this account every named one is
refused with `Model "…" is not available` while `auto` works. Validation happens
before any model call, so a blocked preset fails instantly and cheaply.

## Decision

One adapter, `src/shared/agent-adapters/copilot.ts`, registered like every other
(`registry.ts`, `families.ts`, `AgentFamily`). It launches with `-i` so the pane
stays interactive, pre-assigns `--session-id <uuid>` and resumes with
`--resume=<id>`, maps dev3's permission modes onto Copilot's own flags, passes
`--effort` (except on `auto`, which refuses it), and deliberately drops `maxBudgetUsd` — Copilot budgets in AI credits,
not dollars, and a guessed conversion would be a lie.

Status hooks are merged into the `hooks` field of `~/.copilot/settings.json`
(`writeCopilotHooks`), replacing dev3's own previous entries and nobody else's.
This started as a private `~/.copilot/hooks/dev3.json` and had to move: that
directory can be **root-owned**. On a machine managed by an MDM that drops a
policy hook there, `~/.copilot/hooks` is `root:staff drwxr-xr-x`, so dev3's write
failed with `EACCES` and the hooks were never installed — the board silently
stopped following Copilot tasks, with only a warning in the app log. `settings.json`
sits in the Copilot home itself, which Copilot maintains as the user.

Worktree trust does **not** ride in that file. `ensureCopilotTrust` appends the
resolved path to `trustedFolders` in `~/.copilot/config.json`, joining the
`TrustKind` list the launcher already walks. Without it Copilot opens on
**Confirm folder trust** and waits in a pane nobody is watching. `config.json` is
Copilot's own state file and holds `loggedInUsers`, so dev3 merges into it: the
`//` header is carried through, every unknown key is copied, and a file that does
not parse is left alone rather than risking the login.
Each command is guarded on `DEV3_TASK_ID`, exactly like the Codex hooks and for
the same reason: the source is global, so an unrelated Copilot session must spawn
nothing. `dev3 hook copilot` maps Copilot's five useful events onto the existing
generic status vocabulary (renamed from `Codex*` to `Agent*` in the same change)
so one status machine serves both harnesses, and it answers `sessionStart` with
the protocol. It always exits 0 with JSON: a non-zero `preToolUse` hook is
fail-closed in Copilot and would block the tool call.

Presets lead with `auto` and offer named models below it, because `auto` is the
one that works on every plan.

## Risks

- **The trust file was found the expensive way.** `trustedFolders` first went into
  `settings.json`, which Copilot ignores outright. The dialog never appears under
  `-i`, so it took a real tty — a detached tmux pane with a captured screen — to
  see it at all, and then an A/B with one variable changed: `settings.json` →
  dialog, `config.json` → no dialog. Anything similar about Copilot's files
  deserves the same pane, not the documentation.
- **`user-questions` rides on a tool name.** `ask_user` is not a documented
  stability contract the way a hook event is; if Copilot renames it, the task
  simply stays in `in-progress` instead of parking — the same behaviour this
  shipped with before the tool was found, and nothing else regresses.
- **Windows and Linux are untested.** The PowerShell guard form is written and
  unit-tested, never executed — no Windows machine was available.
- **The hook file is global.** A user who never launches Copilot from dev3 still
  gets the file; the env guard makes it inert, but the file exists.
- **Named-model presets may all fail on a restricted plan**, exactly as this
  machine's account does. They fail loudly and instantly, and `auto` is the default.

## Alternatives considered

- **Prompt injection** (what Cursor and OpenCode do): would not cover scratch or
  resumed sessions, and would put ~28 KB on a command line Windows caps at 32 767.
- **Writing `AGENTS.md` into the worktree**: collides with the repository's own
  file and edits the user's checkout.
- **`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`**: measured not to deliver (above).
- **A per-task `COPILOT_HOME`**: would isolate hooks neatly, but it also orphans
  the user's settings and session history, and buys no account isolation — a
  fresh `COPILOT_HOME` is still authenticated, so the credential is not there.
