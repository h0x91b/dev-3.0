import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPackagedConptyRuntime } from "../src/shared/native-terminal-runtime";

if (process.platform !== "win32") {
	console.log("[native-terminal-host] Windows host build skipped outside Windows");
	process.exit(0);
}

const compilerVersion = assertPackagedConptyRuntime(Bun.version);
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
	throw new Error(`Failed to bundle the Windows terminal host with Bun ${compilerVersion}.\n${build.stdout}\n${build.stderr}`);
}

const version = spawnSync(process.execPath, [output, "version"], { encoding: "utf8", env: process.env });
if (version.status !== 0) throw new Error(`Bundled terminal host version probe failed: ${version.stderr}`);
const reported = JSON.parse(version.stdout.trim());
if (assertPackagedConptyRuntime(reported.bunVersion) !== compilerVersion) {
	throw new Error(`Bundled terminal host reports Bun ${reported.bunVersion}; expected build Bun ${compilerVersion}.`);
}
console.log(
	`[native-terminal-host] bundled ${output} with build Bun ${reported.bunVersion}; ` +
		"the Electrobun postBuild proof will execute it with the copied package runtime",
);
