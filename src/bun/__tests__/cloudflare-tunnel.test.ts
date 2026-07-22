import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => loggerMocks,
}));

import { spawn as mockSpawn, spawnSync as mockSpawnSync } from "../spawn";
import {
	isCloudflaredAvailable,
	startTunnel,
	stopTunnel,
	getTunnelUrl,
	getTunnelState,
	parseTunnelMetricsUrl,
	parseTunnelUrl,
	resolveTunnelProtocol,
	tunnelManager,
	TUNNEL_EDGE_READY,
	_resetState,
} from "../cloudflare-tunnel";

// The edge-readiness gate polls cloudflared's /ready over the real timeout in
// production; shrink it for every test so a start without a mocked /ready falls
// through to the best-effort "connected" quickly instead of hanging.
const REAL_EDGE_READY = { ...TUNNEL_EDGE_READY };
beforeEach(() => {
	TUNNEL_EDGE_READY.timeoutMs = 15;
	TUNNEL_EDGE_READY.pollMs = 1;
});
afterEach(() => {
	TUNNEL_EDGE_READY.timeoutMs = REAL_EDGE_READY.timeoutMs;
	TUNNEL_EDGE_READY.pollMs = REAL_EDGE_READY.pollMs;
	vi.unstubAllGlobals();
});

// ================================================================
// resolveTunnelProtocol — QUIC/UDP-7844-blocked networks need http2
// ================================================================

describe("resolveTunnelProtocol", () => {
	const orig = process.env.DEV3_CLOUDFLARED_PROTOCOL;
	afterEach(() => {
		if (orig === undefined) delete process.env.DEV3_CLOUDFLARED_PROTOCOL;
		else process.env.DEV3_CLOUDFLARED_PROTOCOL = orig;
	});

	it("defaults to http2 (QUIC is blocked on many corporate networks)", () => {
		delete process.env.DEV3_CLOUDFLARED_PROTOCOL;
		expect(resolveTunnelProtocol()).toBe("http2");
	});

	it("honours a valid override", () => {
		process.env.DEV3_CLOUDFLARED_PROTOCOL = "quic";
		expect(resolveTunnelProtocol()).toBe("quic");
		process.env.DEV3_CLOUDFLARED_PROTOCOL = "auto";
		expect(resolveTunnelProtocol()).toBe("auto");
		process.env.DEV3_CLOUDFLARED_PROTOCOL = "HTTP2";
		expect(resolveTunnelProtocol()).toBe("http2");
	});

	it("falls back to http2 for an unknown/garbage value", () => {
		process.env.DEV3_CLOUDFLARED_PROTOCOL = "wireguard";
		expect(resolveTunnelProtocol()).toBe("http2");
	});
});

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

describe("parseTunnelMetricsUrl", () => {
	it("extracts the local readiness endpoint from cloudflared output", () => {
		expect(
			parseTunnelMetricsUrl("2026-07-13T12:54:39Z INF Starting metrics server on 127.0.0.1:20241/metrics"),
		).toBe("http://127.0.0.1:20241/ready");
	});

	it("returns null for unrelated output", () => {
		expect(parseTunnelMetricsUrl("INF Registered tunnel connection")).toBeNull();
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
			["cloudflared", "tunnel", "--protocol", "http2", "--url", "http://localhost:8080"],
			{ stdout: "ignore", stderr: "pipe" },
		);
	});

	it("waits for cloudflared /ready before marking the tunnel connected", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
		vi.stubGlobal("fetch", fetchMock);
		setupSpawnMock([
			"INF Starting metrics server on 127.0.0.1:20241/metrics",
			"INF |  https://ready-abc.trycloudflare.com",
		]);

		const url = await startTunnel(8080);
		expect(url).toBe("https://ready-abc.trycloudflare.com");
		expect(getTunnelState()).toBe("connected");
		// Gated on cloudflared's local /ready endpoint, not an external round-trip.
		expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:20241/ready", expect.anything());
	});

	it("publishes the URL best-effort (with a warning) if /ready never turns green", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
		setupSpawnMock([
			"INF Starting metrics server on 127.0.0.1:20241/metrics",
			"INF |  https://slow-edge.trycloudflare.com",
		]);

		const url = await startTunnel(8080);
		expect(url).toBe("https://slow-edge.trycloudflare.com");
		expect(getTunnelState()).toBe("connected"); // best-effort fallback, not stuck
		expect(loggerMocks.warn).toHaveBeenCalledWith(
			"Tunnel /ready not confirmed within timeout; publishing URL best-effort",
			expect.objectContaining({ url: "https://slow-edge.trycloudflare.com" }),
		);
	});

	it("keeps draining and logging cloudflared stderr after finding the URL", async () => {
		const encoder = new TextEncoder();
		let stderrController!: ReadableStreamDefaultController<Uint8Array>;
		(mockSpawn as Mock).mockReturnValue({
			kill: vi.fn(),
			exited: new Promise<void>(() => {}),
			stderr: new ReadableStream({
				start(controller) {
					stderrController = controller;
					controller.enqueue(encoder.encode("INF | https://logged.trycloudflare.com\n"));
				},
			}),
		});

		await startTunnel(8080);
		stderrController.enqueue(encoder.encode("ERR registration failed after startup\n"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(loggerMocks.error).toHaveBeenCalledWith("cloudflared", {
			id: "main",
			line: "ERR registration failed after startup",
		});
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

// ================================================================
// tunnelManager — multi-entry coverage
// ================================================================

describe("tunnelManager", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
	});

	function mockSpawnReturning(url: string) {
		const encoder = new TextEncoder();
		(mockSpawn as Mock).mockReturnValueOnce({
			kill: vi.fn(),
			exited: new Promise<void>(() => {}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(`INF | ${url}\n`));
					controller.close();
				},
			}),
		});
	}

	it("tracks multiple tunnels independently by id", async () => {
		mockSpawnReturning("https://tunnel-a.trycloudflare.com");
		mockSpawnReturning("https://tunnel-b.trycloudflare.com");

		const a = await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });
		const b = await tunnelManager.start({ id: "task:t1:port:5173", kind: "task-port", targetPort: 5173, taskId: "t1" });

		expect(a.url).toBe("https://tunnel-a.trycloudflare.com");
		expect(b.url).toBe("https://tunnel-b.trycloudflare.com");
		expect(tunnelManager.list({ taskId: "t1" })).toHaveLength(2);
	});

	it("filters list by kind and taskId", async () => {
		mockSpawnReturning("https://main.trycloudflare.com");
		mockSpawnReturning("https://port-a.trycloudflare.com");
		mockSpawnReturning("https://port-b.trycloudflare.com");

		await tunnelManager.start({ id: "main", kind: "main", targetPort: 8080 });
		await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });
		await tunnelManager.start({ id: "task:t2:port:3000", kind: "task-port", targetPort: 3000, taskId: "t2" });

		expect(tunnelManager.list({ kind: "main" })).toHaveLength(1);
		expect(tunnelManager.list({ kind: "task-port" })).toHaveLength(2);
		expect(tunnelManager.list({ taskId: "t1" })).toHaveLength(1);
		expect(tunnelManager.list({ kind: "task-port", taskId: "t2" })).toHaveLength(1);
	});

	it("stopAll with kind filter leaves other kinds running", async () => {
		mockSpawnReturning("https://main.trycloudflare.com");
		mockSpawnReturning("https://port-a.trycloudflare.com");

		await tunnelManager.start({ id: "main", kind: "main", targetPort: 8080 });
		await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });

		tunnelManager.stopAll({ kind: "task-port" });

		expect(tunnelManager.get("main")?.state).toBe("connected");
		expect(tunnelManager.get("task:t1:port:3000")).toBeUndefined();
	});

	it("mints a unique subToken per entry", async () => {
		mockSpawnReturning("https://a.trycloudflare.com");
		mockSpawnReturning("https://b.trycloudflare.com");

		const a = await tunnelManager.start({ id: "task:t1:shared", kind: "task-shared", targetPort: 8080, taskId: "t1", ports: [3000, 5173] });
		const b = await tunnelManager.start({ id: "task:t2:shared", kind: "task-shared", targetPort: 8080, taskId: "t2", ports: [3001] });

		expect(a.subToken).toBeTruthy();
		expect(b.subToken).toBeTruthy();
		expect(a.subToken).not.toBe(b.subToken);
		expect(a.ports).toEqual([3000, 5173]);
		expect(b.ports).toEqual([3001]);
	});

	it("back-compat startTunnel/stopTunnel operate on main entry", async () => {
		mockSpawnReturning("https://main-compat.trycloudflare.com");

		const url = await startTunnel(8080);
		expect(url).toBe("https://main-compat.trycloudflare.com");
		expect(getTunnelUrl()).toBe("https://main-compat.trycloudflare.com");
		expect(getTunnelState()).toBe("connected");
		expect(tunnelManager.get("main")).toBeDefined();

		stopTunnel();
		expect(getTunnelState()).toBe("idle");
		expect(tunnelManager.get("main")).toBeUndefined();
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

describe("edge readiness watchdog", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mockLiveTunnel(url: string, metricsPort: number) {
		const encoder = new TextEncoder();
		(mockSpawn as Mock).mockReturnValueOnce({
			kill: vi.fn(),
			exited: new Promise<void>(() => {}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(
						`INF Starting metrics server on 127.0.0.1:${metricsPort}/metrics\nINF | ${url}\n`,
					));
				},
			}),
		});
	}

	it("restarts a live process after three consecutive edge-readiness failures", async () => {
		mockLiveTunnel("https://stale.trycloudflare.com", 20241);
		mockLiveTunnel("https://recovered.trycloudflare.com", 20242);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			JSON.stringify({ status: 503, readyConnections: 0 }),
			{ status: 503, headers: { "content-type": "application/json" } },
		)));

		await startTunnel(8080);
		expect(tunnelManager.get("main")?.metricsReadyUrl).toBe("http://127.0.0.1:20241/ready");

		await tunnelManager.checkHealth("main");
		await tunnelManager.checkHealth("main");
		await tunnelManager.checkHealth("main");

		expect(mockSpawn).toHaveBeenCalledTimes(2);
		expect(getTunnelUrl()).toBe("https://recovered.trycloudflare.com");
		expect(loggerMocks.warn).toHaveBeenCalledWith("Tunnel unhealthy; restarting", expect.objectContaining({
			id: "main",
			consecutiveFailures: 3,
		}));
	});
});
