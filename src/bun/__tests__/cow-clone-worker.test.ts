import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockSpawn = vi.fn();
vi.mock("../spawn", () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
vi.mock("../logger", () => ({
	createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

/** clonefile(2) as the host would feel it: a synchronous call that holds the thread. */
const BLOCK_MS = 300;
const hostClonefile = vi.fn(() => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BLOCK_MS);
	return 0;
});
vi.mock("bun:ffi", () => ({
	dlopen: () => ({ symbols: { clonefile: hostClonefile }, close: () => {} }),
	FFIType: { cstring: 0, u32: 0, i32: 0 },
}));

import * as cow from "../cow-clone";

function makeProc(exitCode: number, delayMs = 0) {
	return {
		exited: delayMs ? new Promise((r) => setTimeout(() => r(exitCode), delayMs)) : Promise.resolve(exitCode),
		stderr: undefined,
	};
}

/** Sample the host event loop; the largest gap is how long nothing else could run. */
function watchEventLoop() {
	let last = performance.now();
	let maxGap = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxGap = Math.max(maxGap, now - last);
		last = now;
	}, 5);
	return async () => {
		await new Promise((r) => setTimeout(r, 40));
		clearInterval(timer);
		return maxGap;
	};
}

describe("cow-clone clonefile worker", () => {
	const origPlatform = process.platform;
	let dir: string;

	function worker(name: string, body: string): string {
		const path = join(dir, name);
		writeFileSync(path, `const { parentPort, workerData } = require("node:worker_threads");\n${body}\n`);
		return path;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		dir = mkdtempSync(join(tmpdir(), "cow-clone-worker-"));
		Object.defineProperty(process, "platform", { value: "darwin", writable: true });
		mockSpawn.mockImplementation(() => makeProc(0));
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
		(cow as { configureClonefileWorker?: (p: string | null) => void }).configureClonefileWorker?.(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the host event loop running while a slow clonefile is in progress", async () => {
		const path = worker("slow.cjs", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${BLOCK_MS});\nparentPort.postMessage({ ok: true });`);
		(cow as { configureClonefileWorker?: (p: string | null) => void }).configureClonefileWorker?.(path);

		const stop = watchEventLoop();
		const results = await cow.clonePaths("/src", "/dst", ["node_modules"]);
		const maxGap = await stop();

		expect(results[0]).toMatchObject({ path: "node_modules", method: "clonefile" });
		expect(hostClonefile).not.toHaveBeenCalled();
		expect(maxGap).toBeLessThan(BLOCK_MS / 2);
	});

	it("never starts the cp fallback before the failed worker thread has exited", async () => {
		const exited = join(dir, "exited");
		const path = worker("late-exit.cjs", [
			`parentPort.postMessage({ ok: false, error: "ENOTSUP" });`,
			`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);`,
			`require("node:fs").writeFileSync(${JSON.stringify(exited)}, "1");`,
		].join("\n"));
		cow.configureClonefileWorker(path);
		const fallbackSawExit: boolean[] = [];
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "cp") fallbackSawExit.push(existsSync(exited));
			return makeProc(0);
		});

		const results = await cow.clonePaths("/src", "/dst", ["node_modules"]);

		expect(results[0].method).toBe("apfs-clone");
		expect(fallbackSawExit).toEqual([true]);
	});

	it("falls back to cp -cR and clears the destination when the worker throws", async () => {
		const path = worker("throws.cjs", `throw new Error("boom");`);
		cow.configureClonefileWorker(path);
		const order: string[] = [];
		mockSpawn.mockImplementation((cmd: string[]) => {
			order.push(cmd.slice(0, 2).join(" "));
			return makeProc(0);
		});

		const results = await cow.clonePaths("/src", "/dst", ["node_modules"]);

		expect(results[0].method).toBe("apfs-clone");
		expect(results[0].error).toBeUndefined();
		expect(order.slice(-2)).toEqual(["rm -rf", "cp -cR"]);
	});

	it("falls back to cp -cR without touching FFI when the worker bundle is missing", async () => {
		cow.configureClonefileWorker(join(dir, "missing.js"));

		const results = await cow.clonePaths("/src", "/dst", ["node_modules"]);

		expect(results[0].method).toBe("apfs-clone");
		expect(hostClonefile).not.toHaveBeenCalled();
	});

	it("bounds clone work across tasks preparing at the same time", async () => {
		cow.configureClonefileWorker(null);
		let inFlight = 0;
		let peak = 0;
		mockSpawn.mockImplementation((cmd: string[]) => {
			if (cmd[0] !== "cp") return makeProc(0);
			inFlight++;
			peak = Math.max(peak, inFlight);
			return { exited: new Promise((r) => setTimeout(() => { inFlight--; r(0); }, 20)), stderr: undefined };
		});

		const [a, b] = await Promise.all([
			cow.clonePaths("/task-a", "/wt-a", ["node_modules", "build", "dist"]),
			cow.clonePaths("/task-b", "/wt-b", ["node_modules", "build", "dist"]),
		]);

		expect([...a, ...b].every((r) => r.method === "apfs-clone" && !r.error)).toBe(true);
		expect(peak).toBe(cow.MAX_CONCURRENT_CLONES);
	});
});
