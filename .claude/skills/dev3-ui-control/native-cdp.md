# Native/CDP mode — agent-electrobun

Use this mode when testing terminal/PTY features, native window behavior, or WebKit-specific rendering. For everything else, use the default agent-browser flow in the main SKILL.md.

## Enabling CDP mode

CDP mode requires CEF (Chromium Embedded Framework) to be bundled in the dev build. This is controlled by a sentinel file:

```bash
# Enable CDP mode
touch .dev3_cdp
dev3 dev-server restart   # rebuilds with CEF — slower build

# Disable CDP mode (return to browser mode)
rm .dev3_cdp
dev3 dev-server restart   # rebuilds without CEF — faster build
```

## Connecting

```bash
# 1. Get the CDP port
dev3 dev-server status
# → Assigned Ports: DEV3_PORT0=NNNNN

# 2. Set the port variable
CDP=NNNNN

# 3. Wait for the app to be ready (retry until it connects)
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell list 2>&1 || \
  (sleep 1.9 && QUIVER_CDP_PORT=$CDP agent-electrobun --target shell list 2>&1) || \
  (sleep 1.9 && QUIVER_CDP_PORT=$CDP agent-electrobun --target shell list 2>&1)

# 4. Start automating
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell snapshot -i
```

**Always use `--target shell`** — the app is a single-webview shell.

## Known limitations

- **`agent-electrobun tabs` fails** — `window.__quiverAutomation` is undefined. Use `--target shell` for everything.
- **`agent-electrobun keyboard press`** does not support key names like `Escape`. Use JS eval instead (see below).
- **Refs (`@e1`, `@e2`...) invalidate** on any DOM change. Re-snapshot after every click.
- **`fill` / `keyboard type` doubles characters** in React controlled inputs. Use the JS eval workaround below.

## React input workaround

agent-electrobun's `fill` and `keyboard type` cause character doubling with React. Use this pattern instead:

For `<textarea>`:
```bash
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell eval '(() => {
  const el = document.querySelector("textarea[placeholder=\"YOUR_PLACEHOLDER\"]");
  if (!el) return "not found";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, "YOUR TEXT HERE");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "done";
})()'
```

For `<input>`:
```bash
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell eval '(() => {
  const el = document.querySelector("input[placeholder=\"YOUR_PLACEHOLDER\"]");
  if (!el) return "not found";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, "YOUR TEXT HERE");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "done";
})()'
```

## Dispatching keyboard events

```bash
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell eval \
  'document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))'
```

## Navigation and state

The `__dev3` bridge works identically in CDP mode. The only difference is the command prefix:

```bash
# agent-browser (browser mode):
agent-browser eval '(() => { window.__dev3.navigate({...}); return "ok"; })()'

# agent-electrobun (CDP mode):
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell eval '(() => { window.__dev3.navigate({...}); return "ok"; })()'
```

All route types and recipes from the main SKILL.md apply — just swap the command prefix.

## Screenshots

```bash
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell screenshot /tmp/dev3-screenshot.png
QUIVER_CDP_PORT=$CDP agent-electrobun --target shell screenshot --annotate /tmp/dev3-annotated.png
```

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `ConnectionRefused` on `list` | Build still compiling | Check `dev3 dev-server status` CPU; retry when it drops |
| Build doesn't bundle CEF | `.dev3_cdp` file missing | `touch .dev3_cdp && dev3 dev-server restart` |
| Two instances can't run simultaneously | CFBundleIdentifier conflict | Each task needs a unique `DEV3_PORT0` (handled by port pool) |
| Snapshot shows nothing | App hasn't loaded yet | Wait 1-2s after `list` succeeds, then retry |
