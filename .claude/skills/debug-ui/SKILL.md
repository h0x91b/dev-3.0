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
# 1. Two values, both instant: token from a file, port from the env (or CLI fallback).
CODE=$(cat "$HOME/.dev3.0/dev-web-access-code" 2>/dev/null || bun scripts/dev-web-code.ts)
PORT=${DEV3_PORT0:-$(dev3 dev-server status | grep -oE 'DEV3_PORT0=[0-9]+' | cut -d= -f2)}

# 2. Start a FRESH dev-server and wait for it to come up. (Skip the start only if one is
#    already running for THIS task — but see the build-snapshot gotcha: stale code needs a
#    restart, so when in doubt restart.)
dev3 dev-server start
until curl -sf "http://localhost:$PORT/?token=$CODE" >/dev/null; do sleep 2; done

# 3. Drive it. (Load /agent-browser for the full command set: snapshot, click, type, …)
agent-browser set viewport 1440 900
agent-browser open "http://localhost:$PORT/?token=$CODE"
agent-browser wait --load networkidle
agent-browser screenshot /tmp/dev3-ui.png    # then Read it back to actually look
agent-browser errors                          # confirm no console errors

# 4. Always clean up what you started.
agent-browser close
dev3 dev-server stop          # the port frees a second or two later (graceful shutdown)
```

That's it. `DEV3_REMOTE_PORT=${DEV3_PORT0:-0}` is wired into the repo's `dev` script and
`portCount: 1` is committed in `.dev3/config.json`, so the dev app binds the exact port shown
above (see [decision 093](../../../decisions/093-dev-remote-port-from-pool.md)).

## Gotchas

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
