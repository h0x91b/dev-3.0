# The `<electrobun-webview>` Tag

## Overview

The `<electrobun-webview>` tag implements an Out-Of-Process IFrame (OOPIF), offering secure and isolated web content embedding. It differs fundamentally from traditional iframes and Electron's deprecated `<webview>` tag by providing full process isolation while maintaining seamless DOM integration.

## Why Not Regular IFrames?

Standard iframes have substantial limitations for desktop applications:

- Security restrictions preventing cross-domain content loading
- Limited customization and same-origin policy bypass capabilities
- Performance constraints due to shared processes with parent pages
- Restricted access to native APIs and advanced browser features

## The OOPIF Advantage

Out-Of-Process IFrames overcome these constraints by:

- Running each webview in its own isolated process
- Creating complete security boundaries between host and embedded content
- Enabling independent resource allocation and crash protection
- Providing full content control and permission management

## How It Works

The `<electrobun-webview>` tag functions as a layered component synchronized with the DOM element's position and size, delivering:

1. **DOM Integration**: Styling, animating, and positioning using CSS like any DOM element
2. **Process Separation**: Content runs in completely isolated processes
3. **Transparent Layering**: Support for transparency and layering effects
4. **Native Performance**: Direct rendering without iframe restrictions

## Key Features

### Full Isolation

Each webview operates independently, ensuring crash protection, memory isolation, and security boundaries between content sources.

### Seamless Communication

Fast inter-process communication between the Bun main process, host webview, and individual OOPIF webviews.

### Not Deprecated

Unlike Electron's implementation (deprecated for removal in January 2025), Electrobun's approach was built from the ground up for continued support.

## Usage Example

```html
<electrobun-webview
  src="https://electrobun.dev"
  style="width: 100%; height: 500px;">
</electrobun-webview>
```

## Architecture Benefits

- **Security**: Process isolation prevents cross-site attacks
- **Reliability**: Crash isolation protects the broader application
- **Performance**: Independent resource allocation and rendering
- **Flexibility**: Complete content control without iframe limitations
- **Future-proof**: Independent of deprecated Chromium features
