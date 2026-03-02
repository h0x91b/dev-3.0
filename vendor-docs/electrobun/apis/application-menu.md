# Application Menu

## Overview

The Application Menu feature allows you to create and control application menus. On macOS, this appears as the menu bar in the top-left corner displaying options like File, Edit, and others.

## Import and Basic Usage

```typescript
import { ApplicationMenu } from "electrobun/bun";

ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit", role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      {
        label: "Custom Menu Item",
        action: "custom-action-1",
        tooltip: "I'm a tooltip",
      },
      {
        label: "Custom menu disabled",
        enabled: false,
        action: "custom-action-2",
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

Electrobun.events.on("application-menu-clicked", (e) => {
  console.log("application menu clicked", e.data.action);
});
```

## setApplicationMenu Function

This function accepts an array of menu items to configure your application menu.

### Menu Dividers

Create visual separators using either syntax:

```typescript
{ type: "divider" }
// or
{ type: "separator" }
```

## Default Roles

Menu items can specify a role to access built-in OS functionality with automatic keyboard shortcuts. Using roles enables features like `cmd+q` for quit or `cmd+c` and `cmd+v` for copy and paste.

### Supported Roles

- `quit`
- `hide`
- `hideOthers`
- `showAll`
- `undo`
- `redo`
- `cut`
- `copy`
- `paste`
- `pasteAndMatchStyle`
- `delete`
- `selectAll`
- `startSpeaking`
- `stopSpeaking`
- `enterFullScreen`
- `exitFullScreen`
- `toggleFullScreen`
- `minimize`
- `zoom`
- `bringAllToFront`
- `close`
- `cycleThroughWindows`
- `showHelp`

## Custom Menu Items

Instead of using a role, specify a custom action and listen for it via the `application-menu-clicked` event:

```typescript
{ label: "I am a menu item", action: "some-action" }
```

## Optional Properties

### enabled

Set to `false` to display a menu item as disabled.

### checked

Set to `true` to show a checkbox next to the menu item.

### hidden

Set to `true` to hide the menu item.

### tooltip

Displays a tooltip when hovering over the menu item.

### submenu

Create nested submenus within top-level menu items. Top-level menus correspond to items visible when the app is focused (File, Edit, View, etc.).

### accelerator

Define custom keyboard shortcuts for menu items:

```typescript
{
  label: "Save Project",
  action: "save-project",
  accelerator: "s"  // Cmd+S on macOS, Ctrl+S on Windows
}
```

The accelerator string specifies the key to bind. Command is the default modifier on macOS, while Ctrl is the default on Windows.

**Platform-Specific Support:**
- **macOS:** Full support for custom accelerators with Command as the default modifier
- **Windows:** Supports simple single-character accelerators
- **Linux:** Application menus are not currently supported

> **Note:** Using a role (like "copy" or "paste") automatically assigns the standard keyboard shortcut. Use `accelerator` only for custom actions.
