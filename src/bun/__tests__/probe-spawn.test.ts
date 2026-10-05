import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../logger", () => ({ createLogger: () => mockLog }));

import { runProbeText } from "../probe-spawn";
import { spawn } from "../spawn";

const mockSpawn = vi.mocked(spawn);

/** A child that never exits and whose stdout never closes; dies only when killed with `diesOn`. */
function hungProc(diesOn: "SIGTERM" | "SIGKILL" | "never") {
	let exit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		exit = resolve;
	});
	const kill = vi.fn((signal: string) => {
		if (diesOn !== "never" && signal === diesOn) exit(143);
	});
	const stdout = new ReadableStream<Uint8Array>({ start() {} });
	const stderr = new ReadableStream<Uint8Array>({ start() {} });
	return { pid: 4242, kill, exited, stdout, stderr };
}

describe("runProbeText", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSpawn.mockReset();
		mockLog.warn.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns stdout of a probe that answers", async () => {
		mockSpawn.mockReturnValue({ stdout: "pid rows\n", stderr: "", exited: Promise.resolve(0), kill: vi.fn() } as never);
		await expect(runProbeText(["ps"], 1_000)).resolves.toBe("pid rows\n");
	});

	it("returns empty on a non-zero exit", async () => {
		mockSpawn.mockReturnValue({ stdout: "partial", stderr: "", exited: Promise.resolve(1), kill: vi.fn() } as never);
		await expect(runProbeText(["ps"], 1_000)).resolves.toBe("");
	});

	it("returns empty when the spawn itself throws", async () => {
		mockSpawn.mockImplementation(() => {
			throw new Error("posix_spawn ENOENT");
		});
		await expect(runProbeText(["ps"], 1_000)).resolves.toBe("");
	});

	it("stops a child that never exits, and settles anyway", async () => {
		const proc = hungProc("SIGTERM");
		mockSpawn.mockReturnValue(proc as never);

		let result: string | undefined;
		void runProbeText(["ps", "-eo"], 15_000).then((text) => (result = text));

		await vi.advanceTimersByTimeAsync(14_999);
		expect(result).toBeUndefined();
		expect(proc.kill).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(result).toBe("");
		expect(mockLog.warn).toHaveBeenCalledWith(
			"System probe timed out and was stopped",
			expect.objectContaining({ command: "ps", timeoutMs: 15_000, confirmed: true }),
		);
	});

	it("escalates to SIGKILL and still settles when the child ignores everything", async () => {
		const proc = hungProc("never");
		mockSpawn.mockReturnValue(proc as never);

		let result: string | undefined;
		void runProbeText(["vm_stat"], 10_000).then((text) => (result = text));
		await vi.advanceTimersByTimeAsync(10_000 + 1_000);

		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
		expect(result).toBe("");
		expect(mockLog.warn).toHaveBeenCalledWith(
			"System probe timed out and was stopped",
			expect.objectContaining({ command: "vm_stat", confirmed: false }),
		);
	});
});
