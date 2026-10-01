Short: Restore macOS canary and release builds

The macOS release gate that checks bun:ffi under the CLI signing recipe now runs clonefile through the shipped clonefile worker, so canary and stable macOS builds no longer fail on a `cp -cR` fallback after clonefile moved off the host thread.
