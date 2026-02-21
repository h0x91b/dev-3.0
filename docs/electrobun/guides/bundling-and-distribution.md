# Bundling & Distribution

## Overview

This guide builds on the [Creating UI](./creating-ui.md) documentation and covers preparing applications for distribution through package scripts and release configuration.

## Build Scripts Setup

Add two distribution scripts to `package.json`:

```json
{
  "name": "my-app",
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "electrobun": "^0.0.1"
  },
  "scripts": {
    "start": "bun run build:dev && electrobun dev",
    "build:dev": "bun install && electrobun build",
    "build:canary": "electrobun build --env=canary",
    "build:stable": "electrobun build --env=stable"
  }
}
```

Execute via:

```bash
bun run build:canary
# or
bun run build:stable
```

## Build Output

Non-development builds automatically perform:

- Optimized bundle creation
- ZSTD compression
- Self-extracting bundle generation
- Artifacts folder creation for hosting

## Release Configuration

Configure release hosting in `electrobun.config.ts`:

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
  release: {
    baseUrl: "https://storage.googleapis.com/mybucketname/myapp/",
  },
};
```

Upload the `artifacts` folder contents to any static host (S3, R2, GitHub Releases, etc.).

## Artifact Structure

The flat artifacts folder uses consistent naming: `{channel}-{os}-{arch}-{filename}`. This structure works universally, including with GitHub Releases.

### macOS

```
canary-macos-arm64-update.json
canary-macos-arm64-MyCoolApp-canary.dmg
canary-macos-arm64-MyCoolApp-canary.app.tar.zst
canary-macos-arm64-a1b2c3d4.patch
```

### Windows

```
canary-win-x64-update.json
canary-win-x64-MyCoolApp-Setup-canary.zip
canary-win-x64-MyCoolApp-canary.tar.zst
canary-win-x64-a1b2c3d4.patch
```

### Linux

```
canary-linux-x64-update.json
canary-linux-x64-MyCoolAppSetup-canary.tar.gz
canary-linux-x64-MyCoolApp-canary.tar.zst
canary-linux-x64-a1b2c3d4.patch
```

## Naming Conventions

- App names are sanitized by removing spaces ("My Cool App" -> "MyCoolApp")
- Stable builds omit channel suffixes
- Other channels append the channel name to filenames
- Windows and Linux use archive formats; macOS uses DMG
- Installer files inside archives preserve spaces for user friendliness

## Incremental Updates

Subsequent non-development builds download the current version via `release.baseUrl` and generate patch files using BSDIFF optimization. Keep older patches so users can step through incremental updates (as small as 14KB). If patching fails, the Updater falls back to full downloads.

Consult the [Updater API documentation](../apis/updater.md) for implementation details.

## Build Lifecycle Hooks

Available hooks (execution order): `preBuild`, `postBuild`, `postWrap`, `postPackage`

These enable:

- Environment validation before builds
- Code transformation post-compilation
- Custom files added to bundles
- Build completion notifications

Reference [Build Configuration docs](../apis/cli/build-configuration.md#build-lifecycle-hooks) for detailed specifications and examples.
