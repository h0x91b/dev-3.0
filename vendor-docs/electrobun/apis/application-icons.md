# Application Icons

## Introduction

Configure your application's icons for use in the app switcher and file system locations such as your Desktop or Applications folder.

## MacOS

The default icon folder location is `icon.iconset` in your repository root. Apple's documentation provides additional details on icon configuration.

Recommended icon sizes and naming:

```
icon_16x16.png
icon_16x16@2x.png
icon_32x32.png
icon_32x32@2x.png
icon_128x128.png
icon_128x128@2x.png
icon_256x256.png
icon_256x256@2x.png
icon_512x512.png
icon_512x512@2x.png
```

You can specify a custom path for the `icon.iconset` folder in your `electrobun.config` file.

## Windows

Set the `build.win.icon` option in your `electrobun.config` file to point to an `.ico` or `.png` file. PNG files are automatically converted to ICO format during the build process.

The icon is embedded in the launcher executable, Bun runtime executable, and installer, appearing in the taskbar, desktop shortcuts, and File Explorer.

For optimal results with `.ico` files, include sizes: 16x16, 32x32, 48x48, and 256x256 pixels. PNG files should be at least 256x256 pixels.

```typescript
// electrobun.config.ts
const config: ElectrobunConfig = {
  build: {
    win: {
      icon: "assets/icon.ico",
      // or use a PNG from your macOS iconset:
      // icon: "icon.iconset/icon_256x256.png",
    },
  },
};
```

## Linux

Set the `build.linux.icon` option in your `electrobun.config` file to a `.png` file path. The icon should be at least 256x256 pixels.

The icon is used for the window icon, taskbar, and generated `.desktop` entry.

```typescript
// electrobun.config.ts
const config: ElectrobunConfig = {
  build: {
    linux: {
      icon: "assets/icon.png",
      // or use a PNG from your macOS iconset:
      // icon: "icon.iconset/icon_256x256.png",
    },
  },
};
```

> **Tip:** Reuse PNGs from your macOS `icon.iconset` folder for Windows and Linux builds to avoid maintaining separate platform-specific icon files.
