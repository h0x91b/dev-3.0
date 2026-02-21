# Utils

## Overview

Various utilities for Electrobun apps accessible via the Utils module.

```typescript
import { Utils } from "electrobun/bun";
```

## File System Operations

### moveToTrash

Move files or folders to the Trash/recycle bin. Note that macOS doesn't enable the restore button when using this method programmatically.

```typescript
Utils.moveToTrash(absolutePath);
```

### showItemInFolder

Open the file manager and select a specified file or folder.

```typescript
Utils.showItemInFolder(absolutePath);
```

## URL and File Opening

### openExternal

Open URLs in the default browser or appropriate application. Supports `http://`, `https://`, `mailto:`, custom URL schemes, and more.

**Parameters:**
- `url` (string): The URL to open

**Returns:** `boolean` - true if successful, false otherwise

**Examples:**

```typescript
Utils.openExternal("https://example.com");
Utils.openExternal("mailto:user@example.com?subject=Help");
Utils.openExternal("slack://open");
Utils.openExternal("file:///Users/me/Documents/report.pdf");
```

### openPath

Open files or folders with their default applications.

**Parameters:**
- `path` (string): Absolute file or folder path

**Returns:** `boolean` - true if successful, false otherwise

**Examples:**

```typescript
Utils.openPath("/Users/me/Documents/report.pdf");
Utils.openPath("/Users/me/Pictures/photo.jpg");
Utils.openPath("/Users/me/Downloads");
Utils.openPath("/Users/me/notes.txt");
```

**Key Difference:** Use `openExternal()` for URLs with protocols; use `openPath()` for file system paths.

## Notifications

### showNotification

Display native desktop notifications across macOS, Windows, and Linux.

**Options:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| title | string | Yes | Notification title |
| body | string | No | Main body text |
| subtitle | string | No | Additional subtitle line |
| silent | boolean | No | Disable sound (default: false) |

**Examples:**

```typescript
Utils.showNotification({
    title: "Download Complete"
});

Utils.showNotification({
    title: "New Message",
    body: "You have a new message from John"
});

Utils.showNotification({
    title: "Reminder",
    subtitle: "Calendar Event",
    body: "Team meeting in 15 minutes",
    silent: false
});
```

**Platform Notes:**
- **macOS:** Uses NSUserNotificationCenter; notifications appear in Notification Center
- **Windows:** Shell balloon notifications appear near system tray
- **Linux:** Uses `notify-send` command (requires `libnotify-bin`)

## Dialog Functions

### openFileDialog

Open file selection dialogs allowing users to choose files or folders.

```typescript
const chosenPaths = await Utils.openFileDialog({
    startingFolder: join(homedir(), "Desktop"),
    allowedFileTypes: "*",
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: true,
});

console.log("chosen paths", chosenPaths);
```

### showMessageBox

Display native message box dialogs with custom buttons and capture user responses.

**Options:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| type | string | "info" | Dialog type: "info", "warning", "error", "question" |
| title | string | "" | Window title |
| message | string | "" | Main message |
| detail | string | "" | Additional detail text |
| buttons | string[] | ["OK"] | Button labels |
| defaultId | number | 0 | Default focused button index |
| cancelId | number | -1 | Button index for cancellation |

**Returns:** `Promise<{ response: number }>` - Index of clicked button

**Examples:**

```typescript
// Confirmation Dialog
const { response } = await Utils.showMessageBox({
    type: "question",
    title: "Confirm Delete",
    message: "Are you sure you want to delete this file?",
    detail: "This action cannot be undone.",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1
});

if (response === 0) {
    console.log("Deleting file...");
}

// Error Dialog
await Utils.showMessageBox({
    type: "error",
    title: "Error",
    message: "Failed to save file",
    detail: "The disk may be full or write permissions are insufficient.",
    buttons: ["OK"]
});

// Multi-choice Dialog
const { response: r } = await Utils.showMessageBox({
    type: "warning",
    title: "Unsaved Changes",
    message: "You have unsaved changes.",
    detail: "What would you like to do?",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2
});

switch (r) {
    case 0: saveAndClose(); break;
    case 1: closeWithoutSaving(); break;
    case 2: /* cancelled */ break;
}
```

## Application Control

### quit

Gracefully terminate the application. Fires a `before-quit` event that can cancel the operation, then performs cleanup and terminates the process.

```typescript
Utils.quit();

// Cancel quit via event
Electrobun.events.on("before-quit", (e) => {
  if (hasUnsavedChanges()) {
    e.response = { allow: false };
  }
});
```

Electrobun automatically routes system-initiated quits and intercepts `process.exit()` calls through this lifecycle.

## Clipboard API

### clipboardReadText

Read text from the system clipboard.

```typescript
const text = Utils.clipboardReadText();
if (text) {
    console.log("Clipboard contains:", text);
}
```

### clipboardWriteText

Write text to the system clipboard.

```typescript
Utils.clipboardWriteText("Hello from Electrobun!");
```

### clipboardReadImage

Read image data from clipboard as PNG. Returns `Uint8Array` or `null`.

```typescript
const pngData = Utils.clipboardReadImage();
if (pngData) {
    await Bun.write("clipboard-image.png", pngData);
    console.log("Saved clipboard image:", pngData.length, "bytes");
}
```

### clipboardWriteImage

Write PNG image data to the clipboard.

```typescript
const pngData = await Bun.file("image.png").arrayBuffer();
Utils.clipboardWriteImage(new Uint8Array(pngData));
```

### clipboardClear

Clear clipboard contents.

```typescript
Utils.clipboardClear();
```

### clipboardAvailableFormats

Get available formats in clipboard. Returns array of format names.

```typescript
const formats = Utils.clipboardAvailableFormats();
console.log("Clipboard contains:", formats);
// Possible values: ["text", "image", "files", "html"]
```

## Paths

Cross-platform access to common OS directories and app-scoped directories. All properties are synchronous getters.

```typescript
import { Utils } from "electrobun/bun";

console.log(Utils.paths.home);      // Home directory
console.log(Utils.paths.downloads); // Downloads folder
console.log(Utils.paths.userData);  // App-specific data directory
```

### OS Directories

| Path | macOS | Windows | Linux |
|------|-------|---------|-------|
| `Utils.paths.home` | `~` | `%USERPROFILE%` | `~` |
| `Utils.paths.appData` | `~/Library/Application Support` | `%LOCALAPPDATA%` | `$XDG_DATA_HOME` or `~/.local/share` |
| `Utils.paths.config` | `~/Library/Application Support` | `%APPDATA%` | `$XDG_CONFIG_HOME` or `~/.config` |
| `Utils.paths.cache` | `~/Library/Caches` | `%LOCALAPPDATA%` | `$XDG_CACHE_HOME` or `~/.cache` |
| `Utils.paths.temp` | `$TMPDIR` | `%TEMP%` | `/tmp` |
| `Utils.paths.logs` | `~/Library/Logs` | `%LOCALAPPDATA%` | `$XDG_STATE_HOME` or `~/.local/state` |
| `Utils.paths.documents` | `~/Documents` | `%USERPROFILE%\Documents` | `$XDG_DOCUMENTS_DIR` or `~/Documents` |
| `Utils.paths.downloads` | `~/Downloads` | `%USERPROFILE%\Downloads` | `$XDG_DOWNLOAD_DIR` or `~/Downloads` |
| `Utils.paths.desktop` | `~/Desktop` | `%USERPROFILE%\Desktop` | `$XDG_DESKTOP_DIR` or `~/Desktop` |
| `Utils.paths.pictures` | `~/Pictures` | `%USERPROFILE%\Pictures` | `$XDG_PICTURES_DIR` or `~/Pictures` |
| `Utils.paths.music` | `~/Music` | `%USERPROFILE%\Music` | `$XDG_MUSIC_DIR` or `~/Music` |
| `Utils.paths.videos` | `~/Movies` | `%USERPROFILE%\Videos` | `$XDG_VIDEOS_DIR` or `~/Videos` |

### App-Scoped Directories

These paths are scoped to your application using the `identifier` and `channel` from your app's `version.json`.

```typescript
Utils.paths.userData   // {appData}/{identifier}/{channel}
Utils.paths.userCache  // {cache}/{identifier}/{channel}
Utils.paths.userLogs   // {logs}/{identifier}/{channel}

// Example: app with identifier "com.mycompany.myapp", channel "canary", on macOS:
// Utils.paths.userData   => ~/Library/Application Support/com.mycompany.myapp/canary
// Utils.paths.userCache  => ~/Library/Caches/com.mycompany.myapp/canary
// Utils.paths.userLogs   => ~/Library/Logs/com.mycompany.myapp/canary
```

**Linux XDG Support:** User directories on Linux are resolved from `~/.config/user-dirs.dirs` with fallbacks like `~/Documents`.

## GlobalShortcut

Register global keyboard shortcuts that work even when your app lacks focus.

```typescript
import { GlobalShortcut } from "electrobun/bun";
```

### register

Register a global keyboard shortcut with a callback function.

```typescript
const success = GlobalShortcut.register("CommandOrControl+Shift+Space", () => {
    console.log("Global shortcut triggered!");
});

if (!success) {
    console.log("Failed to register shortcut (may already be in use)");
}
```

### unregister

```typescript
GlobalShortcut.unregister("CommandOrControl+Shift+Space");
```

### unregisterAll

```typescript
GlobalShortcut.unregisterAll();
```

### isRegistered

```typescript
if (GlobalShortcut.isRegistered("CommandOrControl+Shift+Space")) {
    console.log("Shortcut is active");
}
```

### Accelerator Syntax

Accelerators describe keyboard shortcuts using modifier keys and a regular key separated by `+`.

**Modifiers:**
- `Command` / `Cmd` - Command key (macOS)
- `Control` / `Ctrl` - Control key
- `CommandOrControl` / `CmdOrCtrl` - Command on macOS, Control on Windows/Linux
- `Alt` / `Option` - Alt key (Option on macOS)
- `Shift` - Shift key
- `Super` / `Meta` / `Win` - Windows/Super key

**Keys:**
- Letters: `A` through `Z`
- Numbers: `0` through `9`
- Function keys: `F1` through `F12`
- Special: `Space`, `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`
- Navigation: `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`
- Symbols: `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `` ` ``

**Platform Notes:**
- **macOS:** Uses NSEvent monitoring; shortcuts observed but cannot block other apps
- **Windows:** Uses RegisterHotKey for exclusive access
- **Linux:** Uses X11 XGrabKey for exclusive access (requires X11 display server)

## Screen

Provides information about connected displays and cursor position for window positioning and multi-monitor detection.

```typescript
import { Screen } from "electrobun/bun";
```

### Types

```typescript
interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Display {
  id: number;
  bounds: Rectangle;
  workArea: Rectangle;
  scaleFactor: number;
  isPrimary: boolean;
}

interface Point {
  x: number;
  y: number;
}
```

### Screen.getPrimaryDisplay()

Returns the primary display information.

```typescript
const primary = Screen.getPrimaryDisplay();
console.log(`Primary display: ${primary.bounds.width}x${primary.bounds.height}`);
console.log(`Scale factor: ${primary.scaleFactor}x`);
```

### Screen.getAllDisplays()

Returns an array of all connected displays.

```typescript
const displays = Screen.getAllDisplays();
console.log(`Found ${displays.length} display(s)`);
```

### Screen.getCursorScreenPoint()

Returns the current cursor position in screen coordinates.

```typescript
const cursor = Screen.getCursorScreenPoint();
console.log(`Cursor at: (${cursor.x}, ${cursor.y})`);
```

**Platform Notes:**
- **macOS:** Uses NSScreen and CGMainDisplayID; coordinates converted from bottom-left to top-left origin
- **Windows:** Uses EnumDisplayMonitors and GetDpiForMonitor for scale factor
- **Linux:** Uses GDK monitor APIs

## Session

Provides cookie and storage management for webview partitions. Each partition maintains isolated storage.

```typescript
import { Session } from "electrobun/bun";
```

### Session.fromPartition(partition)

Get or create a session for a specific partition. Partitions starting with `persist:` are stored on disk; others are ephemeral.

```typescript
const session = Session.fromPartition("persist:myapp");
const tempSession = Session.fromPartition("temp");
```

### Session.defaultSession

Get the default session (equivalent to `persist:default` partition).

```typescript
const session = Session.defaultSession;
```

### session.cookies.get(filter?)

Get cookies matching optional filter criteria.

```typescript
const allCookies = session.cookies.get();
const authCookies = session.cookies.get({ name: "auth_token" });
const domainCookies = session.cookies.get({ domain: "example.com" });
```

### session.cookies.set(cookie)

Set a cookie. Returns `true` if successful.

```typescript
session.cookies.set({
  name: "auth_token",
  value: "abc123xyz",
  domain: "api.myapp.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  expirationDate: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
});
```

### session.cookies.remove(url, name)

Remove a specific cookie by URL and name.

```typescript
session.cookies.remove("https://myapp.com", "user_id");
```

### session.cookies.clear()

Clear all cookies for this session.

### session.clearStorageData(types?)

Clear storage data for this session. Specify types or use `'all'`.

```typescript
session.clearStorageData(['cookies', 'localStorage']);
```

**Partition Naming:** Use `persist:` prefix for persistent storage (e.g., `persist:myapp`). Sessions without this prefix clear when the app closes.
