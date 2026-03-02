# Events

## Event System in the Main Bun Process

### Event Propagation

#### Global Events

Most events can be listened to directly on the object firing them or globally. Global event handlers execute first, followed by handlers in registration order.

**Exception:** Window `close` events fire per-window handlers before global handlers, ensuring window close logic runs before `exitOnLastWindowClosed`.

```typescript
// listen to global event
Electrobun.events.on("will-navigate", (e) => {
    // handle
});

// listen to event on object
win.webview.on("will-navigate", (e) => {
    // handle
});
```

#### Event.response

Some events allow setting a response, typically those initiated from Zig that require synchronous replies. This freezes the Zig process while Bun remains asynchronous.

```typescript
Electrobun.events.on("will-navigate", (e) => {
  e.response = { allow: true };
});
```

#### Event.responseWasSet

A property indicating whether the response has been assigned, useful when events propagate through multiple handlers.

#### Event.clearResponse

Call this method to clear a response set by a previous handler.

#### Event.data

Each event provides different data in its `data` property.

---

## Application Events

### open-url

Fires when the application opens via custom URL scheme (deep linking). macOS only.

**Event data:**
- `url` - Full URL used to open the app (e.g., `myapp://some/path?query=value`)

```typescript
Electrobun.events.on("open-url", (e) => {
  const url = new URL(e.data.url);
  console.log("Pathname:", url.pathname);
  console.log("Query:", url.searchParams.get("query"));
});
```

**Platform support:**
- **macOS:** Fully supported (app must be in `/Applications` folder)
- **Windows:** Not yet supported
- **Linux:** Not yet supported

Register URL schemes in `electrobun.config.ts`.

### before-quit

Fires before application quit, regardless of trigger source (`Utils.quit()`, `process.exit()`, `exitOnLastWindowClosed`, or updater).

Cancel the quit by setting `event.response = { allow: false }`.

```typescript
Electrobun.events.on("before-quit", (e) => {
  saveAppState();
});

Electrobun.events.on("before-quit", (e) => {
  if (hasUnsavedChanges()) {
    e.response = { allow: false };
  }
});
```

---

## Shutdown Lifecycle

### Quit Triggers

All these paths use the same lifecycle:

- Programmatic: `Utils.quit()`
- `process.exit()`
- `exitOnLastWindowClosed` when last window closes
- System-initiated (dock, Cmd+Q, taskbar close)
- Signals (Ctrl+C/SIGINT, SIGTERM)
- Updater restart

### Shutdown Sequence

1. `before-quit` event fires on the Bun worker thread
2. Handlers execute (cleanup, state saving, or cancellation)
3. If not cancelled, native event loop stops (CEF shuts down, windows close)
4. Process exits cleanly

**Linux note:** System-initiated quit paths don't currently fire `before-quit`. Programmatic quit works on all platforms.

### Ctrl+C Behavior (Dev Mode)

In dev mode (`bun dev`):

- **First Ctrl+C:** Fires `before-quit`, allowing cleanup
- **Second Ctrl+C:** Force-kills immediately
- **Safety timeout:** Auto force-kill after 10 seconds of hanging

### Comparison with Node.js / Bun Exit Events

| Event | Async | Can Cancel | Fires on quit | Notes |
|-------|-------|-----------|---------------|-------|
| `Electrobun.events.on("before-quit")` | Yes | Yes | Yes | Recommended for cleanup |
| `process.on("exit")` | No (sync) | No | Yes | Runs after before-quit; no async |
| `process.on("beforeExit")` | Yes | No | No | Doesn't fire with explicit `process.exit()` |

**Recommendation:** Use Electrobun's `before-quit` for shutdown cleanup. It fires for every quit path, supports async operations, and can cancel quitting.

### Example: Complete Shutdown Handling

```typescript
import Electrobun from "electrobun/bun";

Electrobun.events.on("before-quit", async (e) => {
  console.log("Saving application state...");
  await saveAppState();
  await closeDatabase();
  console.log("Cleanup complete, quitting.");
});

process.on("exit", (code) => {
  console.log("Process exiting with code:", code);
});
```
