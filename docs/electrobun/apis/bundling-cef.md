# Bundling CEF (Chromium Embedded Framework)

## Overview

Electrobun supports bundling CEF with applications to ensure consistent rendering across platforms. While system webviews create smaller bundles, CEF provides uniform behavior on all operating systems.

## Configuration

To enable CEF bundling, modify your `electrobun.config.ts`:

```typescript
import { type ElectrobunConfig } from "electrobun";

export const config: ElectrobunConfig = {
  build: {
    macos: {
      bundleCEF: true,
    },
    win: {
      bundleCEF: true,
    },
    linux: {
      bundleCEF: true,
    },
  },
};
```

## Platform-Specific Considerations

### Windows

Windows uses Webview2 (Edge's renderer, Chromium-based) as the system renderer. Bundling CEF helps pin a specific Chromium version, avoiding compatibility issues between the user's system version and your application's requirements.

### Linux

Bundling CEF is strongly recommended on Linux as GTKWebKit doesn't support Electrobun's advanced compositing features. The `<electrobun-webview>` tag and complex window layering require CEF.

### Bundle Size Impact

- **With CEF**: ~100MB initial self-extracting bundle
- **System webviews**: ~14MB
- Incremental updates remain minimal (14KB) thanks to differential updates

## Using CEF Renderer

### BrowserWindow API

```typescript
import { BrowserWindow } from "electrobun/bun";

// CEF renderer window
const cefWindow = new BrowserWindow({
  width: 1200,
  height: 800,
  renderer: "cef",
  url: "views://main/index.html",
});

// System renderer window
const systemWindow = new BrowserWindow({
  width: 800,
  height: 600,
  renderer: "system",
  url: "views://secondary/index.html",
});
```

### Electrobun Webview Tag

```html
<!-- CEF renderer -->
<electrobun-webview
  src="https://example.com"
  renderer="cef"
  style="width: 100%; height: 500px;">
</electrobun-webview>

<!-- System renderer -->
<electrobun-webview
  src="https://example.org"
  renderer="system"
  style="width: 100%; height: 300px;">
</electrobun-webview>
```

## Mixed Renderer Support

### macOS and Windows

You can mix renderers within the same application — some windows use system webviews for lower memory footprint, others use CEF for consistency.

### Linux Limitation

Linux does not support mixing renderers. The build creates two separate binaries: one for GTKWebKit, one for CEF. All webviews must use the same renderer.

## When to Bundle CEF

**Bundle CEF for:**
- Consistent cross-platform rendering
- Advanced compositing features (especially Linux)
- Latest Chromium capabilities
- Predictable behavior with complex web applications

**Use system webviews for:**
- Smallest bundle size (~14MB)
- Native platform integration
- Lower memory usage
- Faster initial downloads

## Custom CEF Versions

Override the default CEF version in your build configuration:

```typescript
export default {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "1.0.0",
  },
  build: {
    cefVersion: "144.0.11+ge135be2+chromium-144.0.7559.97",
    mac: {
      bundleCEF: true,
    },
    linux: {
      bundleCEF: true,
    },
    win: {
      bundleCEF: true,
    },
  },
} satisfies ElectrobunConfig;
```

### Use Cases for Custom Versions

- Pin older versions to avoid deprecated Chrome API breaking changes
- Use newer versions for security fixes or required Chromium features

### Compatibility Guidelines

- **Same major version**: Safe
- **Adjacent major versions**: Usually compatible but test thoroughly
- **Distant major versions**: Higher incompatibility risk

The CLI automatically detects version mismatches and re-downloads as needed. Find your Electrobun release's tested CEF version in the `CEF_VERSION` constant within `package/build.ts`.
