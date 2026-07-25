#!/usr/bin/env bun
/**
 * Entry shim for the artifact-manifest generator. The logic and its exit-code
 * contract live in
 * src/bun/native-terminal-registry/host-images/artifact-manifest-cli.ts so the
 * normal vitest suite covers them.
 *
 *   bun scripts/native-terminal-host-manifest/generate.ts \
 *     --root dist/native \
 *     --entrypoint dev3-terminal-host.js \
 *     --host-version 1.2.3 --protocol-version 2 --bun-version 1.3.14 \
 *     --os win32 --arch x64 \
 *     [--file dev3-terminal-host.js --file conpty/conpty.dll ...] \
 *     [--out dist/native/manifest.json]
 */

import { runArtifactManifestCli } from "../../src/bun/native-terminal-registry/host-images/artifact-manifest-cli";

const result = runArtifactManifestCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
