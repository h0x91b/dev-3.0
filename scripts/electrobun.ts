/**
 * The one way to run the electrobun CLI: `bun scripts/electrobun.ts <args>`.
 *
 * Identical to `electrobun <args>` except that on Windows the CLI never sees PowerShell 7's
 * module directories, which break its `Expand-Archive` (see windows-powershell-env.ts).
 * Every package script and workflow goes through here; a guard test refuses a bare call.
 */

import { resolve } from "node:path";
import { stripPowerShell7ModulePathsInPlace } from "./windows-powershell-env";

const ELECTROBUN_CLI = resolve(import.meta.dir, "..", "node_modules", "electrobun", "bin", "electrobun.cjs");

stripPowerShell7ModulePathsInPlace("electrobun");
const result = Bun.spawnSync([process.execPath, ELECTROBUN_CLI, ...process.argv.slice(2)], {
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
	env: process.env,
});
process.exit(result.exitCode ?? 1);
