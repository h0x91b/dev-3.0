# BrowserWindow API

## Overview

The BrowserWindow API enables creation and management of browser windows in Electrobun applications. Here's a basic example:

```typescript
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  title: "my url window",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  url: "views://mainview/index.html",
});
```

## Constructor Options

### title

Sets the window's title text.

### frame

Defines window dimensions and position with properties for `width`, `height`, `x`, and `y` coordinates.

### styleMask

Controls macOS window appearance and functionality, including options like Borderless, Titled, Closable, Miniaturizable, Resizable, and others.

### titleBarStyle

Controls title bar appearance across all platforms with three values:

- `"default"`: Normal title bar with native window controls
- `"hidden"`: No title bar or native controls for fully custom chrome
- `"hiddenInset"`: Transparent title bar with inset native controls

### transparent

When enabled, creates windows with transparent backgrounds for floating widgets or non-rectangular windows. Requires matching CSS transparency.

### sandbox

Runs webview content in sandbox mode, disabling RPC while preserving event emission. This prevents malicious sites from accessing internal APIs when displaying untrusted content.

### url

Sets the initial URL for the window's default BrowserView, supporting both internet URLs and the `views://` scheme for bundled content.

### html

Accepts an HTML string to load directly instead of a URL.

### partition

Separates browser sessions for cookies and authentication. Prefix with `persist:` for persistent partitions.

### preload

Loads a preload script after HTML parsing but before page scripts execute, supporting URLs or inline JavaScript.

### rpc

Enables remote procedure calls between the main process and webview, allowing asynchronous function calls with type safety through shared schemas.

## Properties

### webview

Returns a getter for the window's default BrowserView instance.

## Methods

### Window Control

- `setTitle(title)`: Changes window title
- `close()`: Closes the window
- `focus()`: Brings window to front with focus

### Window State

- `minimize()` / `unminimize()` / `isMinimized()`: Manage minimized state
- `maximize()` / `unmaximize()` / `isMaximized()`: Manage maximized state
- `setFullScreen(bool)` / `isFullScreen()`: Toggle fullscreen mode
- `setAlwaysOnTop(bool)` / `isAlwaysOnTop()`: Keep window above others

### Window Positioning & Sizing

- `setPosition(x, y)`: Move window to specific coordinates
- `setSize(width, height)`: Resize window dimensions
- `setFrame(x, y, width, height)`: Change position and size simultaneously
- `getFrame()`: Retrieve position and size
- `getPosition()`: Get current x, y coordinates
- `getSize()`: Get current width and height

### Event Subscription

- `on(name, handler)`: Subscribe to window events

## Events

### close

Fires when a window closes. Per-window handlers execute before global handlers.

### resize

Triggered when width or height changes, including position data since resizing from corners may reposition.

### move

Fires when window position changes.

### focus

Occurs when window becomes key (gains focus), useful for tracking keyboard shortcuts.
