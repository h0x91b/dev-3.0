# Architecture Overview

## High Level App Architecture

An Electrobun application is fundamentally a Bun app. A compact launcher (typically a Zig binary) executes the Bun application. Since native GUIs require a blocking event loop on the main thread, the main Bun thread creates a webworker running your code and uses Bun's FFI to initialize the native GUI event loop. Your Bun code running in the worker can then leverage Electrobun's APIs, which call native wrapper code via FFI to open windows, create system trays, relay events, and handle RPC.

## Application Bundles

### MacOS

#### Your Installed App

On macOS, an application bundle is a folder with a `.app` extension containing key subfolders:

```
/Contents/MacOS
    - bspatch (optimized Zig implementation for diffs during updates)
    - bun (the Bun runtime)
    - launcher (Zig binary that calls `bun index.js`)
    - libNativeWrapper.dylib (Electrobun's native code layer)

/Contents/MacOS/Resources
    - AppIcon.icns (application icons)
    - version.json (local version info for Updater)
    - app/bun/ (bundled JavaScript code)
    - app/views (transpiled view definitions)
```

#### IPC

Electrobun establishes inter-process communication between Bun and browser contexts using postMessage, FFI, and encrypted web sockets.

#### Self-Extracting Bundle

Electrobun automatically bundles applications into self-extracting ZSTD bundles for minimal size. The current Playground app is 50.4MB when uncompressed but only 13.1MB as a self-extracting bundle — almost 5 times smaller.

The self-extracting bundle structure:

```
/Contents/MacOS/launcher (Zig decompression binary)
/Contents/Resources/AppIcons.icns
/Contents/Resources/[hash].tar.zst (compressed app bundle)
```

Self-extraction occurs only on first install, requiring no additional server infrastructure.

#### DMG

Electrobun automatically generates a DMG containing the self-extracting bundle.

## Code Signing and Notarization

Electrobun handles automatic code signing and notarization on macOS.

### Prerequisites and Process

Developers must register for an Apple Developer account and create an app ID. No private keys are required in the code repository; instead, set `codesigning` and `notarization` flags to `true` in your configuration and provide credentials via environment variables.

Electrobun code signs and notarizes both the app bundle and self-extracting bundle. While code signing is typically fast, notarization requires uploading to Apple's servers for scanning, typically taking 1-2 minutes. The notarization is then stapled to the app bundle.

Disable code signing and notarization during debugging of non-dev builds to accelerate the build process. Notarization issues are displayed in the terminal, usually requiring entitlement declarations.

## Updating

Electrobun includes a built-in update mechanism optimizing for file size and efficiency. Ship updates to users as small as 14KB, enabling frequent updates without substantial storage and network costs. Only a static file host like S3 (optionally behind a CDN) is required.

### How It Works

Using the Electrobun Updater API:

1. Compare local version.json hash against hosted update.json hash
2. Download tiny BSDIFF patch file matching your current hash
3. Apply patch and generate hash of patched bundle
4. If hash matches latest, replace running application and relaunch
5. If hash doesn't match, locate another patch and repeat
6. If patching fails, download zlib-compressed bundle as fallback

The CLI automatically generates patches from current hosted versions to newly built versions for non-dev builds.

## CLI and Development Builds

Electrobun CLI installs locally via `bun install electrobun`. Configure via npm scripts and an `electrobun.config` file.

### Development Builds

Dev builds use a special launcher routing Bun, Zig, and native output to the terminal. Dev builds are not distributed and don't generate artifacts.

### Distribution

Canary and stable builds generate an `artifacts` folder containing everything needed for static host upload and updates.
