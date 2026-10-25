# A Linux relaunch hands off to the running instance

## 1. Context

`exitOnLastWindowClosed: false` keeps the backend alive after the last window closes. On macOS that is correct: the dock brings it back, and the OS never starts a second copy of a bundle. Linux has neither. In issue #2039 every close-and-relaunch left one more window-less backend, and four of them ended up loading and saving the same tasks.

## 2. Investigation

A window-less backend is not dead weight. It can still serve remote access, the tunnel, scheduled automations and native-backend terminals. Quitting on last-window-close, on Linux or anywhere else, would silently kill those, which is why the brief rules it out. Multiple instances on one `~/.dev3.0` are also legitimate: dev builds and guests (`DEV3_TASK_ID`) run beside the installed app. A blanket lock is therefore wrong as well.

## 3. Decision

`src/bun/launch-handoff.ts`: at the very top of `index.ts`, before anything writes shared state, an ordinary Linux desktop launch (no `DEV3_TASK_ID`, no `DEV3_FRESH_START`) sends `app.activate { bundle: PATHS.VIEWS_FOLDER }` over each live peer's CLI socket.

A peer accepts only when all three hold: it is a desktop instance (headless installs no host), it is not a guest, and it has the same bundle path. When it accepts, it opens a window if it has none, or focuses the one it has. The newcomer then `hardExit(0)`s. Any refusal, older peer ("Unknown method"), stale socket, error, or 1.5 s timeout falls through to a normal launch. Nothing is ever terminated. macOS and Windows never send the request.

## 4. Risks

- Orphans left by older versions do not know the method, so the first upgraded launch still starts beside them. They need one manual exit.
- Two launches at the same instant can both start.
- If the running instance's only window is frozen, a relaunch focuses that frozen window. Closing it first gets a fresh window from the same backend.

## 5. Alternatives considered

- **Exit when the last window closes on Linux.** This kills remote access and native terminals.
- **A tray icon.** Needs libappindicator and Electrobun tray work, which is a native expansion.
- **An flock on the data dir.** Blocks legitimate dev/guest instances and offers no way back to the hidden window.
- **Always opening a new window on relaunch.** Rejected as the less conventional behavior for a launcher click.
