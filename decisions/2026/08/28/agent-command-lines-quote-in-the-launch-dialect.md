# Agent command lines quote in the launch dialect

## Context

Starting or resuming any Claude session on Windows died before the binary was
looked up:

```
Invoke-Expression : Missing expression after unary operator '-'.
+ - Do NOT run `dev3 task update`, `dev3 overview set`/`clear`, ...
```

`resolveAgentCommand` assembles the launch as one string and `buildCmdScript`
hands that string to the wrapper, which re-parses it — `Invoke-Expression` on
Windows. Every argument was quoted by `shellEscape`, which spells an apostrophe
the POSIX way (`'\''`). In PowerShell `'` closes the literal and `\` is not an
escape, so the dev3 system prompt — which says "the task's title" — turned the
rest of the prompt into code. `decisions/2026/07/26/platform-launch-dialect.md`
predicted exactly this and left it open ("complex quoting will need a separate
normalisation pass"); this is that pass.

## Investigation

A second parser sits behind the first, and it is the one that is easy to miss.
PowerShell does not hand argv to the callee: it builds a raw command line, and
the callee's C runtime splits it again. Windows PowerShell 5.1 escapes nothing on
the way through (`about_Parsing`: quotes meant for a native command must be
escaped by hand), so the C runtime's escapes have to be present in the string
dev3 writes. The dev3 system prompt contains double quotes and backslashes, so
this is not a corner case for it.

That behaviour is a claim about a PowerShell version this repo cannot run on
macOS, so it is not asserted from reading: `src/bun/__tests__/agent-launch-args.bun-e2e.ts`
runs the real wrapper on the runner's real platform against a probe binary and
compares its `argv` byte-for-byte, over values picked to break one parser or the
other. It runs in the packaged Windows proof, with the POSIX legs as the control.

**Its first Windows run found the bug behind the reported one.** A Windows
command line stops at 32 767 characters (`CreateProcess` returns
ERROR_FILENAME_EXCED_RANGE, which PowerShell reports as
`ApplicationFailedException` with no useful text), and the dev3 protocol was
**33 650** characters on its own. So `--append-system-prompt <body>` could never
have been delivered on Windows at any quoting — fixing the quoting alone would
have moved the failure one step later and looked just as dead.

The protocol has since been **cut to ~26 000 characters** and put under a budget
(below), so it is no longer the ceiling that kills a launch. The file channel
stays anyway: 26 000 of a 32 767-character line spent on a constant leaves the
user's own task description to blow the ceiling instead.

Two limits of Windows PowerShell 5.1 remain, both measured and both asserted in
that E2E rather than left silent:

- An argument holding an **odd number of double quotes** splits in two. 5.1
  appears to close its own wrapping quote where quotes first balance. The obvious
  fix — emit quotes in pairs (`""`) so the count is always even — was measured on
  the runner against the whole battery and is strictly WORSE: it breaks four
  cases the backslash encoding delivers and does not fix this one. No encoding
  closes it, so a task prompt containing one `"` is still delivered wrong on
  Windows. Closing it means dev3 building the raw command line itself
  (`[Diagnostics.Process]::Start`) instead of letting PowerShell build it, which
  costs the shell semantics of a user's own `baseCommand` — a separate decision.
- An **empty argument** is dropped from the command line. dev3 emits none today.

## Decision

`LaunchDialect` grew two members next to `quote`
(`src/shared/platform-launch.ts`):

- `nativeArg(value)` — one argument for a native executable through a re-parsed
  command line. POSIX reuses `posixShellQuote` byte-for-byte (the shell hands the
  word to `execve`). Windows uses `powerShellNativeArg`: a single-quoted literal
  with `'` doubled, `"` written `\"`, the backslashes in front of a quote
  doubled, and a trailing backslash run doubled only when PowerShell will append
  a closing quote for it to eat.
- `commandToken(value)` — the first token. An absolute path that is not a bare
  word is quoted (`& '...'` on Windows, where `&` is what makes a quoted string a
  command). Anything else is untouched, so `npx claude` stays shell text.

On Windows the protocol also stops travelling on the command line at all:
`src/bun/agent-system-prompt-file.ts` writes the body to
`~/.dev3.0/data/agent-prompts/claude.md` and the Claude adapter passes
`--append-system-prompt-file <path>` instead. Verified against Claude Code
2.1.112 that the flag exists and applies the file's content. POSIX keeps the
inline form, so nothing about a macOS or Linux launch changes.

**The file only covers Claude**, because only Claude has a flag that takes a
path. Codex carries the protocol in `-c developer_instructions=`, and Cursor and
OpenCode concatenate it onto the prompt, so for them the body is on the command
line and nothing can move it there. That is what forced the second half of this
change: instead of a per-agent channel each, **the protocol itself was cut** from
~34 500 to ~26 000 characters and capped.

`src/shared/agent-command-line-budget.ts` owns three numbers:
`WINDOWS_COMMAND_LINE_LIMIT` (32 767, the OS), `AGENT_COMMAND_LINE_RESERVE`
(5 000, kept for the user's own task description) and `AGENT_SKILL_BODY_LIMIT`
derived from them. `src/bun/__tests__/agent-command-line-budget.test.ts` fails on
a body over the cap **on either platform** — the PR-footer section is rewritten
where `dev3://` is not registered and the Windows wording is the longer one — and
on any agent's full `resolveAgentCommand` line exceeding the ceiling with a
full-size task. Proved by mutation: padding the body by ~1 200 characters fails
the Codex and generic legs.

The reserve is a majority guarantee, not an absolute one. A task description of
5 000 characters (~800 words) survives; a pasted 20 KB spec still cannot launch
Codex, Cursor or OpenCode on Windows, and only a per-agent off-command-line
channel would fix that.

`shellEscape`/`commandToken` in `src/shared/agent-adapters/shell.ts` delegate to
the dialect, so all six adapters follow the platform without knowing it exists.
The command token is applied once at the boundary — `resolveAgentCommand` and
`buildResumeCommand` in `src/bun/agents.ts` — because only the boundary knows the
string is about to be re-parsed.

## Risks

- **POSIX regression** is the whole risk: `nativeArg` on POSIX is the same
  function `shellEscape` always was, and `commandToken` changes only an absolute
  path that needs quoting. `agent-command-golden.test.ts` and
  `platform-launch-posix-golden.test.ts` pin the existing output.
- The 5.1 escaping model above is a model. It is pinned by the executed E2E
  rather than by belief, and that E2E is in `WINDOWS_SCOPE_PATHS`, so an edit to
  the adapters re-dispatches the Windows proof.
- A user's `baseCommand` that is several words stays unquoted on purpose. A path
  with a space typed there still breaks, exactly as it did before — dev3 cannot
  tell that from a command with arguments.

- Cutting the protocol cost content. It was rewritten section by section rather
  than truncated, and one compression introduced a real bug the existing skill
  test caught: collapsing the `show-artifact --assets` paths into a brace
  expansion `{app.css,report.js,…}`, which bash expands and PowerShell does not.

## Alternatives considered

- **A per-agent off-command-line channel for Codex / Cursor / OpenCode** —
  Codex's would fit in the `config.toml` dev3 already generates, but Cursor and
  OpenCode have no such surface at all, so the protocol would have needed three
  different homes and would still have been unbounded. Capping the text is one
  rule for every agent.
- **A bigger reserve** — over-provisioning the task-text allowance (8 000+) reads
  safer, but it buys nothing real (a pasted spec beats any reserve) while forcing
  cuts deep enough to lose rules.

- **Pass the command as argv instead of a re-parsed string** — the agent command
  is a user-editable string that may carry shell operators; turning it into argv
  changes what a user's own preset means.
- **`--%` (PowerShell's stop-parsing token)** — it would hand dev3 full control of
  the raw command line, but it reads to the end of the LINE, and the system prompt
  contains newlines.
- **`[Diagnostics.Process]::Start` with a hand-built command line** — full control
  of both parsers, at the cost of the wrapper no longer running the user's command
  as shell text at all.
