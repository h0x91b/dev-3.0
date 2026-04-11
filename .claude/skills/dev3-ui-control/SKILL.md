---
name: dev3-ui-control
description: "MANDATORY for any visual verification of dev-3.0 app changes. Default: agent-browser via the remote access server. Fallback: agent-electrobun for terminal/native testing (see native-cdp.md). Triggers on: verify fix in app, test the change, screenshot, interact with UI, control the app, create/run task in UI, dogfood."
allowed-tools: Bash(agent-browser:*), Bash(agent-electrobun:*), Bash(QUIVER_CDP_PORT=*), Bash(dev3 dev-server:*)
---

# dev3-ui-control — Verifying UI changes

## Which tool to use

| What you're testing | Tool | Why |
|---|---|---|
| Component behavior (clicks, toggles, modals, forms) | agent-browser + snapshot/eval | Same React UI, better tooling (wait, fill, press) |
| Layout, visual appearance | agent-browser + snapshot/eval | Prefer text assertions; screenshot only if human review explicitly needed |
| Terminal/PTY features (xterm, tmux controls) | agent-electrobun | Browser mode uses WebSocket PTY proxy — different path |
| Native window features (drag-drop, system notifications) | agent-electrobun | Not available in browser mode |
| WebKit-specific rendering bugs | agent-electrobun | Production uses WKWebView, not Chromium |

**Default to agent-browser.** Use agent-electrobun only for the last three rows. See [native-cdp.md](./native-cdp.md) for the CDP setup.

## Quick start (agent-browser)

```bash
# 1. Start dev server and get the port
dev3 dev-server start          # or `dev3 dev-server status` if already running
# → Assigned Ports: DEV3_PORT0=NNNNN

# 2. Set the port variable for the session
PORT=NNNNN

# 3. Open the app in agent-browser
agent-browser open http://localhost:$PORT

# 4. Wait for it to load (WebSocket RPC must connect)
agent-browser wait --load networkidle

# 5. You're connected — start automating
agent-browser snapshot -i
```

### Waiting for the app to be ready

After `dev3 dev-server start`, the build takes 10-20s. The remote access server starts after the Electrobun app launches.

**Check build progress:** `dev3 dev-server status` — if CPU is >100%, the build is still compiling. Once it drops, the server should be reachable.

```bash
# Open and wait — agent-browser retries internally
agent-browser open http://localhost:$PORT
agent-browser wait --load networkidle
```

If `open` fails with connection refused, the build isn't done yet. Wait a few seconds and retry.

## The `__dev3` automation bridge

The app exposes `window.__dev3` for programmatic control. Works in both agent-browser and agent-electrobun.

| Method | What it does |
|---|---|
| `__dev3.navigate(route)` | Programmatic navigation |
| `__dev3.getState()` | Returns current AppState (route, projects, tasks) |

**Always prefer `navigate()` over clicking through the UI.** It's instant and doesn't require finding elements.

**Availability:** Guarded by `globalThis.__DEV3_AUTOMATION` (true in dev/staging, false in production). Available in built assets served by the remote access server.

**State coupling:** Stick to `getState().route`, `getState().projects`, and `getState().currentProjectTasks` — these are stable across refactors.

### Route types

```javascript
__dev3.navigate({ screen: "dashboard" })
__dev3.navigate({ screen: "project", projectId: "..." })
__dev3.navigate({ screen: "project", projectId: "...", activeTaskId: "..." })  // split view
__dev3.navigate({ screen: "task", projectId: "...", taskId: "..." })           // fullscreen
__dev3.navigate({ screen: "project-settings", projectId: "..." })
__dev3.navigate({ screen: "settings" })
```

### Finding IDs and navigating

```bash
# Get project and task IDs
agent-browser eval '(() => {
  const s = window.__dev3.getState();
  return JSON.stringify({
    route: s.route,
    projects: s.projects.map(p => ({ id: p.id, name: p.name })),
    tasks: s.currentProjectTasks.map(t => ({ id: t.id, seq: t.seq, title: t.title?.substring(0, 40), status: t.status }))
  }, null, 2);
})()'

# Navigate to a task's split view
agent-browser eval '(() => {
  window.__dev3.navigate({ screen: "project", projectId: "PROJECT_ID", activeTaskId: "TASK_ID" });
  return "ok";
})()'

# Navigate to first project's board
agent-browser eval '(() => {
  const p = window.__dev3.getState().projects[0];
  if (!p) return "no projects";
  window.__dev3.navigate({ screen: "project", projectId: p.id });
  return "navigated to " + p.name;
})()'

# Navigate to a task by sequence number (e.g., #42)
agent-browser eval '(() => {
  const s = window.__dev3.getState();
  const task = s.currentProjectTasks.find(t => t.seq === 42);
  if (!task) return "task not found";
  const pid = s.route.screen === "project" ? s.route.projectId : s.projects[0]?.id;
  window.__dev3.navigate({ screen: "project", projectId: pid, activeTaskId: task.id });
  return "navigated to #" + task.seq;
})()'
```

## Interacting with elements

```bash
# Snapshot interactive elements
agent-browser snapshot -i

# Click by ref
agent-browser click @e27

# Fill an input (works natively with React — no workarounds needed)
agent-browser fill @e2 "my text here"

# Press a key
agent-browser press Escape
agent-browser press Enter

# Select dropdown option
agent-browser select @e5 "Bypass (Sonnet)"

# Wait for element to appear
agent-browser wait @e1

# Scoped snapshot (only elements within a CSS selector)
agent-browser snapshot -i -s "[data-panel='task-info']"
```

## UI flows

### Create a task

1. Navigate to the Kanban board.
2. `agent-browser snapshot -i` — find `+ New Task` button, click it.
3. A modal appears with a textarea.
4. `agent-browser fill @eNN "Describe what needs to be done..."` — fill the description.
5. `agent-browser wait 300` then `agent-browser snapshot -i` — confirm Save buttons are enabled.
6. Click `Save` or `Save & Start`.

### Run a task with a specific model/profile

1. Find the task's `Run` button and click it.
2. **Launch Task** modal appears with CLI and Profile dropdowns.
3. Select the desired profile, click `Launch`.

### Search tasks

```bash
agent-browser snapshot -i          # find the search input
agent-browser fill @eNN "query"    # fill it
agent-browser wait 500             # wait for filter
agent-browser snapshot -i          # see filtered results
```

## Verification patterns

### Assert element presence (prefer over screenshots)

```bash
# Menu is open (Restart/Stop visible)
agent-browser snapshot -i 2>&1 | grep -i "restart\|stop"

# Menu is closed (no matches = assertion passed)
agent-browser snapshot -i 2>&1 | grep -i "restart\|stop"

# Scoped assertion (only within a specific panel)
agent-browser snapshot -i -s "[data-menu='dev-server']" 2>&1 | grep "Restart"
```

### Assert current route

```bash
agent-browser eval '(() => {
  return JSON.stringify(window.__dev3.getState().route);
})()'
```

### Typical verification flow

```bash
PORT=14561  # set once from dev3 dev-server status

# 1. Open and wait
agent-browser open http://localhost:$PORT
agent-browser wait --load networkidle

# 2. Navigate to the view you need
agent-browser eval '(() => {
  window.__dev3.navigate({ screen: "project", projectId: "PID", activeTaskId: "TID" });
  return "ok";
})()'

# 3. Wait for render, find element, interact
agent-browser wait 300
agent-browser snapshot -i 2>&1 | grep "Dev Server"
# → @e27 button "Dev Server"
agent-browser click @e27

# 4. Assert the result
agent-browser wait 300
agent-browser snapshot -i 2>&1 | grep "Restart"
# Output present → menu opened
```

## Screenshots — last resort only

**Never use screenshots to diagnose or assert.** Every screenshot costs image tokens and adds latency. Before reaching for `screenshot`, ask: "can I express this as text?"

The answer is almost always yes:

| Instead of screenshot for... | Use this |
|---|---|
| "Is the page blank?" | `eval 'document.documentElement.outerHTML.slice(0, 300)'` |
| "Did the menu open?" | `snapshot -i \| grep -i "restart\|stop"` |
| "Did navigation work?" | `eval 'JSON.stringify(window.__dev3.getState().route)'` |
| "Is the element visible?" | `snapshot -i \| grep "element text"` |
| "Did the data load?" | `eval 'window.__dev3.getState().projects.length'` |
| "Is there an error?" | `eval 'document.body.innerText.slice(0, 500)'` |

**Only take a screenshot when:**
1. The user explicitly asks for one, OR
2. You need to show a human a pixel-level rendering defect that cannot be described in text

```bash
# Last resort only
agent-browser screenshot /tmp/dev3-screenshot.png
agent-browser screenshot --full /tmp/dev3-full.png
```

## Efficiency tips

- **Set `PORT` once** from `dev3 dev-server status` and reuse throughout the session.
- **Use `__dev3.navigate()`** instead of clicking through the UI. Click navigation wastes 5-10 commands.
- **Use `snapshot -i`** (interactive only) — much shorter output than full snapshot.
- **Use `snapshot -i | grep`** for assertions — faster, no image token cost, grep-able.
- **Re-snapshot after every click** that changes the DOM — refs are invalidated.
- **Use `agent-browser wait`** instead of `sleep` — `wait @e1` waits for an element, `wait --load networkidle` waits for network.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Connection refused on `open` | Build still compiling | Check `dev3 dev-server status` CPU; retry when it drops |
| App loads but shows errors | WebSocket RPC not connected | Ensure the Electrobun app is running (it hosts the RPC server) |
| Click didn't navigate | Clicked a non-active task card | Only in-progress tasks navigate on click. Use `__dev3.navigate()` |
| `fill` doubles characters | Only happens with agent-electrobun | Use agent-browser instead (native Playwright, no doubling) |

## Native/CDP mode

For terminal/PTY testing, native window features, or WebKit-specific bugs, see [native-cdp.md](./native-cdp.md). Requires creating a `.dev3_cdp` sentinel file and restarting the dev server.
