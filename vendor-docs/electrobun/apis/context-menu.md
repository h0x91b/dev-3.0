# Context Menu

## Overview

The Context Menu API enables displaying native context menus at the mouse cursor position, even globally across your screen when other applications are focused. You can wire up right-click events from the browser context or create menus entirely from the Bun runtime.

## Basic Usage

```typescript
import { ContextMenu } from "electrobun/bun";

// Display a context menu at the mouse cursor after 5 seconds
setTimeout(() => {
  ContextMenu.showContextMenu([
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
  ]);
}, 5000);

Electrobun.events.on("context-menu-clicked", (e) => {
  console.log("context event", e.data.action);
});
```

## Menu Item Properties

### accelerator

Set custom keyboard shortcut hints displayed next to menu item labels:

```typescript
ContextMenu.showContextMenu([
  {
    label: "Save",
    action: "save",
    accelerator: "s"  // Shows Cmd+S on macOS
  },
  {
    label: "New Tab",
    action: "new-tab",
    accelerator: "t"
  },
  { type: "separator" },
  { role: "copy" },
  { role: "paste" },
]);
```

**Platform Support:**
- **macOS:** Full support with Command as default modifier
- **Windows:** Simple single-character accelerators supported
- **Linux:** Context menus not currently supported

### Additional Properties

- **label:** Displayed text for the menu item
- **action:** String identifier emitted when clicked
- **role:** Built-in role instead of custom action (e.g., "copy", "paste", "cut")
- **enabled:** Set to `false` to disable the item
- **checked:** Set to `true` to show a checkbox
- **hidden:** Set to `true` to hide the item
- **tooltip:** Hover text displayed on the item
- **data:** Arbitrary data passed with the click event
- **submenu:** Nested array of menu items for submenus
