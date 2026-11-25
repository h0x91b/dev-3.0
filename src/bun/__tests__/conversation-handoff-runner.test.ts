import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureHandoffWorker, runHandoffJob } from "../conversation-handoff-runner";

// Plain-JS workers written per test: the real one is a bundle, and the runner's
// contract (one message, a timeout, a crash) does not depend on what it parses.
let dir: string;
const job = { kind: "preview" as const, worktreePath: "/nowhere/worktree", home: "/nowhere" };

function worker(name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, `import { parentPort, workerData } from "node:worker_threads";\n${body}\n`);
	return path;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-handoff-runner-"));
});

afterEach(() => {
	configureHandoffWorker(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("runHandoffJob", () => {
	it("hands the job to the worker and returns its answer", async () => {
		configureHandoffWorker(worker("echo.mjs", `parentPort.postMessage({ ok: true, result: { kind: "none", echoed: workerData.worktreePath } });`));
		expect(await runHandoffJob(job, { timeoutMs: 10_000 })).toEqual({ kind: "none", echoed: "/nowhere/worktree" });
	});

	it("rejects instead of hanging on a worker error, a worker that never answers, or one that dies", async () => {
		configureHandoffWorker(worker("fail.mjs", `parentPort.postMessage({ ok: false, error: "boom" });`));
		await expect(runHandoffJob(job, { timeoutMs: 10_000 })).rejects.toThrow("boom");
		configureHandoffWorker(worker("stuck.mjs", `setInterval(() => {}, 1_000);`));
		await expect(runHandoffJob(job, { timeoutMs: 200 })).rejects.toThrow("timed out");
		configureHandoffWorker(worker("exit.mjs", `process.exit(3);`));
		await expect(runHandoffJob(job, { timeoutMs: 10_000 })).rejects.toThrow(/exited|code/);
	});

	it("runs inline when the worker bundle is missing, so a build without it still works", async () => {
		configureHandoffWorker(join(dir, "missing.js"));
		expect(await runHandoffJob(job, { timeoutMs: 10_000 })).toEqual({ kind: "none" });
	});
});
