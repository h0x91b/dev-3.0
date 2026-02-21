# Creating UI

## Overview

This guide builds on the Hello World tutorial to add user interface elements. The example creates a simple web browser application using Electrobun's view system.

## File Structure Setup

Create a new folder `src/main-ui/` with an `index.ts` file. The Electrobun CLI will automatically transpile this into javascript and make it available at the url `views://main-ui/index.js`.

## TypeScript Implementation

Create the main UI logic file with browser control functions:

```typescript
import { Electroview } from "electrobun/view";

const electrobun = new Electroview({ rpc: null });

window.loadPage = () => {
  const newUrl = document.querySelector("#urlInput").value;
  const webview = document.querySelector(".webview");
  webview.src = newUrl;
};

window.goBack = () => {
  const webview = document.querySelector(".webview");
  webview.goBack();
};

window.goForward = () => {
  const webview = document.querySelector(".webview");
  webview.goForward();
};
```

## HTML Template

Create an HTML file importing the transpiled JavaScript:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Web Browser</title>
    <script src="views://main-ui/index.js"></script>
</head>
<body>
    <h1>My Web Browser</h1>
    <input type="text" id="urlInput" placeholder="Enter URL">
    <button onclick="loadPage()">Go</button>
    <button onclick="goBack()">Back</button>
    <button onclick="goForward()">Forward</button>
    <electrobun-webview class="webview" width="100%" height="100%"
                        src="https://electrobun.dev">
    </electrobun-webview>
</body>
</html>
```

## Configuration Update

Update `electrobun.config.ts` to include view transpilation and asset copying:

```typescript
export default {
  app: {
    name: "My App",
    identifier: "dev.my.app",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      "main-ui": {
        entrypoint: "src/main-ui/index.ts",
      },
    },
    copy: {
      "src/main-ui/index.html": "views/main-ui/index.html",
    },
  },
};
```

## Main Process Update

Update the Bun process to load the HTML file:

```typescript
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  title: "Hello Electrobun",
  url: "views://main-ui/index.html",
});
```

## Adding Application Menu

Enable keyboard shortcuts by implementing an ApplicationMenu:

```typescript
import { BrowserWindow, ApplicationMenu } from "electrobun/bun";

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

const win = new BrowserWindow({
  title: "Hello Electrobun",
  url: "views://main-ui/index.html",
});
```

## Running the Application

Execute `bun start` in the terminal to rebuild and launch. The application enables URL navigation and browsing controls, with standard edit menu keyboard shortcuts now functional.
