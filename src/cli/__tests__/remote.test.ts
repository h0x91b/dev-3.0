import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleRemote } from "../commands/remote";
import type { ParsedArgs } from "../args";

/**
 * `handleRemote` spawns a child process for the actual server. We can't let
 * that happen in unit tests, so we stub `node:child_process.spawn` into a
 * no-op: it returns an object with an `on` method that never fires. This is
 * enough to cover the flag-validation branches without touching the real
 * server. `process.exit` is spied on so exitUsage() raises synchronously
 * instead of tearing the test runner down.
 */
vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ on: vi.fn() })),
}));

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
		throw new Error("__exit__");
	}) as never);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	exitSpy.mockRestore();
	stderrSpy.mockRestore();
	stdoutSpy.mockRestore();
	vi.clearAllMocks();
});

describe("dev3 remote --port validation", () => {
	it("rejects --port without a value", async () => {
		await expect(handleRemote(undefined, args({ port: "true" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port requires a value");
	});

	it("rejects non-numeric port", async () => {
		await expect(handleRemote(undefined, args({ port: "abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("rejects port below range", async () => {
		await expect(handleRemote(undefined, args({ port: "0" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("rejects port above 65535", async () => {
		await expect(handleRemote(undefined, args({ port: "70000" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("rejects port with trailing garbage", async () => {
		// Number.parseInt("3000abc", 10) === 3000; the trim/equality check must
		// reject this so we don't silently accept "3000abc" as 3000.
		await expect(handleRemote(undefined, args({ port: "3000abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--port must be an integer");
	});

	it("accepts a valid port and passes it through DEV3_REMOTE_PORT", async () => {
		const { spawn } = await import("node:child_process");
		const spawnMock = vi.mocked(spawn);

		// `handleRemote` has two branches depending on process.execPath:
		//   - ends with "/bun"      → runViaBun (dev mode)
		//   - else                  → spawn sibling dev3-server, which here
		//                              fails with exitError("binary not found")
		//                              because we're clearly not running a
		//                              compiled dev3.
		// The env-forwarding behaviour is identical in both branches; we pick
		// whichever path we currently hit and assert against that.
		const execPath = process.execPath;
		const isViaBun = execPath.endsWith("/bun") || execPath.endsWith("\\bun.exe");

		// Track signal listeners to clean up if we go down the happy path —
		// runViaBun registers SIGINT/SIGTERM forwarders.
		const sigBefore = process.listeners("SIGINT").length;

		if (isViaBun) {
			await handleRemote(undefined, args({ port: "3000" }));
			expect(spawnMock).toHaveBeenCalledOnce();
			const passedEnv = spawnMock.mock.calls[0][2]?.env as NodeJS.ProcessEnv | undefined;
			expect(passedEnv?.DEV3_REMOTE_PORT).toBe("3000");
		} else {
			// Compiled-CLI branch: exits early because there's no sibling
			// dev3-server in the test environment. We still want to confirm
			// the flag *was* accepted (reached exitError, not exitUsage).
			await expect(handleRemote(undefined, args({ port: "3000" }))).rejects.toThrow("__exit__");
			const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
			expect(combined).toContain("dev3-server binary not found");
			expect(combined).not.toContain("--port must");
		}

		// Clean up any leaked signal listeners.
		const sigIntListeners = process.listeners("SIGINT");
		const added = sigIntListeners.length - sigBefore;
		for (let i = 0; i < added; i++) {
			const intList = process.listeners("SIGINT");
			const termList = process.listeners("SIGTERM");
			process.removeListener("SIGINT", intList[intList.length - 1]);
			process.removeListener("SIGTERM", termList[termList.length - 1]);
		}
	});

	it("rejects unknown flags", async () => {
		await expect(handleRemote(undefined, args({ bogus: "true" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("Unknown flag: --bogus");
	});
});

describe("dev3 remote --expose-ports validation", () => {
	it("rejects --expose-ports without a value", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "true" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("--expose-ports requires a value");
	});

	it("rejects non-numeric port in the list", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "3000,abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("invalid port");
	});

	it("rejects out-of-range port", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "70000" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("invalid port");
	});

	it("rejects port with trailing garbage", async () => {
		await expect(handleRemote(undefined, args({ "expose-ports": "3000abc" }))).rejects.toThrow("__exit__");
		const combined = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(combined).toContain("invalid port");
	});
});
