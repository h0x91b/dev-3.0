---
name: debug-ui
description: Drive and visually QA the dev-3.0 UI in a real browser (headless Chromium via agent-browser) by serving it with `dev3 remote`. Use when verifying a UI/UX change, reproducing a visual bug, taking screenshots of the running app, or self-QA before review. Triggers — "check the UI", "screenshot the app", "does this render", "QA this screen", "verify the UI change in a browser", "drive the app".
---

# debug-ui — QA the dev-3.0 UI in a real browser

Lets you (the agent) actually **see and drive** the running dev-3.0 UI — click, type,
screenshot, read console errors — instead of guessing whether a UI change works. Runs in
headless Chromium, so there's no desktop/native dependency: it works the same in a plain
terminal session.

This is **dev-internal tooling for working on the dev-3.0 repo** — it is NOT one of the
skills dev3 ships to its users (those live in `src/bun/agent-skills.ts`).

## How it fits together

- **`dev3 remote`** is the headless server: the same backend as the desktop app, serving
  the full web UI over HTTP + WebSocket. Since decision 084 it runs **in-process inside the
  single `dev3` binary** (no separate `dev3-server`).
- **`agent-browser`** is a CLI-scripted headless Chromium. Point it at the server URL with
  an access token and you have a full, controllable instance of the app.

## The shared dev access code

`bun run dev` launches the desktop app with a **fixed web-access token baked in**
(`DEV3_REMOTE_STATIC_CODE`, a UUID set in package.json's `dev` script). So whenever the dev
app is running it already serves the full web UI at that token, and any `dev3 remote` you
start can reuse the same one. Read it from the single source of truth — never hardcode it:

```bash
CODE=$(grep -o 'DEV3_REMOTE_STATIC_CODE=[^ ]*' package.json | cut -d= -f2)
```

## Freshness — read this first

`dev3 remote` serves the UI bundle (and runs the CLI code) from the **last dev build**, not
your live working tree:

- The **dev-server provides fresh UI + a fresh `dev3` CLI**. `dev3 dev-server start` runs
  the project `devScript` (`bun run dev`), which rebuilds the bundle and reinstalls the
  current `dev3` into `~/.dev3.0/bin/`. If a dev build is already running, you're fresh.
- **Do NOT** hand-run `vite build` / rebuild manually — let the dev-server do it.
- Sanity check you're on current code: `dev3 --version` prints the build's commit hash.
- `dev3 dev-server start` has visible side effects — run `dev3 dev-server status` first and
  reuse a running build; tell the user before starting one.

## Recipe

1. **Ensure a fresh build is up** (dev-server running, or start it — see above).
2. **Start an agent-owned headless server in a split tmux pane** (deterministic — you pick
   the port, so the URL is fully known; it's long-running, don't run it inline):
   ```bash
   CODE=$(grep -o 'DEV3_REMOTE_STATIC_CODE=[^ ]*' package.json | cut -d= -f2)
   tmux -L dev3 split-window -h -t "$(tmux -L dev3 display-message -p '#S')" \
     "dev3 remote --no-tunnel --static-code $CODE --port 47823"
   ```
   - `--no-tunnel` — local only, no public Cloudflare exposure.
   - `--static-code` — fixed token (a rotating JWT would expire). Local-only.
   - `--port` — fixed port → predictable URL: `http://localhost:47823/?token=<CODE>`
   - *Alternative:* skip this and use the **already-running dev app's** web server at the
     same `$CODE` — but its port is random (find it in the app's Remote Access panel / QR).
     The agent-owned server above is simpler because the port is fixed.
3. **Drive it with agent-browser** (load the `/agent-browser` skill for the full command set):
   ```bash
   agent-browser set viewport 1440 900
   agent-browser open "http://localhost:47823/?token=$CODE"
   agent-browser wait --load networkidle
   agent-browser snapshot -i          # interactive elements with @refs
   agent-browser click @e1            # drive the UI
   agent-browser screenshot /tmp/dev3-ui.png
   agent-browser errors               # confirm no console errors
   ```
   **Read the screenshot back with the Read tool** to actually look at it.
4. **Clean up**: `agent-browser close`, then stop the server. **Ctrl+C currently
   does NOT stop `dev3 remote`** (known issue — the interactive env-resolution shell orphans
   the tty's foreground process group). Kill it by port or pane instead:
   ```bash
   lsof -nP -iTCP:47823 -sTCP:LISTEN -t | xargs -r kill   # by port
   tmux -L dev3 kill-pane -t <pane-id>                      # or kill the pane
   ```

## Notes / gotchas

- One `dev3 remote` per port. If a start seems to hang, check the port:
  `lsof -nP -iTCP:47823 -sTCP:LISTEN`.
- This is browser mode, so the app must obey the project's **"no native dialogs"** rule.
  If a flow silently does nothing where a confirm/file-picker is expected, that's an app
  bug (a forbidden native dialog), not a tooling problem — report it.
- Verifying a fix: after the dev-server rebuilds, `agent-browser reload` rather than
  reopening from scratch.
