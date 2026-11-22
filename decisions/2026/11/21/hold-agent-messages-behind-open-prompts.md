# Hold agent messages behind open prompts

## Context

`dev3 message` typed its text and an Enter into the agent pane after a quiet window, whatever the pane showed. In a Claude permission menu a digit picks a row with no Enter and the Enter approves the highlighted one; in an AskUserQuestion picker the whole message became the user's answer (issue #2342, reproduced live). Agreed design and rejected options: the #2342 spec (prompt-safe delivery, Option A — hook-fed ledger only).

## Investigation

Probe on Claude Code 2.1.330 with a logging hook on every event, default permission mode:
- `PermissionRequest` fires for Bash/Write permission menus, AskUserQuestion and ExitPlanMode, always right after that tool's `PreToolUse`. Its payload has `session_id` and `tool_name` but **no `tool_use_id`**.
- Answering Yes fires `PostToolUse` with the `tool_use_id`. Esc on a picker and "No" on a menu fire **nothing** — no `PostToolUse`, no `Stop`, no `PermissionDenied`; the next hook is the user's `UserPromptSubmit`.
- A single digit selects a menu row without Enter: probe text containing `c1.txt` typed into an open Bash menu approved the command.

## Decision

`AgentPromptLedger` (`src/bun/agent-prompt-ledger.ts`) is the one per-pane registry of open prompts; Codex question status (formerly `CodexQuestionState`) reads the same entries. Claude opens a prompt on `PermissionRequest` (new `dev3 hook claude-permission`, which still moves the card to Has Questions) and on `PreToolUse(AskUserQuestion)`. With no `tool_use_id`, a `PermissionRequest` waits for every call of that tool the same agent (`agent_id`) still has in flight (between `PreToolUse` and `PostToolUse`). It closes once all of them have their `PostToolUse` or `PostToolUseFailure` (own subcommand `hook claude-post-tool-failed`, so a mismatched CLI fails closed; it only ends the call: no status move, no mail drain, since an interrupted call leaves the agent idle), or on `UserPromptSubmit`/`Stop`/`SessionEnd`, the pane dying, or the user's Send now. The other harnesses feed the same rules through the status hook: Codex `PermissionRequest` waits for every in-flight call of its tool plus the call it names, even one dev3 never saw start; Copilot `ask_user` for that tool's `postToolUse`; omp and pi for a `PostToolUse` their extension marks `promptEnd` (one mark closes the oldest such prompt), since their tool ends are indistinguishable otherwise; agy for any `PostToolUse` (its statusLine names no tool). All close on the session's UserPromptSubmit/Stop/Interrupt/SessionStart/SessionEnd, and a hook with no session id is keyed by its pane. The gate runs before the card logic (`applyStatusHookGate`, ahead of agy's early returns) and keeps its own session key, so the card's Codex question status is unchanged. The gate is in `release()` of `agent-message-hold.ts`: an open prompt keeps the hold (no ceiling, retried each quiet window, rearmed one quiet window after the close), which also covers the user's own Enter flush. The sender gets `held` with reason `behind-prompt` (exit 0); the card and inspector show a "N waiting" chip with Send now.

Unheld hand-offs (Create PR, commit, rebase, bug hunters, role change, "Send to agent", Send now on a draft or a scheduled message) still type at once, except into a pane with an open prompt: `deliverAgentPrompt` (`agent-prompt-delivery.ts`) then puts them in the same hold behind the prompt and raises a toast saying it waits for the answer; the verdict (`held`/`behind-prompt`) reaches every click surface, so none of them says "sent". A re-click on the same text adds no second copy, and a stranded turn keeps its "press Enter there" refusal. The pane is resolved only when some pane of the task has an open prompt. Send now on a saved draft or a queued message is different: the item stays on disk and is sent through the hold when that pane's prompt closes (`sendsAfterPrompt` in `scheduled-message-scheduler.ts`), so a restart or a dead pane cannot take the user's text. Clock-fired scheduled messages, armed drafts and PR-watch notices were already held, so the gate in `release()` covers them.

## Risks

- Esc / "No" leave the entry open until the session's next prompt or Send now: messages arrive late, never into a menu.
- With parallel calls of one tool, dev3 cannot tell which one asked, so the prompt may stay open until the slowest of them finishes. That is the safe side: typing early lands in the menu. A later tool call never closes a prompt; an earlier version did, and a parallel call that needed no permission closed the menu early.
- In memory: a restart while a picker is open forgets it. Hookless harnesses (Cursor, Gemini, OpenCode) and Notification-only dialogs stay unprotected.
- A native pane held by another app process (owner routing) is gated only if that process received the hooks.
- A hand-off checks the ledger once, before typing: a prompt that opens in the 800 ms before its Enter still takes that Enter.
- A held hand-off (Create PR, a review comment) is in memory like a `dev3 message`: a restart while the prompt is open loses it; the click surface already said it waits. A deferred draft or queued message keeps its text on disk, but a restart forgets the intent: it is sent only on the next click (or the message's own clock), and an Esc-dismissed prompt delays it until the session's next prompt. A draft edited meanwhile is not sent.

## Alternatives considered

Screen detection via `capture-pane` and Claude transcript tailing for the Esc close (rejected: tmux-only / extra watcher; Send now covers it); the card's `user-questions` status as the gate (rejected: scratch tasks and completion waits sit there with no prompt); a wait ceiling that forces delivery (rejected: a forced Enter is the bug).
