import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleRemote } from "../commands/remote";
import type { ParsedArgs } from "../args";

/**
 * On the happy path `handleRemote` boots the headless server in-process via
 * `await import("../../bun/headless-entry")`. We can't let the real server boot
 * in a unit test, so we mock that module to an empty no-op — the dynamic import
 * then resolves instantly and `handleRemote` returns after applying its env
 * vars. `process.exit` is spied on so exitUsage() raises synchronously instead
 * of tearing the test runner down.
 */
vi.mock("../../bun/headless-entry", () => ({}));

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

	it("accepts a valid port and applies it to process.env (DEV3_REMOTE_PORT + DEV3_HEADLESS)", async () => {
		// Single in-process path now: a valid port is applied to process.env, then
		// the (mocked) headless-entry import resolves and handleRemote returns.
		const ENV_KEYS = [
			"DEV3_REMOTE_PORT",
			"DEV3_HEADLESS",
			"DEV3_REMOTE_NO_TUNNEL",
			"DEV3_VIEWS_DIR",
			"DEV3_REMOTE_STATIC_CODE",
			"DEV3_REMOTE_EXPOSE_PORTS",
		] as const;
		const saved: Record<string, string | undefined> = {};
		for (const k of ENV_KEYS) saved[k] = process.env[k];

		try {
			await handleRemote(undefined, args({ port: "3000" }));
			expect(process.env.DEV3_REMOTE_PORT).toBe("3000");
			expect(process.env.DEV3_HEADLESS).toBe("1");
		} finally {
			for (const k of ENV_KEYS) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
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
