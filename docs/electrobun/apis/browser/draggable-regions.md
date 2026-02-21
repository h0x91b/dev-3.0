# Draggable Regions

## Overview

Configure an HTML element to function as a draggable region allowing you to move the native application window by clicking and dragging on the element.

This feature enables developers to create custom window chrome in frameless Electrobun applications, particularly useful when designing custom titlebars.

## Implementation Steps

### Step 1: Initialize Electroview

```typescript
// /src/mainview/index.ts
import { Electroview } from "electrobun/view";

const electrobun = new Electroview();
```

### Step 2: Apply Draggable Region CSS Class

Add the `electrobun-webkit-app-region-drag` CSS class to elements you want to function as draggable regions:

```html
<div class="electrobun-webkit-app-region-drag">
  click here and drag to move this window
</div>
```

### Step 3: Exclude Interactive Elements

Use the `electrobun-webkit-app-region-no-drag` class on interactive elements (buttons, inputs) within draggable regions to prevent drag interference:

```html
<div class="titlebar electrobun-webkit-app-region-drag">
    <div class="window-controls electrobun-webkit-app-region-no-drag">
        <button class="close-btn" id="closeBtn"></button>
        <button class="minimize-btn" id="minimizeBtn"></button>
        <button class="maximize-btn" id="maximizeBtn"></button>
    </div>
    <span class="title">My App</span>
</div>
```

## Complete Custom Titlebar Example

### Bun Process Configuration

```typescript
import { BrowserWindow, BrowserView } from "electrobun/bun";

const rpc = BrowserView.defineRPC({
  handlers: {
    requests: {},
    messages: {
      closeWindow: () => win.close(),
      minimizeWindow: () => win.minimize(),
      maximizeWindow: () => {
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      },
    },
  },
});

const win = new BrowserWindow({
  title: "Custom Titlebar",
  url: "views://mainview/index.html",
  frame: { width: 800, height: 600, x: 100, y: 100 },
  titleBarStyle: "hidden",
  rpc,
});
```

### Browser Process Setup

```typescript
import { Electroview } from "electrobun/view";

const electrobun = new Electroview();

document.getElementById("closeBtn")?.addEventListener("click", () => {
  electrobun.rpc.send.closeWindow();
});

document.getElementById("minimizeBtn")?.addEventListener("click", () => {
  electrobun.rpc.send.minimizeWindow();
});

document.getElementById("maximizeBtn")?.addEventListener("click", () => {
  electrobun.rpc.send.maximizeWindow();
});
```

### HTML Structure

```html
<div class="titlebar electrobun-webkit-app-region-drag">
    <div class="window-controls electrobun-webkit-app-region-no-drag">
        <button class="close-btn" id="closeBtn"></button>
        <button class="minimize-btn" id="minimizeBtn"></button>
        <button class="maximize-btn" id="maximizeBtn"></button>
    </div>
    <span class="title">My App</span>
</div>
<main>
    <!-- Your app content here -->
</main>
```

### CSS Styling

```css
.titlebar {
    height: 32px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    background: #2d2d2d;
    user-select: none;
}

.window-controls {
    display: flex;
    gap: 8px;
}

.window-controls button {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
}

.close-btn { background: #ff5f57; }
.minimize-btn { background: #febc2e; }
.maximize-btn { background: #28c840; }

.title {
    flex: 1;
    text-align: center;
    font-size: 13px;
    color: #ccc;
}
```

## Related Resources

Consult the [BrowserWindow API](../browser-window.md) documentation for additional details on `titleBarStyle` and `transparent` window configuration options.
