# Keyboard shortcuts

Press **⌘/** (**Ctrl+/** on Linux) inside the app — or open **Help → Keyboard Shortcuts** — to
see every shortcut in one panel (App + Terminal/tmux tabs). This page mirrors that panel.

The single source of truth is [`src/mainview/keymap.ts`](../src/mainview/keymap.ts); the overlay,
this page and the website all read from it.

<p align="center">
  <img src="screenshots/keyboard-shortcuts.jpg" width="800" alt="In-app keyboard shortcuts panel">
</p>

## App

| Action | macOS | Linux |
|---|---|---|
| Go to project (quick switch) | ⌘K | Ctrl+K |
| Command palette | ⇧⌘P / ⇧⌘Space | Ctrl+Shift+P / Ctrl+Shift+Space |
| Keyboard shortcuts panel | ⌘/ | Ctrl+/ |
| Help mode (explain this screen) | ⇧⌘/ | Ctrl+Shift+/ |
| Open current project/worktree in an app (picker) | ⌘O | Ctrl+O |
| Terminal immersive fullscreen | F11 / ⇧⌘F | F11 / Ctrl+Shift+F |
| Find in the focused terminal | ⌘F | Ctrl+Shift+F |
| Find in an HTML artifact | ⌘F | Ctrl+F |
| Split pane vertically / horizontally | ⌘D / ⇧⌘D | Ctrl+Shift+E / Ctrl+Shift+O |
| Close pane / new tmux window | ⌘W / ⌘T | Ctrl+Shift+W / Ctrl+Shift+T |
| Back / Forward | ⌘[ / ⌘] | Ctrl+[ / Ctrl+] |
| Previous / next live variant | ⇧⌘[ / ⇧⌘] | Ctrl+Shift+[ / Ctrl+Shift+] |
| Switch to project 1–9 (keep view) | ⌘1–9 | Ctrl+1–9 |
| Switch to project 1–9 (flip view) | ⇧⌘1–9 | Ctrl+Shift+1–9 |
| Cycle active tasks (this project / all) | ⌥Tab / ⌥⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| New task | ⌘N | Ctrl+N |
| Add project | ⌘P | Ctrl+P |
| New window | ⇧⌘N | Ctrl+Shift+N |
| Settings | ⌘, | Ctrl+, |
| Zoom in / out / reset | ⌘= / ⌘- / ⌘0 | Ctrl+= / Ctrl+- / Ctrl+0 |
| Hard refresh | ⌘R | Ctrl+R |
| Toggle project terminal / open Quick Shell | ⌘` / ⇧⌘` | Ctrl+` / Ctrl+Shift+` |
| Close dialog / step back | Esc | Esc |
| Quit / Hide | ⌘Q / ⌘H | Ctrl+Q / Ctrl+H |

### In a browser (`dev3 remote`)

Two rules shape the keymap there, and both are enforced in
[`src/mainview/keymap.ts`](../src/mainview/keymap.ts):

- **The browser keeps some combos** — ⌘W, ⌘T, ⌘N, ⌘1–9, ⌘0, F11, zoom, refresh — and a page cannot
  cancel them. Those bindings do not fire in remote; the panel shows the alternative instead
  (`G` then `1–9` for projects, `G` then `0` for Operations, `C` for a new task, `⌃B x` / `⌃B c` for
  panes). **⇧⌘Space always opens the Command Palette**, and every action is a command — so nothing is
  out of reach even where a combo is lost.
- **The shell keeps `Ctrl`** — on Windows and Linux the app modifier is Ctrl, and `^D`, `^W`, `^K`,
  `^[` belong to whatever runs in the terminal. No app shortcut fires while a terminal has focus
  there, and the pane keys sit on `Ctrl+Shift` instead, as in every terminal emulator.

**Fullscreen in a Chromium browser lifts the first rule entirely:** the app calls
[`navigator.keyboard.lock()`](../src/mainview/keyboard-lock.ts) and ⌘W/⌘T/⌘1–9 become the app's
again, so the desktop keymap works verbatim. Escape is deliberately left to the browser so a single
press still leaves fullscreen. Safari and Firefox do not implement the API — there the alternatives
above are the whole story.

## Terminal

On a task whose terminal runs on the **tmux** backend, multiplexing uses tmux's `⌃B` prefix
bindings — see the **Terminal (tmux)** tab in the in-app panel for the current set. They are
defined in [`src/bun/tmux-config.ts`](../src/bun/tmux-config.ts). A task on the **native**
backend has no tmux and therefore no `⌃B` prefix; its panes are driven from the app's own
controls (and, for agents, `dev3 pane`).
