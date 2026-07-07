---
name: debug-ui
description: Drive and visually QA the dev-3.0 UI in a real browser (headless Chromium via agent-browser). Use when verifying a UI/UX change, reproducing a visual bug, taking screenshots of the running app, or self-QA before review. Triggers — "check the UI", "screenshot the app", "does this render", "QA this screen", "verify the UI change in a browser", "drive the app".
---

# debug-ui — QA the dev-3.0 UI in a real browser

See and drive the running dev-3.0 UI in headless Chromium — click, type, screenshot, read
console errors — instead of guessing whether a UI change works. No desktop/native dependency;
it works the same in a plain terminal session.

This is **dev-internal tooling for the dev-3.0 repo** — NOT one of the skills dev3 ships to
its users (those live in `src/bun/agent-skills.ts`).

## The whole flow

This task's dev-server **is** the web UI: `bun run dev` serves the full app in local remote
mode at a stable per-machine token and a CLI-derivable port — no separate `dev3 remote`. The
loop is always the same four beats: **values → server → browser → clean up.**

```bash
# 1. Values. AGENT_BROWSER_SESSION isolates THIS task's browser from every other agent's —
#    without it all agents share one global "default" session and stomp each other (see
#    Gotchas). Derived from the always-present $DEV3_TASK_ID, so this exact line is
#    copy-paste-safe at the top of ANY block that calls agent-browser.
export AGENT_BROWSER_SESSION="dev3-${DEV3_TASK_ID%%-*}"
CODE=$(cat "$HOME/.dev3.0/dev-web-access-code" 2>/dev/null || bun scripts/dev-web-code.ts)
PORT=${DEV3_PORT0:-$(dev3 dev-server status | grep -oE 'DEV3_PORT0=[0-9]+' | cut -d= -f2)}

# 2. Start a FRESH dev-server and wait for it to come up. (Skip the start only if one is
#    already running for THIS task — but see the build-snapshot gotcha: stale code needs a
#    restart, so when in doubt restart.)
dev3 dev-server start
until curl -sf "http://localhost:$PORT/?token=$CODE" >/dev/null; do sleep 2; done

# 3. Drive it. Every agent-browser call inherits AGENT_BROWSER_SESSION, so it all runs in
#    this task's own session. (Load /agent-browser for the full command set.) The screenshot
#    path is task-scoped too, so parallel agents never overwrite each other's PNG.
agent-browser set viewport 1440 900
agent-browser open "http://localhost:$PORT/?token=$CODE"
agent-browser wait --load networkidle
agent-browser screenshot "/tmp/dev3-ui-${DEV3_TASK_ID%%-*}.png"   # then Read it back to look
agent-browser errors                          # confirm no console errors

# 4. Always clean up what you started. `close` closes only THIS session's browser.
agent-browser close
dev3 dev-server stop          # the port frees a second or two later (graceful shutdown)
```

That's it. `DEV3_REMOTE_PORT=${DEV3_PORT0:-0}` is wired into the repo's `dev` script and
`portCount: 1` is committed in `.dev3/config.json`, so the dev app binds the exact port shown
above (see [decision 093](../../../decisions/093-dev-remote-port-from-pool.md)).

## Gotchas

- **The browser is a machine-global singleton — isolate per task or agents stomp each other.**
  Every `agent-browser` call with no session lands in one shared `"default"` session: one
  browser process, one global viewport. When two task agents QA at the same time they collide
  — agent B's `open` silently replaces agent A's page, so A's next `screenshot` captures B's
  UI. The fix is step 1: `export AGENT_BROWSER_SESSION="dev3-${DEV3_TASK_ID%%-*}"` gives each
  task its own isolated session/profile (verify with `agent-browser session` / `session
  list`), and `agent-browser close` then closes only your session. **The Bash tool
  reinitializes the shell per call, so an `export` does not carry across separate
  invocations** — the line derives from the always-present `$DEV3_TASK_ID`, so just repeat it
  at the top of each block, or pass `--session "dev3-${DEV3_TASK_ID%%-*}"` on every command.
  (If you ever must share one browser machine-wide instead, serialize QA across agents so only
  one drives at a time.)
- **The dev-server is a build snapshot — no watch/HMR.** Your code only appears after a
  (re)start. After changing code, `dev3 dev-server restart`, re-wait for the port, then
  `agent-browser reload` — a bare reload re-serves the *old* bundle. Don't keep a stale server
  around; never hand-run `vite build`.
- **Is the running build actually yours?** An already-running app/remote is often production or
  *another* worktree — it won't have your changes. (Re)start THIS task's dev-server and confirm
  with `dev3 --version` (commit hash should match `git log -1`) + that your change actually
  renders. Don't assume.
- **Tell the user before `dev3 dev-server start`** (visible side effect), and stop it after
  (step 4) unless they want it kept.
- **No `DEV3_PORT0`?** (portCount 0, or an older worktree where it was never allocated) — run
  your own fixed-port server instead:
  `dev3 remote --no-detach --no-tunnel --static-code $CODE --port 47823` → `:47823/?token=$CODE`.
- **No native dialogs** in browser mode. If a confirm/file-picker flow silently no-ops, that's
  an app bug, not a tooling problem — report it.
- **Show images to the user AFTER you stop this dev-server, not while it runs.**
  `dev3 show-image` (and `dev3 attention` / `dev3 notify`) route to the app instance that owns
  the task — and this QA dev-server is itself a full dev3 instance. While it's up, those
  UI-attention calls can land in *it* (the browser only you see) instead of the user's main
  app, so the user never sees the image. Screenshots persist on disk, so the correct order is
  **capture → `dev3 dev-server stop` (confirm `State: stopped`) → `dev3 show-image`**.
