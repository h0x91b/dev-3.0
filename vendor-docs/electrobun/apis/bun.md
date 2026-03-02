# Bun API

## Overview

The Bun API serves as the primary process interface for managing application lifecycle, creating windows, handling system events, and establishing communication between your UI and the operating system.

## Getting Started

Electrobun functions as an npm dependency within your bun project. In Electrobun you simply write Typescript for the main process, when your app is all bundled up it will ship with a version of the bun runtime and it'll execute your main bun process with that, so any bun-compatible typescript is valid.

For initial setup guidance, refer to the [Getting Started Guide](../guides/quick-start.md).

## Import Methods

You can access the Bun API through explicit imports:

### Default Import

```typescript
import Electrobun from "electrobun/bun";

const win = new Electrobun.BrowserWindow(/*...*/);
```

### Named Imports

```typescript
import {
  BrowserWindow,
  ApplicationMenu,
  // other specified imports
} from "electrobun/bun";

const win = new BrowserWindow(/*...*/);
```

## Key Features

The Bun API enables:

- Application lifecycle management
- Window creation and management
- System event handling
- UI-to-operating system bridging

This API forms the foundation for building desktop applications with Electrobun using TypeScript in the main process.
