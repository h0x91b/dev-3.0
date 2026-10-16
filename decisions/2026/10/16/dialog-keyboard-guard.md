# Dialog keyboard guard: typed keys must not answer a dialog

## Context
On 2026-10-16 an agent's cancellation request (`dev3 task move --status cancelled`) opened its confirm while the user was typing a reply in another task's terminal. The log shows the request created at 12:23:08.021 and declined by the renderer 176 ms later; the agent's CLI printed "User declined". That keystroke answered the safe way only because agent dialogs autofocus their decline button.

## Investigation
Reproduced in an isolated QA app (`DEV3_QA_SCOPE=seeded`, fake `rpc:agent*Requested` pushes, real CDP keystrokes, answers read off the RPC websocket) in Chromium and Playwright WebKit. Before the fix: Space or Enter 60 ms after arrival declined; a typed sentence declined (its space did); Tab then Enter **approved** completion at once and cancellation once the git gate settled; one held Enter answered two queued dialogs; a bare `c` opened New Task over the agent dialog (`isTypingContext` saw a button, not a field); Escape did not close a plain confirm at all; `keyboardChoice` made a typed `y` close a pane. Space pressed before opening and released after did not click in either engine. Not reproduced: which exact key the user hit — Space or Enter on the focused "Keep the task" are the only keys that can decline it.

## Decision
`src/mainview/utils/dialog-keyboard-guard.ts`: one capture listener on `window`, installed at import so it runs before every other window listener, acting for the most recently opened guarded dialog (`useDialogKeyboardGuard`). Unsolicited dialogs (`agentInitiated` confirms, `AgentLaunchRequestModal`) take `quietMs: 700` — every key is swallowed until the keyboard has been silent that long, a pointer press inside arms at once. All guarded dialogs drop answer-key repeats and keyup/keypress of keys pressed before they opened, never let Space press a button, ignore IME-composition Enter/Escape, and may own Escape topmost-first. `confirm.tsx` uses it for every confirm (Escape declines) and loses the y/n mnemonics; `LaunchVariantsModal`/`SpawnAgentModal` use it with no quiet window. `isTypingContext` is true inside any dialog, so bare-key shortcuts stay out.

## Risks
Keys swallowed during the quiet window are lost, not passed back to the terminal. After 700 ms of silence a blind Tab+Enter still approves — that is the deliberate keyboard path. Dialogs not using the hook (setup-failed card in `TaskTerminal`, quiet ones listed in the seq 2165 audit) keep their old keyboard behaviour; none of them can destroy work from a keystroke. WKWebView itself was not driven; Playwright WebKit was.

## Alternatives considered
Patching each dialog's handlers leaves Tab+Enter and the shortcuts open and is copied wrong by the next modal. Not focusing unsolicited dialogs at all keeps typing flowing into the terminal but kills Enter/Escape and keyboard access. A per-dialog arming timer without "restart on every key" still lets a fast typist's next keys through.
