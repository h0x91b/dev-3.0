/**
 * Bundle the native terminal host into `dist/native/dev3-terminal-host.js` on
 * every platform.
 *
 * Electrobun copies `dist/native` into the package, and the packaging hook then
 * assembles that bundle plus the packaged Bun runtime into an immutable
 * `native-host-image/<tag>/`. This step used to no-op outside Windows, which is
 * exactly why a packaged macOS build had no host to launch (seq 1311).
 *
 * The ConPTY runtime floor belongs to the Bun that EXECUTES the host — the one
 * Electrobun copies into the package — and the packaging hook asserts it there.
 * Whatever Bun bundles this script is not bound by it, so CI jobs that only
 * type-check a build are free to run an older toolchain.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const compilerVersion = Bun.version;
const entrypoint = resolve(import.meta.dir, "../src/bun/native-terminal-host/main.ts");
const outputDir = resolve(import.meta.dir, "../dist/native");
const output = resolve(outputDir, "dev3-terminal-host.js");
mkdirSync(outputDir, { recursive: true });

const build = spawnSync(
	process.execPath,
	["build", entrypoint, "--target=bun", "--outfile", output],
	{ cwd: resolve(import.meta.dir, ".."), env: process.env, encoding: "utf8" },
);
if (build.status !== 0) {
	throw new Error(`Failed to bundle the terminal host with Bun ${compilerVersion}.\n${build.stdout}\n${build.stderr}`);
}

const version = spawnSync(process.execPath, [output, "version"], { encoding: "utf8", env: process.env });
if (version.status !== 0) throw new Error(`Bundled terminal host version probe failed: ${version.stderr}`);
const reported = JSON.parse(version.stdout.trim());
if (reported.bunVersion !== compilerVersion) {
	throw new Error(`Bundled terminal host reports Bun ${reported.bunVersion}; expected build Bun ${compilerVersion}.`);
}
console.log(
	`[native-terminal-host] bundled ${output} with build Bun ${reported.bunVersion}; ` +
		"the Electrobun postBuild hook will execute it with the copied package runtime",
);
