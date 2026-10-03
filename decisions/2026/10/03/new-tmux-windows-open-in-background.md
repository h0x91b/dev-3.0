# New tmux windows open in the background; only explicit user actions switch

## Context
tmux makes every new window the active one. When an agent (or anything else running a shell command) ran `tmux new-window`, the user's screen jumped from the agent's chat to an empty shell or a server log, which read as "my task disappeared" — the original complaint behind the in-app window navigator (`tmux-window-navigator`).

## Investigation
Verified on a throwaway tmux 3.6a server: a server `command-alias` named `new-window` that expands to `new-window -d` applies to commands from a shell inside a pane, from an attached client and from the app's own calls; it does not recurse, a second `-d` is harmless, and key bindings are parsed through it (`list-keys` shows `new-window -d`). Unique prefixes other than the aliased `neww` (e.g. `new-wi`) bypass it. An `after-new-window` hook that switches back was the first idea; it was rejected as more moving parts with a possible one-frame flicker.

## Decision
`src/bun/tmux/config.ts` sets `command-alias[90] new-window=new-window -d` and `command-alias[91] neww=new-window -d`, so no window takes the screen on its own. Explicit user actions still switch: ⌘T, the New window button, the phone's New window and a script run "in a window" call `tmux.newWindow({ focus: true })` (`src/bun/tmux/client.ts`), which selects the pane it just created; `⌃B c` is rebound to `new-window … ; select-window -t "{end}"`. Agents and external commands get a background window that the navigator shows as a new tile. User-approved on 2026-10-03, explicitly as a reversible choice.

## Risks
The alias is server-wide on dev3's tmux server: anyone who wants a plain `new-window` to switch must add `select-window` or use the app. `⌃B c` relies on `renumber-windows on` so the new window is `{end}`. An agent that asks the user to "look at the new tab" now needs the user to click it.

## Alternatives considered
The `after-new-window` hook switching back (flicker, harder to reason about); passing `-d` only from app code (agents, the actual source of the jump, untouched); changing the agent skill to always use `-d` (agents may not comply). To revert: delete the two `command-alias` lines and the `bind c` line, and drop `focus: true` from the callers.
