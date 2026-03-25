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
	parseTunnelUrl,
	_resetState,
} from "../cloudflare-tunnel";

// ================================================================
// parseTunnelUrl — unit tests for stderr parser
// ================================================================

describe("parseTunnelUrl", () => {
	it("extracts URL from typical cloudflared output line", () => {
		expect(parseTunnelUrl("INF |  https://abc-random-123.trycloudflare.com")).toBe(
			"https://abc-random-123.trycloudflare.com",
		);
	});

	it("extracts URL from log line with timestamp", () => {
		expect(
			parseTunnelUrl("2026-03-25T12:00:00Z INF +--- https://my-tunnel.trycloudflare.com ---+"),
		).toBe("https://my-tunnel.trycloudflare.com");
	});

	it("extracts URL with underscores in hostname", () => {
		expect(parseTunnelUrl("https://under_score_test.trycloudflare.com")).toBe(
			"https://under_score_test.trycloudflare.com",
		);
	});

	it("extracts URL embedded in the middle of a line", () => {
		expect(
			parseTunnelUrl("Your tunnel URL is https://test-xyz.trycloudflare.com and it works"),
		).toBe("https://test-xyz.trycloudflare.com");
	});

	it("returns null for lines without tunnel URL", () => {
		expect(parseTunnelUrl("INF Starting tunnel")).toBeNull();
		expect(parseTunnelUrl("")).toBeNull();
		expect(parseTunnelUrl("https://example.com")).toBeNull();
		expect(parseTunnelUrl("trycloudflare.com")).toBeNull();
	});

	it("returns null for http (non-https) trycloudflare URLs", () => {
		expect(parseTunnelUrl("http://test.trycloudflare.com")).toBeNull();
	});

	it("handles line with multiple URLs — returns the first", () => {
		const line = "https://first.trycloudflare.com and https://second.trycloudflare.com";
		expect(parseTunnelUrl(line)).toBe("https://first.trycloudflare.com");
	});

	it("handles dashes in hostname", () => {
		expect(parseTunnelUrl("https://a-b-c-d-e-f.trycloudflare.com")).toBe(
			"https://a-b-c-d-e-f.trycloudflare.com",
		);
	});
});

// ================================================================
// isCloudflaredAvailable
// ================================================================

describe("isCloudflaredAvailable", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

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

// ================================================================
// startTunnel / stopTunnel / getTunnelUrl / getTunnelState
// ================================================================

describe("startTunnel", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
	});

	function makeStderrStream(lines: string[], delayMs = 0): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream({
			async start(controller) {
				for (const line of lines) {
					if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
					controller.enqueue(encoder.encode(line + "\n"));
				}
				controller.close();
			},
		});
	}

	function setupSpawnMock(stderrLines: string[], delayMs = 0) {
		const killFn = vi.fn();
		let exitResolve: () => void;
		const exitedPromise = new Promise<void>((r) => {
			exitResolve = r;
		});

		(mockSpawn as Mock).mockReturnValue({
			kill: killFn,
			exited: exitedPromise,
			stderr: makeStderrStream(stderrLines, delayMs),
		});

		return { killFn, triggerExit: () => exitResolve!() };
	}

	it("returns public URL when found in stderr", async () => {
		setupSpawnMock([
			"INF Starting tunnel",
			"INF Registered connection",
			"INF |  https://test-abc.trycloudflare.com",
			"INF Connection established",
		]);

		const url = await startTunnel(8080);
		expect(url).toBe("https://test-abc.trycloudflare.com");
		expect(getTunnelUrl()).toBe("https://test-abc.trycloudflare.com");
		expect(getTunnelState()).toBe("connected");

		expect(mockSpawn).toHaveBeenCalledWith(
			["cloudflared", "tunnel", "--url", "http://localhost:8080"],
			{ stdout: "ignore", stderr: "pipe" },
		);
	});

	it("returns null when stderr closes without URL", async () => {
		setupSpawnMock([
			"INF Starting tunnel",
			"ERR Something went wrong",
		]);

		const url = await startTunnel(8080);
		expect(url).toBeNull();
		expect(getTunnelState()).toBe("idle"); // stopTunnel resets
	});

	it("returns existing URL if already connected", async () => {
		setupSpawnMock([
			"INF |  https://existing.trycloudflare.com",
		]);

		await startTunnel(8080);
		expect(getTunnelState()).toBe("connected");

		const url = await startTunnel(8080);
		expect(url).toBe("https://existing.trycloudflare.com");
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});
});

describe("stopTunnel", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
	});

	it("kills process and resets state", async () => {
		const killFn = vi.fn();
		const encoder = new TextEncoder();
		(mockSpawn as Mock).mockReturnValue({
			kill: killFn,
			exited: new Promise<void>(() => {}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("https://stop-test.trycloudflare.com\n"));
					controller.close();
				},
			}),
		});

		await startTunnel(8080);
		expect(getTunnelState()).toBe("connected");

		stopTunnel();

		expect(killFn).toHaveBeenCalled();
		expect(getTunnelUrl()).toBeNull();
		expect(getTunnelState()).toBe("idle");
	});

	it("is safe to call when no tunnel is running", () => {
		expect(getTunnelState()).toBe("idle");
		stopTunnel();
		expect(getTunnelState()).toBe("idle");
	});
});

describe("getTunnelUrl", () => {
	beforeEach(() => _resetState());

	it("returns null when idle", () => {
		expect(getTunnelUrl()).toBeNull();
	});
});

describe("getTunnelState", () => {
	beforeEach(() => _resetState());

	it("returns idle initially", () => {
		expect(getTunnelState()).toBe("idle");
	});
});

describe("process exit", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
	});

	it("resets state to idle when process exits", async () => {
		let exitResolve!: () => void;
		const exitedPromise = new Promise<void>((r) => {
			exitResolve = r;
		});

		const encoder = new TextEncoder();
		(mockSpawn as Mock).mockReturnValue({
			kill: vi.fn(),
			exited: exitedPromise,
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("https://exit-test.trycloudflare.com\n"));
					controller.close();
				},
			}),
		});

		await startTunnel(8080);
		expect(getTunnelState()).toBe("connected");

		exitResolve();
		await new Promise((r) => setTimeout(r, 10));

		expect(getTunnelState()).toBe("idle");
		expect(getTunnelUrl()).toBeNull();
	});
});
