# Build Configuration

## Overview

Electrobun uses `electrobun.config.ts` in your project root to control how your application is built and packaged. The config file uses TypeScript with ESM syntax, providing type safety and modern JavaScript features.

### Basic Structure

```typescript
// electrobun.config.ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
  },
} satisfies ElectrobunConfig;
```

## Bun Bundler Options

Both `build.bun` and each entry in `build.views` accept all Bun.build() options as pass-through properties. Only `entrypoint` is required; everything else is optional.

Electrobun automatically controls `entrypoints`, `outdir`, and `target`. All other Bun bundler options pass through directly.

### Available Options

| Option | Type | Description |
|--------|------|-------------|
| `plugins` | `BunPlugin[]` | Bundler plugins for CSS modules, SVG imports, etc. |
| `external` | `string[]` | Modules to exclude from bundling |
| `sourcemap` | `"none" \| "linked" \| "inline" \| "external"` | Source map generation |
| `minify` | `boolean \| { whitespace, identifiers, syntax }` | Minification options |
| `splitting` | `boolean` | Enable code splitting for shared modules |
| `define` | `Record<string, string>` | Global identifier replacements at build time |
| `loader` | `Record<string, Loader>` | Custom file extension loaders |
| `format` | `"esm" \| "cjs" \| "iife"` | Output module format |
| `naming` | `string \| { chunk, entry, asset }` | Output file naming patterns |
| `banner` | `string` | Prepend text to output |
| `drop` | `string[]` | Remove function calls (e.g., `["console", "debugger"]`) |
| `env` | `"inline" \| "disable" \| "PREFIX_*"` | Environment variable handling |
| `jsx` | `{ runtime, importSource, factory, fragment }` | JSX transform configuration |
| `packages` | `"bundle" \| "external"` | Bundle or externalize all packages |

### Example: Using Plugins

```typescript
import type { ElectrobunConfig } from "electrobun";
import myPlugin from "./plugins/my-plugin";

export default {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      plugins: [myPlugin()],
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
        plugins: [myPlugin()],
        sourcemap: "linked",
      },
    },
  },
} satisfies ElectrobunConfig;
```

### Example: Minification and Source Maps

```typescript
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  build: {
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
        minify: true,
        sourcemap: "linked",
        define: {
          "process.env.NODE_ENV": '"production"',
        },
        drop: ["console"],
      },
    },
  },
} satisfies ElectrobunConfig;
```

> **Note:** Since `electrobun.config.ts` is a real TypeScript module, you can dynamically construct plugins and configuration.

## URL Schemes (Deep Linking)

Electrobun supports registering custom URL schemes for your application, enabling deep linking. When users click a link like `myapp://some/path`, your app opens and receives the URL.

### Platform Support

- **macOS:** Fully supported. App must be in `/Applications` folder for reliable URL scheme registration.
- **Windows:** Not yet supported
- **Linux:** Not yet supported

### Configuration

```typescript
const config: ElectrobunConfig = {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
    urlSchemes: ["myapp", "myapp-dev"],
  },
  // ...
};
```

### Handling URL Opens

```typescript
import Electrobun from "electrobun";

Electrobun.events.on("open-url", (e) => {
  console.log("Opened with URL:", e.data.url);

  const url = new URL(e.data.url);
  console.log("Protocol:", url.protocol);
  console.log("Pathname:", url.pathname);

  if (url.pathname.startsWith("/login")) {
    // Handle login deep link
  }
});
```

### How It Works on macOS

When you build your app with URL schemes configured, Electrobun automatically adds the `CFBundleURLTypes` entry to your app's `Info.plist`. The operating system registers these URL schemes when your app is placed in the `/Applications` folder.

**Important notes:**
- The app must be in `/Applications` (or `~/Applications`) for macOS to register the URL schemes
- During development, URL schemes won't work unless you build and install to Applications
- If another app has already registered the same URL scheme, macOS will use whichever was installed first
- Notarization is recommended for production apps

## ASAR Packaging

Electrobun supports packaging your application resources into an ASAR archive for faster file access and improved security.

### Configuration Options

```typescript
const config: ElectrobunConfig = {
  build: {
    useAsar: true,
    asarUnpack: ["*.node", "*.dll", "*.dylib", "*.so"],
  },
};
```

### useAsar

**Type:** `boolean` | **Default:** `false`

Enables ASAR packaging. The entire `app/` directory is packed into a single `app.asar` file.

### asarUnpack

**Type:** `string[]` | **Default:** `["*.node", "*.dll", "*.dylib", "*.so"]`

Glob patterns for files that should remain unpacked.

**Benefits:**
- **Performance:** Faster file access and reduced I/O operations
- **Security:** App code is extracted to randomized temp files with automatic cleanup
- **Distribution:** Fewer files to manage and distribute
- **Integrity:** Single archive is easier to verify and protect

## Renderer Configuration

Electrobun supports multiple webview renderers. By default, it uses the system's native webview.

### Platform-specific Renderer Options

#### bundleCEF

**Type:** `boolean` | **Default:** `false`

When `true`, CEF is bundled with your application (+100MB to app bundle).

#### defaultRenderer

**Type:** `'native' | 'cef'` | **Default:** `'native'`

Sets the default renderer for all `BrowserWindow` and `BrowserView` instances.

### Example: CEF as Default Renderer

```typescript
const config: ElectrobunConfig = {
  build: {
    mac: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
  },
};
```

## Custom Bun Version

Override the default Bun version:

```typescript
export default {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  build: {
    bunVersion: "1.4.2",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
  },
} satisfies ElectrobunConfig;
```

The CLI automatically detects version mismatches and re-downloads. The cached binary is stored in `node_modules/.electrobun-cache/bun-override/`.

## Chromium Flags

Pass custom Chromium command-line flags to CEF:

```typescript
const config: ElectrobunConfig = {
  build: {
    mac: {
      bundleCEF: true,
      chromiumFlags: {
        "show-paint-rects": true,
        "user-agent": "MyApp/1.0 (custom)",
      },
    },
  },
};
```

### Common Flags

| Flag | Type | Description |
|------|------|-------------|
| `user-agent` | `string` | Override the default user agent string |
| `show-paint-rects` | `true` | Flash green rectangles over repainted areas |
| `show-composited-layer-borders` | `true` | Show colored borders around GPU-composited layers |

## Runtime Configuration

### exitOnLastWindowClosed

**Type:** `boolean` | **Default:** `true`

When `true`, the application automatically quits when the last `BrowserWindow` is closed.

### Custom Runtime Values

```typescript
// electrobun.config.ts
export default {
  runtime: {
    exitOnLastWindowClosed: true,
    myCustomSetting: "hello",
  },
} satisfies ElectrobunConfig;

// src/bun/index.ts
import { BuildConfig } from "electrobun/bun";
const config = await BuildConfig.get();
console.log(config.runtime?.myCustomSetting); // "hello"
```

## Build Lifecycle Hooks

### Available Hooks

| Hook | When it runs | Use case |
|------|--------------|----------|
| `preBuild` | Before the build starts | Validation, environment setup, cleanup |
| `postBuild` | After inner app bundle is complete | Modify app bundle, add resources |
| `postWrap` | After self-extracting bundle created | Add files to wrapper bundle |
| `postPackage` | After all artifacts are created | Custom distribution, upload, notifications |

### Configuration

```typescript
const config: ElectrobunConfig = {
  scripts: {
    preBuild: "./scripts/pre-build.ts",
    postBuild: "./scripts/post-build.ts",
    postWrap: "./scripts/post-wrap.ts",
    postPackage: "./scripts/post-package.ts",
  },
};
```

### Environment Variables

All hook scripts receive:

| Variable | Description |
|----------|-------------|
| `ELECTROBUN_BUILD_ENV` | `dev`, `canary`, or `stable` |
| `ELECTROBUN_OS` | `macos`, `linux`, or `win` |
| `ELECTROBUN_ARCH` | `x64` or `arm64` |
| `ELECTROBUN_BUILD_DIR` | Path to the build output directory |
| `ELECTROBUN_APP_NAME` | Application name with environment suffix |
| `ELECTROBUN_APP_VERSION` | Application version from config |
| `ELECTROBUN_APP_IDENTIFIER` | Bundle identifier from config |
| `ELECTROBUN_ARTIFACT_DIR` | Path to the artifacts output directory |

The `postWrap` hook receives an additional variable:
- `ELECTROBUN_WRAPPER_BUNDLE_PATH` - Path to the self-extracting wrapper bundle

### Example: Build Validation with preBuild

```typescript
// scripts/pre-build.ts
import { existsSync } from "fs";

const buildEnv = process.env.ELECTROBUN_BUILD_ENV;

if (buildEnv === "stable") {
  const requiredVars = [
    "ELECTROBUN_DEVELOPER_ID",
    "ELECTROBUN_APPLEID",
    "ELECTROBUN_APPLEIDPASS",
    "ELECTROBUN_TEAMID",
  ];

  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error("Missing required environment variables for stable build:");
    missing.forEach((v) => console.error(`  - ${v}`));
    process.exit(1);
  }
}

console.log("preBuild validation passed");
```

### Full Playground Example

```typescript
// electrobun.config.ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Electrobun (Playground)",
    identifier: "dev.electrobun.playground",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
      myextension: {
        entrypoint: "src/myextension/preload.ts",
      },
      webviewtag: {
        entrypoint: "src/webviewtag/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/webviewtag/index.html": "views/webviewtag/index.html",
      "src/webviewtag/electrobun.png": "views/webviewtag/electrobun.png",
      "assets/electrobun-logo-32-template.png": "views/assets/electrobun-logo-32-template.png",
    },
    mac: {
      codesign: true,
      notarize: true,
      bundleCEF: true,
      defaultRenderer: "cef",
      entitlements: {
        "com.apple.security.device.camera": "This app needs camera access",
        "com.apple.security.device.microphone": "This app needs microphone access",
      },
      icons: "icon.iconset",
    },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
    win: {
      bundleCEF: true,
      defaultRenderer: "cef",
    },
  },
  scripts: {
    postBuild: "./buildScript.ts",
  },
  release: {
    baseUrl: "https://static.electrobun.dev/playground/",
  },
} satisfies ElectrobunConfig;
```
