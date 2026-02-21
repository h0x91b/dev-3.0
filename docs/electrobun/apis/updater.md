# Updater

## Overview

Electrobun's built-in update mechanism for your app enables developers to distribute updates efficiently. The system generates small patch files, with updates potentially as compact as 14KB.

## Configuration

Updates require configuration in `electrobun.config`:

```typescript
export default {
  // ...
  release: {
    baseUrl: "https://your-release-url",
  },
};
```

## Setup

Import the Updater from the Bun module:

```typescript
import { Updater } from "electrobun/bun";
```

## Hosting Requirements

The update system works with static file hosting services including:

- AWS S3 + Cloudfront
- Cloudflare R2
- GitHub Releases

Most applications will remain within free tier limits.

## Available Methods

### getLocalInfo

Retrieves bundled version information for display or logic:

```typescript
const localInfo = await Electrobun.Updater.getLocalInfo();
```

Returns: version, hash, baseUrl, channel, name, identifier

### checkForUpdate

Queries the remote `update.json` file from the configured channel and platform:

```typescript
const updateInfo = await Electrobun.Updater.checkForUpdate();
```

Returns: version, hash, updateAvailable, updateReady, error status

### downloadUpdate

Initiates patch file downloading and application. Falls back to full version download if patch chain is unavailable.

```typescript
await Electrobun.Updater.downloadUpdate();
```

### applyUpdate

Applies ready updates by terminating the current instance, installing the new version, and relaunching:

```typescript
if (Electrobun.Updater.updateInfo()?.updateReady) {
  await Electrobun.Updater.applyUpdate();
}
```

## Implementation Strategy

Trigger update checks during app launch, on intervals, or via system tray menu interactions.
