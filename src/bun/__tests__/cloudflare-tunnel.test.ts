import os from "node:os";
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

// The provider is resolved from the user's real settings file, which must never
// decide what these tests exercise. Default to the built-in provider; the
// bring-your-own-tunnel cases opt in explicitly.
const providerMocks = vi.hoisted(() => ({
	resolveRemoteTunnelProvider: vi.fn<() => import("../tunnel-provider").ResolvedTunnelProvider>(() => ({
		kind: "cloudflare",
		command: null,
		urlRegex: null,
	})),
}));

vi.mock("../tunnel-provider", async () => {
	const actual = await vi.importActual<typeof import("../tunnel-provider")>("../tunnel-provider");
	return { ...actual, resolveRemoteTunnelProvider: providerMocks.resolveRemoteTunnelProvider };
});

// Hostname stability is learned from a file on disk; these tests decide the answer
// rather than the developer's own history of tunnel runs.
const hostMemoryMocks = vi.hoisted(() => ({
	recordCustomTunnelUrl: vi.fn<(command: string, url: string) => boolean>(() => false),
	customTunnelHostIsStable: vi.fn<(command: string) => boolean>(() => false),
}));

vi.mock("../tunnel-host-memory", () => hostMemoryMocks);

import { spawn as mockSpawn, spawnSync as mockSpawnSync } from "../spawn";
import {
	isTunnelBinaryAvailable,
	startTunnel,
	stopTunnel,
	getTunnelUrl,
	getTunnelState,
	parseTunnelMetricsUrl,
	parseTunnelUrl,
	resolveTunnelProtocol,
	resolveTunnelEdgeBind,
	buildTunnelArgv,
	tunnelManager,
	adoptMainTunnel,
	releaseMainTunnelForHandoff,
	stopMainTunnelForStableHandoff,
	getMainTunnelFailureReason,
	TUNNEL_EDGE_READY,
	CUSTOM_TUNNEL_EDGE_READY,
	TUNNEL_RECOVERY,
	retryMainTunnel,
	_resetState,
} from "../cloudflare-tunnel";
import { GENERIC_TUNNEL_URL_REGEX } from "../tunnel-provider";

// The edge-readiness gate polls cloudflared's /ready over the real timeout in
// production; shrink it for every test so a start without a mocked /ready falls
// through to the best-effort "connected" quickly instead of hanging.
const REAL_EDGE_READY = { ...TUNNEL_EDGE_READY };
const REAL_CUSTOM_EDGE_READY = { ...CUSTOM_TUNNEL_EDGE_READY };
const REAL_RECOVERY = { ...TUNNEL_RECOVERY };
beforeEach(() => {
	// Recovery never fires on its own here; the cases that exercise it shorten the delays.
	TUNNEL_RECOVERY.retryDelaysMs = [60_000];
	TUNNEL_RECOVERY.oldProcessExitTimeoutMs = 5;
	TUNNEL_EDGE_READY.timeoutMs = 15;
	TUNNEL_EDGE_READY.pollMs = 1;
	CUSTOM_TUNNEL_EDGE_READY.timeoutMs = 15;
	CUSTOM_TUNNEL_EDGE_READY.pollMs = 1;
	providerMocks.resolveRemoteTunnelProvider.mockReturnValue({ kind: "cloudflare", command: null, urlRegex: null });
	hostMemoryMocks.recordCustomTunnelUrl.mockReturnValue(false);
	hostMemoryMocks.customTunnelHostIsStable.mockReturnValue(false);
});
afterEach(() => {
	TUNNEL_EDGE_READY.timeoutMs = REAL_EDGE_READY.timeoutMs;
	TUNNEL_EDGE_READY.pollMs = REAL_EDGE_READY.pollMs;
	CUSTOM_TUNNEL_EDGE_READY.timeoutMs = REAL_CUSTOM_EDGE_READY.timeoutMs;
	CUSTOM_TUNNEL_EDGE_READY.pollMs = REAL_CUSTOM_EDGE_READY.pollMs;
	TUNNEL_RECOVERY.retryDelaysMs = REAL_RECOVERY.retryDelaysMs;
	TUNNEL_RECOVERY.oldProcessExitTimeoutMs = REAL_RECOVERY.oldProcessExitTimeoutMs;
	_resetState();
	vi.unstubAllGlobals();
});

// ================================================================
// resolveTunnelEdgeBind / buildTunnelArgv — leaving through a chosen interface
// ================================================================

describe("resolveTunnelEdgeBind", () => {
	const orig = process.env.DEV3_CLOUDFLARED_EDGE_BIND;
	afterEach(() => {
		if (orig === undefined) delete process.env.DEV3_CLOUDFLARED_EDGE_BIND;
		else process.env.DEV3_CLOUDFLARED_EDGE_BIND = orig;
	});

	it("is unset by default — the win is local and the choice is the operator's", () => {
		delete process.env.DEV3_CLOUDFLARED_EDGE_BIND;
		expect(resolveTunnelEdgeBind()).toBeNull();
	});

	it("treats an empty or blank value as unset", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "   ";
		expect(resolveTunnelEdgeBind()).toBeNull();
	});

	it("passes a literal IPv4 address straight through", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "172.16.32.163";
		expect(resolveTunnelEdgeBind()).toBe("172.16.32.163");
	});

	it("passes an IPv6 literal through rather than rejecting a form cloudflared accepts", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "fe80::1%en0";
		expect(resolveTunnelEdgeBind()).toBe("fe80::1%en0");
	});

	it("resolves an interface name to its address, which survives a DHCP renewal", () => {
		const named = Object.entries(os.networkInterfaces()).find(([, addrs]) =>
			addrs?.some((a) => a.family === "IPv4" && !a.internal),
		);
		if (!named) return; // CI container with no external IPv4 — nothing to assert.
		const [name, addrs] = named;
		const expected = addrs!.find((a) => a.family === "IPv4" && !a.internal)!.address;
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = name;
		expect(resolveTunnelEdgeBind()).toBe(expected);
	});

	it("drops an unknown interface instead of breaking the tunnel", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "definitely-not-an-interface";
		expect(resolveTunnelEdgeBind()).toBeNull();
	});

	// Indexed with the raw env string, `__proto__` reaches Object.prototype, where
	// `.find` is not a function — a TypeError instead of the warn-and-drop path.
	it("does not fall through the prototype chain on an absurd value", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "__proto__";
		expect(resolveTunnelEdgeBind()).toBeNull();
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "constructor";
		expect(resolveTunnelEdgeBind()).toBeNull();
	});

	it("never resolves to a loopback address, which cannot reach the edge", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "lo0";
		expect(resolveTunnelEdgeBind()).toBeNull();
	});
});

describe("buildTunnelArgv", () => {
	const orig = process.env.DEV3_CLOUDFLARED_EDGE_BIND;
	afterEach(() => {
		if (orig === undefined) delete process.env.DEV3_CLOUDFLARED_EDGE_BIND;
		else process.env.DEV3_CLOUDFLARED_EDGE_BIND = orig;
	});

	it("adds nothing when the variable is unset", () => {
		delete process.env.DEV3_CLOUDFLARED_EDGE_BIND;
		expect(buildTunnelArgv(1234)).toEqual([
			"cloudflared", "tunnel", "--protocol", "http2", "--url", "http://localhost:1234",
		]);
	});

	// Order is the whole point: before --url, cloudflared prints help and never
	// registers, which looks exactly like a slow tunnel.
	it("puts the bind flag after --url, never before it", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "10.0.0.5";
		const argv = buildTunnelArgv(1234);
		expect(argv).toEqual([
			"cloudflared", "tunnel", "--protocol", "http2", "--url", "http://localhost:1234",
			"--edge-bind-address", "10.0.0.5",
		]);
		expect(argv.indexOf("--edge-bind-address")).toBeGreaterThan(argv.indexOf("--url"));
	});

	it("passes the bind address as its own argv entry, not glued to the flag", () => {
		process.env.DEV3_CLOUDFLARED_EDGE_BIND = "10.0.0.5";
		expect(buildTunnelArgv(1234)).toContain("10.0.0.5");
		expect(buildTunnelArgv(1234).some((a) => a.includes(" "))).toBe(false);
	});
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
// isTunnelBinaryAvailable
// ================================================================

describe("isTunnelBinaryAvailable", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when which cloudflared exits 0", () => {
		(mockSpawnSync as Mock).mockReturnValue({ exitCode: 0 });
		expect(isTunnelBinaryAvailable()).toBe(true);
		expect(mockSpawnSync).toHaveBeenCalledWith(["which", "cloudflared"]);
	});

	it("returns false when exit code is non-zero", () => {
		(mockSpawnSync as Mock).mockReturnValue({ exitCode: 1 });
		expect(isTunnelBinaryAvailable()).toBe(false);
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
			"Tunnel edge not confirmed within timeout; publishing URL best-effort",
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

describe("tunnel recovery", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
	});

	afterEach(() => {
		tunnelManager.setChangeHook(null);
		// The "must not respawn" cases leave a queued spawn unconsumed on purpose.
		(mockSpawn as Mock).mockReset();
	});

	/** One spawn: a live tunnel that prints `url` and runs until `exit()`, or a failed start when `url` is null. */
	function mockTunnelProcess(url: string | null, metricsPort = 20300) {
		const encoder = new TextEncoder();
		let exit!: (code: number) => void;
		const exited = new Promise<number>((resolve) => {
			exit = resolve;
		});
		const kill = vi.fn();
		const output = url
			? `INF Starting metrics server on 127.0.0.1:${metricsPort}/metrics\nINF | ${url}\n`
			: "ERR failed to reach the edge\n";
		(mockSpawn as Mock).mockReturnValueOnce({
			kill,
			exited,
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(output));
					if (!url) controller.close();
				},
			}),
		});
		if (!url) exit(1);
		return { kill, exit };
	}

	async function failHealthChecks(times: number): Promise<void> {
		for (let i = 0; i < times; i++) await tunnelManager.checkHealth("main");
	}

	it("waits for the old process to exit before spawning its successor", async () => {
		TUNNEL_RECOVERY.oldProcessExitTimeoutMs = 5_000;
		const old = mockTunnelProcess("https://old.trycloudflare.com");
		mockTunnelProcess("https://new.trycloudflare.com");
		await startTunnel(8080);

		await failHealthChecks(2);
		const restart = tunnelManager.checkHealth("main");
		await new Promise((r) => setTimeout(r, 30));
		expect(old.kill).toHaveBeenCalled();
		expect(mockSpawn).toHaveBeenCalledTimes(1);

		old.exit(0);
		await restart;
		expect(mockSpawn).toHaveBeenCalledTimes(2);
		expect(getTunnelUrl()).toBe("https://new.trycloudflare.com");
	});

	it("SIGKILLs an old process that outlives SIGTERM, then starts the successor", async () => {
		const old = mockTunnelProcess("https://wedged.trycloudflare.com");
		mockTunnelProcess("https://fresh.trycloudflare.com");
		await startTunnel(8080);

		await failHealthChecks(3);
		expect(old.kill).toHaveBeenCalledWith(9);
		expect(getTunnelUrl()).toBe("https://fresh.trycloudflare.com");
	});

	it("does not start a successor when the tunnel is stopped while the old one is exiting", async () => {
		TUNNEL_RECOVERY.oldProcessExitTimeoutMs = 5_000;
		const old = mockTunnelProcess("https://old.trycloudflare.com");
		await startTunnel(8080);

		await failHealthChecks(2);
		const restart = tunnelManager.checkHealth("main");
		await new Promise((r) => setTimeout(r, 10));
		stopTunnel();
		old.exit(0);
		await restart;
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(getTunnelState()).toBe("idle");
	});

	it("keeps retrying a failed restart until a successor comes up", async () => {
		TUNNEL_RECOVERY.retryDelaysMs = [1];
		mockTunnelProcess("https://stale.trycloudflare.com");
		mockTunnelProcess(null);
		mockTunnelProcess(null);
		mockTunnelProcess("https://back.trycloudflare.com");
		const hook = vi.fn();
		tunnelManager.setChangeHook(hook);
		await startTunnel(8080);

		await failHealthChecks(3);
		expect(loggerMocks.error).toHaveBeenCalledWith("Tunnel restart failed", expect.objectContaining({ id: "main" }));

		await vi.waitFor(() => expect(getTunnelUrl()).toBe("https://back.trycloudflare.com"));
		expect(mockSpawn).toHaveBeenCalledTimes(4);
		expect(loggerMocks.info).toHaveBeenCalledWith("Tunnel recovered", expect.objectContaining({ id: "main", attempt: 2 }));
		expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id: "main" }), "https://stale.trycloudflare.com");
	});

	it("brings back a tunnel whose process exits on its own while serving", async () => {
		TUNNEL_RECOVERY.retryDelaysMs = [1];
		const first = mockTunnelProcess("https://first.trycloudflare.com");
		mockTunnelProcess("https://second.trycloudflare.com");
		await startTunnel(8080);

		first.exit(1);
		await vi.waitFor(() => expect(getTunnelUrl()).toBe("https://second.trycloudflare.com"));
		expect(loggerMocks.warn).toHaveBeenCalledWith("Tunnel process exited while serving", { id: "main", exitCode: 1 });
	});

	it("leaves a tunnel down after an explicit stop", async () => {
		TUNNEL_RECOVERY.retryDelaysMs = [20];
		const first = mockTunnelProcess("https://first.trycloudflare.com");
		mockTunnelProcess("https://unwanted.trycloudflare.com");
		await startTunnel(8080);

		first.exit(1);
		await new Promise((r) => setTimeout(r, 5));
		stopTunnel();
		await new Promise((r) => setTimeout(r, 50));
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		expect(getTunnelState()).toBe("idle");
	});

	it("stopAll cancels a recovery that is waiting between attempts", async () => {
		TUNNEL_RECOVERY.retryDelaysMs = [1, 250];
		const first = mockTunnelProcess("https://port.trycloudflare.com");
		mockTunnelProcess(null);
		mockTunnelProcess("https://unwanted.trycloudflare.com");
		await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });

		first.exit(1);
		await vi.waitFor(() => expect(tunnelManager.get("task:t1:port:3000")).toBeUndefined(), { interval: 2 });
		expect(mockSpawn).toHaveBeenCalledTimes(2);

		tunnelManager.stopAll({ kind: "task-port" });
		await new Promise((r) => setTimeout(r, 350));
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});

	it("retryMainTunnel brings up a main tunnel whose first start failed", async () => {
		TUNNEL_RECOVERY.retryDelaysMs = [1];
		mockTunnelProcess(null);
		mockTunnelProcess("https://late.trycloudflare.com");

		expect(await startTunnel(8080)).toBeNull();
		retryMainTunnel(8080);
		await vi.waitFor(() => expect(getTunnelUrl()).toBe("https://late.trycloudflare.com"));
	});

	it("does not retry a main tunnel whose custom command is blank", async () => {
		TUNNEL_RECOVERY.retryDelaysMs = [1];
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({ kind: "misconfigured", command: null, urlRegex: null });

		expect(await startTunnel(8080)).toBeNull();
		retryMainTunnel(8080);
		await new Promise((r) => setTimeout(r, 20));
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(loggerMocks.warn).toHaveBeenCalledWith(
			"Tunnel command is misconfigured — not retrying until it is started again",
			{ id: "main", reason: "command-empty" },
		);
	});
});

// ================================================================
// Handoff — the one place a cloudflared child is deliberately leaked
// ================================================================

describe("releaseMainTunnelForHandoff / adoptMainTunnel", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
	});

	function startWithUrl(url: string, pid = 4242) {
		const killFn = vi.fn();
		const encoder = new TextEncoder();
		(mockSpawn as Mock).mockReturnValue({
			pid,
			kill: killFn,
			exited: new Promise<void>(() => {}),
			stderr: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("INF Starting metrics server on 127.0.0.1:20241/metrics\n"));
					controller.enqueue(encoder.encode(`INF |  ${url}\n`));
					controller.close();
				},
			}),
		});
		return { killFn };
	}

	it("hands back the pid and URL WITHOUT killing cloudflared — that is the whole point", async () => {
		const { killFn } = startWithUrl("https://keepme.trycloudflare.com");
		await startTunnel(8080);

		const released = releaseMainTunnelForHandoff();

		expect(released).toEqual({
			pid: 4242,
			url: "https://keepme.trycloudflare.com",
			metricsReadyUrl: "http://127.0.0.1:20241/ready",
		});
		// Killing it would change the public hostname, which is exactly what the
		// handoff exists to prevent.
		expect(killFn).not.toHaveBeenCalled();
		// The manager has forgotten it, so nothing here will try to manage it again.
		expect(getTunnelState()).toBe("idle");
	});

	it("returns null when there is no connected tunnel to hand over", () => {
		expect(releaseMainTunnelForHandoff()).toBeNull();
	});

	it("registers an inherited process as the live main tunnel", () => {
		adoptMainTunnel({
			pid: 5150,
			url: "https://inherited.trycloudflare.com",
			metricsReadyUrl: "http://127.0.0.1:20241/ready",
			targetPort: 8080,
		});

		expect(getTunnelUrl()).toBe("https://inherited.trycloudflare.com");
		expect(getTunnelState()).toBe("connected");
		// Nothing was spawned: the process already exists.
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	// An adopted entry has `process: null`, so there is no `exited` hook to notice it
	// died — and `checkHealth` used to return immediately when `metricsReadyUrl` was
	// null, which `startEntry` legitimately produces. The entry then advertised a dead
	// `*.trycloudflare.com` hostname forever, through the banner, `dev3 remote url` and
	// every connected browser.
	it("notices an adopted process that died, even with no readiness URL", async () => {
		const aliveSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			const err = new Error("no such process") as NodeJS.ErrnoException;
			err.code = "ESRCH";
			throw err;
		});
		try {
			adoptMainTunnel({ pid: 5152, url: "https://dead.trycloudflare.com", metricsReadyUrl: null, targetPort: 8080 });
			expect(getTunnelState()).toBe("connected");

			await tunnelManager.checkHealth("main");

			// The restart re-enters startEntry, which has nothing spawnable mocked here —
			// what matters is that the dead hostname is no longer advertised as connected.
			expect(getTunnelUrl()).not.toBe("https://dead.trycloudflare.com");
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("leaves a LIVE adopted process alone when it has no readiness URL", async () => {
		const aliveSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			adoptMainTunnel({ pid: 5153, url: "https://live.trycloudflare.com", metricsReadyUrl: null, targetPort: 8080 });

			await tunnelManager.checkHealth("main");

			expect(getTunnelUrl()).toBe("https://live.trycloudflare.com");
			expect(getTunnelState()).toBe("connected");
		} finally {
			aliveSpy.mockRestore();
		}
	});

	it("signals an adopted process on stop, so a restart cannot orphan it", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			adoptMainTunnel({ pid: 5151, url: "https://x.trycloudflare.com", metricsReadyUrl: null, targetPort: 8080 });
			stopTunnel();
			expect(killSpy).toHaveBeenCalledWith(5151, "SIGTERM");
			expect(getTunnelState()).toBe("idle");
		} finally {
			killSpy.mockRestore();
		}
	});
});

// ================================================================
// Custom provider readiness — a public-URL probe stands in for cloudflared's
// local /ready endpoint, which a bring-your-own tunnel does not have.
// ================================================================

describe("custom tunnel edge readiness", () => {
	const COMMAND = "fake-tunnel {port}";

	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "custom",
			command: COMMAND,
			urlRegex: GENERIC_TUNNEL_URL_REGEX,
		});
	});

	function setupCustomSpawn(lines: string[]) {
		const encoder = new TextEncoder();
		const stream = (out: string[]) => new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of out) controller.enqueue(encoder.encode(line + "\n"));
				controller.close();
			},
		});
		(mockSpawn as Mock).mockReturnValue({
			kill: vi.fn(),
			exited: new Promise<void>(() => {}),
			stdout: stream(lines),
			stderr: stream([]),
		});
	}

	it("probes the scraped public URL instead of a metrics endpoint", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		setupCustomSpawn(["Public: https://byo-abc.example.com"]);

		const url = await startTunnel(8080);
		expect(url).toBe("https://byo-abc.example.com");
		expect(getTunnelState()).toBe("connected");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://byo-abc.example.com",
			expect.objectContaining({ method: "HEAD" }),
		);
		expect(loggerMocks.info).toHaveBeenCalledWith(
			"Tunnel connected",
			expect.objectContaining({ probe: "public-url", edgeCheck: "ready" }),
		);
	});

	it("treats an auth-gated response as a routable edge", async () => {
		// A tunnel that gates access answers 403 from its own edge — that still
		// proves the hostname resolves and forwards, which is what readiness means.
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
		setupCustomSpawn(["Public: https://gated.example.com"]);

		await startTunnel(8080);
		expect(getTunnelState()).toBe("connected");
		expect(loggerMocks.info).toHaveBeenCalledWith(
			"Tunnel connected",
			expect.objectContaining({ edgeCheck: "ready" }),
		);
		expect(loggerMocks.warn).not.toHaveBeenCalledWith(
			"Tunnel edge not confirmed within timeout; publishing URL best-effort",
			expect.anything(),
		);
	});

	it("publishes best-effort with a warning when the public URL never answers", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
		setupCustomSpawn(["Public: https://never-up.example.com"]);

		const url = await startTunnel(8080);
		expect(url).toBe("https://never-up.example.com");
		expect(getTunnelState()).toBe("connected"); // best-effort, never stuck
		expect(loggerMocks.info).toHaveBeenCalledWith(
			"Tunnel connected",
			expect.objectContaining({ probe: "public-url", edgeCheck: "unconfirmed" }),
		);
		expect(loggerMocks.warn).toHaveBeenCalledWith(
			"Tunnel edge not confirmed within timeout; publishing URL best-effort",
			expect.objectContaining({ url: "https://never-up.example.com" }),
		);
	});

	it("keeps watching the public URL after connecting, instead of trusting process liveness", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
		setupCustomSpawn(["Public: https://watched.example.com"]);
		await startTunnel(8080);

		// The edge drops while the command stays alive — the case process liveness
		// alone cannot see.
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
		await tunnelManager.checkHealth("main");

		expect(loggerMocks.warn).toHaveBeenCalledWith(
			"Tunnel public URL unreachable",
			expect.objectContaining({ probe: "public-url", consecutiveFailures: 1 }),
		);
	});
});

// ================================================================
// Stable hostnames — a custom provider that reuses its hostname does not need
// the leaked-process handoff at all.
// ================================================================

describe("custom tunnel hostname stability", () => {
	const COMMAND = "fake-tunnel {port} --name box";

	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "custom",
			command: COMMAND,
			urlRegex: GENERIC_TUNNEL_URL_REGEX,
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
	});

	function setupCustomSpawn(url: string, pid = 7373) {
		const killFn = vi.fn();
		const encoder = new TextEncoder();
		const stream = (out: string[]) => new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of out) controller.enqueue(encoder.encode(line + "\n"));
				controller.close();
			},
		});
		(mockSpawn as Mock).mockReturnValue({
			pid,
			kill: killFn,
			exited: new Promise<void>(() => {}),
			stdout: stream([`Public: ${url}`]),
			stderr: stream([]),
		});
		return { killFn };
	}

	it("reports an unproven hostname the first time a command's URL is seen", async () => {
		hostMemoryMocks.recordCustomTunnelUrl.mockReturnValue(false);
		setupCustomSpawn("https://first-run.example.com");

		await startTunnel(8080);

		expect(hostMemoryMocks.recordCustomTunnelUrl).toHaveBeenCalledWith(COMMAND, "https://first-run.example.com");
		expect(loggerMocks.info).toHaveBeenCalledWith(
			"Tunnel connected",
			expect.objectContaining({ hostname: "unproven" }),
		);
	});

	it("reports a stable hostname once the same URL has been observed again", async () => {
		hostMemoryMocks.recordCustomTunnelUrl.mockReturnValue(true);
		setupCustomSpawn("https://box-dev3.example.com");

		await startTunnel(8080);

		expect(loggerMocks.info).toHaveBeenCalledWith(
			"Tunnel connected",
			expect.objectContaining({ hostname: "stable" }),
		);
	});

	it("stops a stable-hostname tunnel for the handoff instead of leaking the process", async () => {
		hostMemoryMocks.recordCustomTunnelUrl.mockReturnValue(true);
		const { killFn } = setupCustomSpawn("https://box-dev3.example.com");
		await startTunnel(8080);

		expect(stopMainTunnelForStableHandoff()).toBe("https://box-dev3.example.com");
		// Killed on purpose: the successor's own spawn lands on the same hostname.
		expect(killFn).toHaveBeenCalled();
		expect(getTunnelState()).toBe("idle");
	});

	it("refuses the stable shortcut while the hostname is unproven, so the leak still applies", async () => {
		hostMemoryMocks.recordCustomTunnelUrl.mockReturnValue(false);
		const { killFn } = setupCustomSpawn("https://rotating.example.com");
		await startTunnel(8080);

		expect(stopMainTunnelForStableHandoff()).toBeNull();
		expect(killFn).not.toHaveBeenCalled();
		expect(releaseMainTunnelForHandoff()).toEqual(
			expect.objectContaining({ pid: 7373, url: "https://rotating.example.com" }),
		);
	});

	it("gives an adopted custom tunnel a public-URL health probe, not blind trust", async () => {
		const aliveSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			adoptMainTunnel({ pid: 7474, url: "https://inherited-byo.example.com", metricsReadyUrl: null, targetPort: 8080 });

			// The edge is gone while the inherited process is alive — the exact case a
			// liveness check reads as healthy.
			vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
			await tunnelManager.checkHealth("main");

			expect(loggerMocks.warn).toHaveBeenCalledWith(
				"Tunnel public URL unreachable",
				expect.objectContaining({ probe: "public-url", consecutiveFailures: 1 }),
			);
		} finally {
			aliveSpy.mockRestore();
		}
	});
});

// ================================================================
// Custom provider on per-task port tunnels — one provider for every kind
// ================================================================

describe("custom provider on per-task tunnels", () => {
	const COMMAND = "fake-tunnel {port}";

	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "custom",
			command: COMMAND,
			urlRegex: GENERIC_TUNNEL_URL_REGEX,
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
	});

	function setupCustomSpawn(urlByCall: string[]) {
		let call = 0;
		const encoder = new TextEncoder();
		const stream = (out: string[]) => new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of out) controller.enqueue(encoder.encode(line + "\n"));
				controller.close();
			},
		});
		(mockSpawn as Mock).mockImplementation(() => ({
			pid: 9000 + call,
			kill: vi.fn(),
			exited: new Promise<void>(() => {}),
			stdout: stream([`Public: ${urlByCall[Math.min(call++, urlByCall.length - 1)]}`]),
			stderr: stream([]),
		}));
	}

	it("spawns the custom command for a task-port tunnel, with the port substituted", async () => {
		setupCustomSpawn(["https://p3000.example.com"]);

		const entry = await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });

		expect(entry.url).toBe("https://p3000.example.com");
		const argv = (mockSpawn as Mock).mock.calls[0][0] as string[];
		expect(argv[argv.length - 1]).toBe("exec fake-tunnel 3000");
		expect(argv).not.toContain("cloudflared");
	});

	it("keeps hostname-stability learning out of port tunnels — the memory belongs to the main tunnel", async () => {
		setupCustomSpawn(["https://p3000.example.com"]);

		const entry = await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });

		expect(hostMemoryMocks.recordCustomTunnelUrl).not.toHaveBeenCalled();
		expect(entry.stableHostname).toBe(false);
	});

	it("warns when two live tunnels land on one public URL (fixed-hostname command)", async () => {
		setupCustomSpawn(["https://fixed.example.com", "https://fixed.example.com"]);

		await tunnelManager.start({ id: "main", kind: "main", targetPort: 8080 });
		await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });

		expect(loggerMocks.warn).toHaveBeenCalledWith(
			expect.stringContaining("Two live tunnels share one public URL"),
			expect.objectContaining({ id: "task:t1:port:3000", conflictsWith: "main" }),
		);
	});

	it("stays quiet when concurrent tunnels get distinct hostnames", async () => {
		setupCustomSpawn(["https://a.example.com", "https://b.example.com"]);

		await tunnelManager.start({ id: "main", kind: "main", targetPort: 8080 });
		await tunnelManager.start({ id: "task:t1:port:3000", kind: "task-port", targetPort: 3000, taskId: "t1" });

		expect(loggerMocks.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("Two live tunnels share one public URL"),
			expect.anything(),
		);
	});
});

// ================================================================
// Fail-closed misconfiguration + runtime-derived availability
// ================================================================

describe("misconfigured custom provider (blank command)", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "misconfigured",
			command: null,
			urlRegex: null,
		});
	});

	it("starts NOTHING — never falls back to cloudflared", async () => {
		const url = await startTunnel(8080);

		expect(url).toBeNull();
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(getMainTunnelFailureReason()).toBe("command-empty");
	});

	it("reports the binary as unavailable so the modal explains instead of toggling", () => {
		expect(isTunnelBinaryAvailable()).toBe(false);
	});
});

describe("custom command availability is derived from the run, not a PATH probe", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "custom",
			// The shapes a string probe gets wrong: quoted path + env assignment.
			command: 'NGROK_AUTHTOKEN=abc "/opt/my tools/tunnel.sh" {port}',
			urlRegex: GENERIC_TUNNEL_URL_REGEX,
		});
	});

	it("never pre-judges a custom command", () => {
		expect(isTunnelBinaryAvailable()).toBe(true);
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("records command-not-found when sh exits 127 before printing a URL", async () => {
		const encoder = new TextEncoder();
		const stream = (out: string[]) => new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of out) controller.enqueue(encoder.encode(line + "\n"));
				controller.close();
			},
		});
		(mockSpawn as Mock).mockReturnValue({
			pid: 4141,
			kill: vi.fn(),
			// Settles AFTER the output streams close, like a real process — an
			// already-resolved promise here would hide the read-before-exit race.
			exited: new Promise<number>((resolve) => setTimeout(() => resolve(127), 20)),
			stdout: stream([]),
			stderr: stream(["sh: tunnel.sh: command not found"]),
		});

		const url = await startTunnel(8080);

		expect(url).toBeNull();
		expect(getMainTunnelFailureReason()).toBe("command-not-found");
	});

	it("sweeps a pipeline's children captured BEFORE the wrapper shell dies", async () => {
		const encoder = new TextEncoder();
		const stream = (out: string[]) => new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of out) controller.enqueue(encoder.encode(line + "\n"));
				controller.close();
			},
		});
		const killFn = vi.fn();
		(mockSpawn as Mock).mockReturnValue({
			pid: 5150,
			kill: killFn,
			exited: new Promise<void>(() => {}),
			stdout: stream(["Public: https://pipe.example.com"]),
			stderr: stream([]),
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
		await startTunnel(8080);

		// pgrep answers with a surviving pipeline child; it must be captured
		// before sh is killed (afterwards it is reparented to init and unfindable).
		(mockSpawnSync as Mock).mockReturnValue({ exitCode: 0, stdout: Buffer.from("6161\n") });
		const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			stopTunnel();
			expect(mockSpawnSync).toHaveBeenCalledWith(["pgrep", "-P", "5150"]);
			expect(killFn).toHaveBeenCalled();
			expect(processKill).toHaveBeenCalledWith(6161, "SIGTERM");
		} finally {
			processKill.mockRestore();
		}
	});
});

describe("metrics line from a custom CLI is ignored", () => {
	beforeEach(() => {
		_resetState();
		vi.clearAllMocks();
		providerMocks.resolveRemoteTunnelProvider.mockReturnValue({
			kind: "custom",
			command: "fake-tunnel {port}",
			urlRegex: GENERIC_TUNNEL_URL_REGEX,
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
	});

	it("keeps the public-URL health probe even when the CLI prints a metrics-server line", async () => {
		const encoder = new TextEncoder();
		const stream = (out: string[]) => new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of out) controller.enqueue(encoder.encode(line + "\n"));
				controller.close();
			},
		});
		(mockSpawn as Mock).mockReturnValue({
			pid: 4242,
			kill: vi.fn(),
			exited: new Promise<void>(() => {}),
			stdout: stream([
				"Starting metrics server on 127.0.0.1:9999/metrics",
				"Public: https://byo.example.com",
			]),
			stderr: stream([]),
		});

		await startTunnel(8080);

		const entry = tunnelManager.get("main");
		expect(entry?.url).toBe("https://byo.example.com");
		// A /ready endpoint that is not cloudflared's must not displace the
		// public-URL probe this provider relies on.
		expect(entry?.metricsReadyUrl).toBeNull();
		expect(entry?.publicProbeUrl).toBe("https://byo.example.com");
	});
});
