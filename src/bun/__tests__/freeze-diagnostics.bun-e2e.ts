import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

if (process.platform !== "darwin") {
	console.log("SKIP: macOS sampling proof");
} else {
	const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-e2e-"));
	process.env.DEV3_DEBUG = "1";
	process.env.DEV3_LOG_DIR = dir;
	const { startFreezeDiagnostics } = await import("../freeze-diagnostics");
	const packaged = join(dir, "packaged-worker");
	cpSync(new URL("../freeze-diagnostics", import.meta.url), packaged, { recursive: true });
	const stop = startFreezeDiagnostics({ workerPath: join(packaged, "worker.ts"), version: "fixture", build: "fixture" });
	try {
		await Bun.sleep(22_000);
		const started = Date.now();
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 9_000);
		const ended = Date.now();
		await Bun.sleep(10_000);
		const files = readdirSync(join(dir, "freeze"));
		const journal = readFileSync(join(dir, "freeze", files.find((name) => name.endsWith(".jsonl"))!), "utf8");
		const entries = journal.trim().split("\n").map((line) => JSON.parse(line));
		const detection = entries.find((entry) => entry.event === "suspected-stall");
		assert(detection?.reasons.includes("host-heartbeat-missing"));
		assert(detection.at >= started && detection.at < ended, "worker must detect the stall while the host is still blocked");
		const sample = readFileSync(join(dir, "freeze", files.find((name) => name.endsWith("-host.txt"))!), "utf8");
		assert(sample.includes(String(process.pid)) && sample.includes("Call graph"), "a real native sample must survive the stall");
		console.log(JSON.stringify({ result: "PASS", detectionDuringBlock: true, blockedMs: ended - started, sampleBytes: sample.length }));
	} finally {
		stop();
		await Bun.sleep(100);
		rmSync(dir, { recursive: true, force: true });
	}
}
