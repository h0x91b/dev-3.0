# Updates

## Introduction

Electrobun provides a built-in update system that requires only a static file host. Key features include:

- Update API for checking, downloading, and installing app updates
- CLI tools for building bundles, code signing, and generating artifacts
- Custom BSDIFF implementation in Zig with SIMD optimization for minimal delta patches (as small as 14KB)

## Hosting on GitHub Releases

GitHub Releases offers a convenient hosting option for update artifacts, particularly for open source projects. The system uses a flat, prefix-based naming scheme (e.g., `stable-macos-arm64-update.json`).

### Configuration

Set the `baseUrl` in your configuration file:

```typescript
// electrobun.config.ts
export default {
  // ...
  release: {
    baseUrl: "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download",
  },
};
```

### Example GitHub Action

Automated workflow for building and publishing releases on tag push:

```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-macos-arm64:
    runs-on: macos-14

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Determine build environment
        id: build-env
        run: |
          if [[ "${{ github.ref_name }}" == *"-canary"* ]]; then
            echo "env=canary" >> $GITHUB_OUTPUT
          else
            echo "env=stable" >> $GITHUB_OUTPUT
          fi

      - name: Build app
        env:
          ELECTROBUN_DEVELOPER_ID: ${{ secrets.ELECTROBUN_DEVELOPER_ID }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          if [ "${{ steps.build-env.outputs.env }}" = "canary" ]; then
            bun run build:canary
          else
            bun run build:stable
          fi

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: artifacts/*
          draft: false
          prerelease: ${{ steps.build-env.outputs.env == 'canary' }}
          generate_release_notes: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The `generate_release_notes: true` option leverages GitHub's automatic release notes feature to list merged pull requests and contributors.

## Limitations

### Single Patch File

The system generates one patch file per build — from the immediately preceding version to the current version:

- Users on the previous version receive small delta patches (often just a few KB)
- Users more than one version behind automatically fall back to full `.tar.zst` bundle downloads

### Canary Builds on GitHub Releases

GitHub's `/releases/latest/download` URL only resolves to non-prerelease builds:

- **Stable builds**: Auto-updates function correctly
- **Canary builds**: Auto-updates fail because the latest URL excludes prerelease versions

For auto-updating canary builds, use alternative hosts like Cloudflare R2 or AWS S3 where URL structure is directly controllable.
