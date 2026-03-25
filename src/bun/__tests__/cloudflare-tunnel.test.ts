import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { spawn as mockSpawn, spawnSync as mockSpawnSync } from "../spawn";
import {
	isCloudflaredAvailable,
	startTunnel,
	stopTunnel,
	getTunnelUrl,
	getTunnelState,
	_resetState,
} from "../cloudflare-tunnel";

const originalFetch = globalThis.fetch;

describe("cloudflare-tunnel", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		globalThis.fetch = originalFetch;
	});

	describe("isCloudflaredAvailable", () => {
		it("returns true when which cloudflared exits 0", () => {
			(mockSpawnSync as Mock).mockReturnValue({ exitCode: 0 });
			expect(isCloudflaredAvailable()).toBe(true);
			expect(mockSpawnSync).toHaveBeenCalledWith(["which", "cloudflared"]);
		});

		it("returns false when exit code is non-zero", () => {
			(mockSpawnSync as Mock).mockReturnValue({ exitCode: 1 });
			expect(isCloudflaredAvailable()).toBe(false);
		});
	});

	describe("startTunnel", () => {
		function setupSpawnMock() {
			const killFn = vi.fn();
			let exitResolve: () => void;
			const exitedPromise = new Promise<void>((r) => {
				exitResolve = r;
			});

			(mockSpawn as Mock).mockReturnValue({
				kill: killFn,
				exited: exitedPromise,
			});

			return { killFn, triggerExit: () => exitResolve() };
		}

		it("returns public URL on successful poll", async () => {
			setupSpawnMock();

			let callCount = 0;
			(globalThis as any).fetch = vi.fn(async () => {
				callCount++;
				if (callCount < 3) {
					throw new Error("not ready");
				}
				return {
					ok: true,
					json: async () => ({ hostname: "test-abc.trycloudflare.com" }),
				} as Response;
			});

			const url = await startTunnel(8080);
			expect(url).toBe("https://test-abc.trycloudflare.com");
			expect(getTunnelUrl()).toBe("https://test-abc.trycloudflare.com");
			expect(getTunnelState()).toBe("connected");

			expect(mockSpawn).toHaveBeenCalledWith(
				[
					"cloudflared",
					"tunnel",
					"--url",
					"http://localhost:8080",
					"--metrics",
					"localhost:20241",
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
		});

		it("returns null on timeout", async () => {
			setupSpawnMock();

			(globalThis as any).fetch = vi.fn(async () => {
				throw new Error("connection refused");
			});

			// Patch the module's internal timeout by calling with a fast timeout
			// We can't control the internal timeout, so we test with the real 30s
			// Instead, let's make the test fast by mocking setTimeout
			vi.useFakeTimers();

			const promise = startTunnel(8080);

			// Advance time past the 30s timeout
			// The poll loop uses await + setTimeout, so we need to flush
			for (let i = 0; i < 70; i++) {
				await vi.advanceTimersByTimeAsync(500);
			}

			const url = await promise;
			expect(url).toBeNull();
			expect(getTunnelState()).toBe("idle"); // stopTunnel resets to idle

			vi.useRealTimers();
		});

		it("returns existing URL if already connected", async () => {
			setupSpawnMock();

			globalThis.fetch = vi.fn(async () => ({
				ok: true,
				json: async () => ({ hostname: "existing.trycloudflare.com" }),
			})) as any;

			await startTunnel(8080);
			expect(getTunnelState()).toBe("connected");

			// Second call should return existing URL without spawning again
			const url = await startTunnel(8080);
			expect(url).toBe("https://existing.trycloudflare.com");
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});
	});

	describe("stopTunnel", () => {
		it("kills process and resets state", async () => {
			const killFn = vi.fn();
			(mockSpawn as Mock).mockReturnValue({
				kill: killFn,
				exited: new Promise<void>(() => {}),
			});

			globalThis.fetch = vi.fn(async () => ({
				ok: true,
				json: async () => ({ hostname: "stop-test.trycloudflare.com" }),
			})) as any;

			await startTunnel(8080);
			expect(getTunnelState()).toBe("connected");
			expect(getTunnelUrl()).not.toBeNull();

			stopTunnel();

			expect(killFn).toHaveBeenCalled();
			expect(getTunnelUrl()).toBeNull();
			expect(getTunnelState()).toBe("idle");
		});

		it("is safe to call when no tunnel is running", () => {
			expect(getTunnelState()).toBe("idle");
			stopTunnel(); // should not throw
			expect(getTunnelState()).toBe("idle");
		});
	});

	describe("getTunnelUrl", () => {
		it("returns null when idle", () => {
			expect(getTunnelUrl()).toBeNull();
		});
	});

	describe("getTunnelState", () => {
		it("returns idle initially", () => {
			expect(getTunnelState()).toBe("idle");
		});
	});

	describe("process exit", () => {
		it("resets state to idle when process exits", async () => {
			let exitResolve!: () => void;
			const exitedPromise = new Promise<void>((r) => {
				exitResolve = r;
			});

			(mockSpawn as Mock).mockReturnValue({
				kill: vi.fn(),
				exited: exitedPromise,
			});

			globalThis.fetch = vi.fn(async () => ({
				ok: true,
				json: async () => ({ hostname: "exit-test.trycloudflare.com" }),
			})) as any;

			await startTunnel(8080);
			expect(getTunnelState()).toBe("connected");

			// Simulate process exit
			exitResolve();
			// Let the .then() callback run
			await new Promise((r) => setTimeout(r, 10));

			expect(getTunnelState()).toBe("idle");
			expect(getTunnelUrl()).toBeNull();
		});
	});
});
