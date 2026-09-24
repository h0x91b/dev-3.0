import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditHarnessManifest } from "../src/bun/harness-audit";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === "--help") {
	console.log("Usage: bun scripts/audit-harness-cost.ts <manifest.json>\nReads explicit local transcript paths (relative to the manifest), writes aggregate JSON to stdout. No files or app state are changed.");
	process.exitCode = args[0] === "--help" ? 0 : 1;
} else {
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(resolve(args[0]), "utf8"));
	} catch {
		console.error("Cannot read a valid JSON manifest; check its path, permissions, and JSON syntax.");
		process.exitCode = 1;
	}
	if (process.exitCode !== 1) {
		try {
			console.log(JSON.stringify(auditHarnessManifest(manifest, dirname(resolve(args[0]))), null, 2));
		} catch (cause) {
			console.error(cause instanceof Error ? cause.message : "The local audit could not be completed.");
			process.exitCode = 1;
		}
	}
}
