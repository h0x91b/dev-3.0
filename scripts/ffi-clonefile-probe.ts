/**
 * Release gate probe: compiled and signed with the CLI recipe by
 * release-build-macos.yml, it runs the real cow-clone path through the shipped
 * clonefile worker. A `cp -cR` result means bun:ffi never ran, so it fails.
 */
import { clonePaths, configureClonefileWorker } from "../src/bun/cow-clone";

export async function probeClonefile(src: string, dst: string, workerPath: string): Promise<void> {
	configureClonefileWorker(workerPath);
	const [result] = await clonePaths(src, dst, ["node_modules"]);
	if (result?.method !== "clonefile") {
		throw new Error(`expected clonefile, got ${result?.method ?? "no result"}${result?.error ? `: ${result.error}` : ""}`);
	}
}

if (import.meta.main) {
	const [src, dst, workerPath] = process.argv.slice(2);
	if (!src || !dst || !workerPath) {
		console.error("usage: ffi-clonefile-probe <src-root> <dest-root> <clonefile-worker.js>");
		process.exit(2);
	}
	await probeClonefile(src, dst, workerPath);
	console.log("ffi clonefile OK");
}
