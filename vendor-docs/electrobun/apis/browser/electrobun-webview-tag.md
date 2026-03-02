# Electrobun Webview Tag

## Introduction

Electrobun's webview tag functions as an enhanced iframe with important distinctions. It acts as a positional anchor within the DOM, communicating with a Zig backend to manage a distinct, isolated BrowserView, ensuring complete content separation from the host webview.

## Basic Usage

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>webview tag test</title>
    <script src="views://webviewtag/index.js"></script>
  </head>
  <body>
    <electrobun-webview src="https://electrobun.dev"></electrobun-webview>
  </body>
</html>
```

## Compatibility

The implementation integrates seamlessly with reactive frameworks like React or SolidJS. The HTML element serves as a positional anchor that reports its position and relays events to Zig, which manages a completely separate BrowserView overlaid at matching coordinates.

## Differences from Electron's Webview Tag

### Chrome's Deprecation

Electron's webview tag relies on a Chrome feature deprecated since 2020. Chrome's developer documentation notes it "remains supported for Enterprise and Education customers on ChromeOS until at least Jan 2025."

Electrobun implements its own independent solution, eliminating dependence on Chrome's deprecated API and ensuring long-term stability.

### Separate Layer Architecture

Because Electrobun uses a div anchor with a separate isolated BrowserView positioned above the parent, it provides specialized methods for edge cases where users need to interact with the parent document. These include screenshot mirroring and image streaming capabilities.

## Properties and Attributes

| Property | Type | Description |
|----------|------|-------------|
| `src` | string | URL of the web page to load |
| `html` | string | HTML content to load directly |
| `preload` | string | Script path to preload before other scripts |
| `partition` | string | Separate storage partition for different sessions |
| `sandbox` | boolean | Sandbox mode (disables RPC, allows events only) |
| `transparent` | boolean | Makes webview transparent |
| `passthroughEnabled` | boolean | Enables mouse/touch passthrough |
| `hidden` | boolean | Controls visibility |
| `delegateMode` | boolean | Delegates input to webview when mirrored |
| `hiddenMirrorMode` | boolean | Hides and mirrors webview for transitions |
| `wasZeroRect` | boolean | Indicates previous zero dimensions |
| `webviewId` | number | Unique identifier |
| `id` | string | DOM ID |

### Sandbox Mode Details

In sandbox mode:

- Events (dom-ready, did-navigate, etc.) function normally
- Navigation controls work (loadURL, goBack, goForward, reload)
- RPC communication is completely disabled
- Webview content cannot access application APIs

```html
<electrobun-webview
  src="https://untrusted-site.com"
  sandbox
></electrobun-webview>
```

## Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `callAsyncJavaScript` | `{ script: string }` | Promise | Executes JS asynchronously |
| `canGoBack` | -- | Promise\<boolean\> | Determines backward navigation ability |
| `canGoForward` | -- | Promise\<boolean\> | Determines forward navigation ability |
| `on` | event, listener | -- | Attaches event listeners |
| `off` | event, listener | -- | Detaches event listeners |
| `syncDimensions` | force?: boolean | -- | Synchronizes DOM dimensions |
| `goBack` | -- | -- | Navigate back |
| `goForward` | -- | -- | Navigate forward |
| `reload` | -- | -- | Reload content |
| `loadURL` | url: string | -- | Load specific URL |
| `setNavigationRules` | rules: string[] | -- | Set allow/block URL patterns |
| `syncScreenshot` | callback?: () => void | -- | Captures and syncs screenshot |
| `clearScreenImage` | -- | -- | Clears background image |
| `tryClearScreenImage` | -- | -- | Attempts conditional clearing |
| `toggleTransparent` | transparent?, bypassState? | -- | Toggles transparency |
| `togglePassthrough` | enablePassthrough?, bypassState? | -- | Toggles event passthrough |
| `toggleHidden` | hidden?, bypassState? | -- | Toggles visibility |
| `toggleDelegateMode` | delegateMode? | -- | Toggles delegate mode |
| `toggleHiddenMirrorMode` | force: boolean | -- | Toggles mirror mode |

### Navigation Rules Format

Rules use glob-style wildcards where `*` matches any characters:

- Prefix with `^` for block rules
- Rules without `^` are allow rules
- Evaluated top-to-bottom; last match wins
- Default: allow if no rule matches

```javascript
// Block everything except specific domains
document.querySelector("electrobun-webview").setNavigationRules([
  "^*",                           // Block everything
  "*://en.wikipedia.org/*",       // Allow Wikipedia
  "*://upload.wikimedia.org/*",   // Allow Wikipedia images
]);
```

## Events

Use the `on` method to listen for events dispatched as CustomEvents:

| Event | Description |
|-------|-------------|
| `dom-ready` | DOM finished loading |
| `did-navigate` | Navigated to new URL |
| `did-navigate-in-page` | In-page navigation (hash changes) |
| `did-commit-navigation` | Committed to navigating |
| `new-window-open` | Attempted to open new window |
| `host-message` | Preload script sent message to host |

```javascript
document.querySelector("electrobun-webview").on("host-message", (event) => {
  console.log("Received message from webview:", event.detail);
});
```

## Preload Scripts

Preload scripts execute in the webview context before page scripts load and have access to special communication APIs.

### window.__electrobunSendToHost(message)

Sends messages from preload scripts to the host BrowserWindow, received via the `host-message` event:

```javascript
// Forward click events
document.addEventListener("click", (e) => {
  window.__electrobunSendToHost({
    type: "click",
    target: e.target.tagName,
    x: e.clientX,
    y: e.clientY,
  });
});

// Forward keyboard events
document.addEventListener("keydown", (e) => {
  window.__electrobunSendToHost({
    type: "keydown",
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  });
});
```

> **Note:** This function is only available in preload scripts, not in regular page scripts.

## Security Considerations

### Sandbox Mode

Always use the sandbox attribute for untrusted content to completely disable RPC communication.

### Navigation Rules

Restrict webview navigation destinations:

```javascript
const webview = document.querySelector("electrobun-webview");

webview.setNavigationRules([
  "^*",                              // Block by default
  "*://trusted-domain.com/*",        // Allow specific domains
  "*://cdn.trusted-domain.com/*",    // Allow associated CDNs
]);
```

### Process Isolation

Each webview runs in a separate browser process providing:

- Memory isolation from malicious content
- Crash isolation
- Security boundary for browser exploits

### Best Practices

- Always sandbox untrusted content
- Use navigation rules to prevent malicious redirects
- Use partitions to isolate session storage
- Validate and sanitize host messages
- Prefer HTTPS; block HTTP with navigation rules

```html
<!-- Complete secure configuration -->
<electrobun-webview
  id="secure-webview"
  src="https://third-party-widget.com"
  sandbox
  partition="third-party-widget"
></electrobun-webview>

<script>
  const webview = document.getElementById("secure-webview");

  webview.setNavigationRules([
    "^http://*",                         // Block HTTP
    "^*",                                // Block by default
    "*://third-party-widget.com/*",      // Allow widget domain
  ]);

  webview.on("did-navigate", (e) => {
    console.log("Navigation:", e.detail.url);
  });
</script>
```
