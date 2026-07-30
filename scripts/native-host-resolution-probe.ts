/**
 * Prints how `resolveNativeHostRuntime()` resolves in the process that runs it.
 *
 * Only ever executed as a `bun build --target=bun` BUNDLE, by
 * `scripts/verify-packaged-host-resolution.ts`. Bundling is the point: it puts
 * the resolver's `import.meta.url` inside `$bunfs`, so the source-checkout
 * branch cannot fire and a `packaged-image` verdict can only have come from an
 * image that really ships inside the package.
 */

import { resolveNativeHostRuntime } from "../src/bun/native-host-runtime";

const runtime = resolveNativeHostRuntime();
process.stdout.write(`DEV3_RESOLUTION_PROBE ${JSON.stringify({ execPath: process.execPath, ...runtime })}\n`);
