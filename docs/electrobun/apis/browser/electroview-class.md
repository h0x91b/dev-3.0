# Electroview Class

## Overview

The Electroview Class allows you to instantiate Electrobun APIs within the browser context.

```typescript
import { Electroview } from "electrobun/view";

const electrobun = new Electroview({ ...options });
```

## Constructor Options

### RPC (Remote Procedure Call)

This option establishes typed communication between the main Bun process and a BrowserView's browser context.

**Shared Type Definition Example:**

```typescript
// src/shared/types.ts
export type MyWebviewRPCType = {
  bun: RPCSchema<{
    requests: {
      someBunFunction: {
        params: { a: number; b: number };
        response: number;
      };
    };
    messages: {
      logToBun: { msg: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {
      someWebviewFunction: {
        params: { a: number; b: number };
        response: number;
      };
    };
    messages: {
      logToWebview: { msg: string };
    };
  }>;
};
```

**Browser-Side Implementation:**

```typescript
const rpc = Electroview.defineRPC<MyWebviewRPCType>({
  handlers: {
    requests: {
      someWebviewFunction: ({ a, b }) => {
        return a + b;
      },
    },
    messages: {
      logToWebview: ({ msg }) => {
        console.log(`bun asked me to logToWebview: ${msg}`);
      },
    },
  },
});

const electroview = new Electroview({ rpc });
```

**Calling Bun Functions from Browser:**

```typescript
electroview.rpc.request.someBunFunction({ a: 9, b: 8 }).then((result) => {
  console.log("result: ", result);
});

// Or send messages without waiting for response
electroview.rpc.send.logToBun({ msg: "hi from browser" });
```

## Static Methods

### defineRPC

Generates typed RPC and message functions for browser-to-Bun communication and establishes handler types for browser-side functions.

## Methods

### Browser-to-Browser RPC

Electrobun doesn't provide browser to browser RPC out of the box to maintain isolation and security. Instead, establish communication through Bun as an intermediary or use alternative web mechanisms like localStorage or WebRTC.
