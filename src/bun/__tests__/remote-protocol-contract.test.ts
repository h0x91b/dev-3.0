/**
 * Wire-level contract tests for native and browser remote clients.
 *
 * These call the Bun.serve handlers directly: no port allocation, real socket,
 * filesystem secret, or tunnel is needed, but the exact HTTP/WS boundary is
 * exercised rather than reimplementing server logic in the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../electrobun-platform", () => ({
	PATHS: { VIEWS_FOLDER: "/nonexistent-views" },
	Utils: {},
	Updater: {
		localInfo: {
			version: vi.fn().mockResolvedValue("0.0.0-test"),
			hash: vi.fn().mockResolvedValue("deadbeef"),
			channel: vi.fn().mockResolvedValue("dev"),
		},
	},
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../jwt", () => ({
	initSecret: vi.fn(),
	createQrToken: vi.fn().mockResolvedValue("qr-token"),
	createSessionToken: vi.fn().mockResolvedValue("session-token"),
	exchangeQrForSession: vi.fn(async (_token: string, client?: "ios") =>
		client === "ios" ? "ios-session-token" : "session-token"),
	refreshSession: vi.fn().mockResolvedValue("refreshed-session-token"),
	getSessionTokenTtl: vi.fn(async (token: string) =>
		token.includes("ios") ? 30 * 24 * 60 * 60 : 24 * 60 * 60),
	verifySessionToken: vi.fn(async (token: string) => token === "valid-session"),
	IOS_SESSION_TOKEN_TTL_S: 30 * 24 * 60 * 60,
	SESSION_TOKEN_TTL_S: 24 * 60 * 60,
}));

vi.mock("../cloudflare-tunnel", () => ({
	getTunnelUrl: vi.fn().mockReturnValue(null),
	getTunnelState: vi.fn().mockReturnValue("stopped"),
	tunnelManager: { list: vi.fn().mockReturnValue([]) },
}));

vi.mock("../settings", () => ({
	loadSettingsSync: vi.fn(() => ({ theme: "dark", resolvedTheme: "dark" })),
}));

vi.mock("../theme-state", () => ({
	getCurrentUiTheme: vi.fn(() => "dark"),
}));

vi.mock("../remote-instance", () => ({
	getRemoteInstanceInfo: vi.fn(() => ({
		instanceId: "0190f3d1-0e39-4f72-87a7-48c7a4d93847",
		name: "Test Mac",
		appVersion: "1.36.0",
		protocolVersion: 1,
	})),
}));

vi.mock("../remote-discovery", () => ({
	startRemoteDiscoveryAdvertisement: vi.fn().mockResolvedValue({ stop: vi.fn() }),
}));

vi.mock("qrcode", () => ({
	default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test") },
}));

import { exchangeQrForSession, refreshSession } from "../jwt";
import { startRemoteDiscoveryAdvertisement } from "../remote-discovery";
import {
	buildClearSessionCookie,
	buildSessionCookie,
	getConnectedClientCount,
	pushToBrowserClients,
	startRemoteAccessServer,
	stopRemoteAccessServer,
} from "../remote-access-server";

type ServeOptions = {
	fetch(req: Request, server: { upgrade: ReturnType<typeof vi.fn> }): Promise<Response | undefined>;
	websocket: {
		open(ws: FakeSocket): void;
		message(ws: FakeSocket, data: string | ArrayBuffer): void;
		close(ws: FakeSocket): void;
	};
};

type FakeSocket = {
	data: { type: "rpc" | "pty"; sessionId?: string };
	send: ReturnType<typeof vi.fn>;
	sendText: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	_ptyUpstream?: unknown;
};

let serveOptions: ServeOptions;
let originalServe: typeof Bun.serve;
let ptyPort = 43210;
let serverStop: ReturnType<typeof vi.fn>;
let discoveryStop: ReturnType<typeof vi.fn>;

function request(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("host", "dev3.test:4242");
	return new Request(`http://dev3.test:4242${path}`, { ...init, headers });
}

function authenticatedRequest(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("cookie", "dev3_session=valid-session");
	return request(path, { ...init, headers });
}

function fakeSocket(data: FakeSocket["data"]): FakeSocket {
	return {
		data,
		send: vi.fn(),
		sendText: vi.fn(),
		close: vi.fn(),
	};
}

async function dispatch(req: Request, upgrade = vi.fn(() => true)) {
	return {
		response: await serveOptions.fetch(req, { upgrade }),
		upgrade,
	};
}

beforeAll(async () => {
	originalServe = Bun.serve;
	(Bun as any).serve = vi.fn((options: ServeOptions) => {
		serveOptions = options;
		serverStop = vi.fn();
		return { port: 4242, stop: serverStop };
	});

	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	await startRemoteAccessServer({
		getPtyPort: () => ptyPort,
		rpcHandler: async (method, params) => {
			if (method === "echo") return params;
			throw new Error(`Unknown RPC method: ${method}`);
		},
	});
	discoveryStop = (await vi.mocked(startRemoteDiscoveryAdvertisement).mock.results[0].value)?.stop as ReturnType<typeof vi.fn>;
	consoleLog.mockRestore();
});

afterAll(() => {
	stopRemoteAccessServer();
	expect(discoveryStop).toHaveBeenCalledTimes(1);
	expect(serverStop).toHaveBeenCalledWith(true);
	(Bun as any).serve = originalServe;
});

beforeEach(() => {
	ptyPort = 43210;
	vi.mocked(exchangeQrForSession).mockClear();
	vi.mocked(refreshSession).mockReset().mockResolvedValue("refreshed-session-token");
});

describe("remote HTTP contract", () => {
	it("advertises discovery on the actual bound server port", () => {
		expect(startRemoteDiscoveryAdvertisement).toHaveBeenCalledWith({
			instanceId: "0190f3d1-0e39-4f72-87a7-48c7a4d93847",
			name: "Test Mac",
			appVersion: "1.36.0",
			protocolVersion: 1,
		}, 4242);
	});

	it("pins the 24-hour cookie attributes and clear-cookie attributes", () => {
		expect(buildSessionCookie("token")).toBe(
			"dev3_session=token; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict",
		);
		expect(buildClearSessionCookie()).toBe(
			"dev3_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict",
		);
	});

	it("grants a 30-day iOS session only when the native request omits Origin", async () => {
		const { response } = await dispatch(request("/auth/exchange", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: "qr-token", client: "ios" }),
		}));

		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({ ok: true });
		expect(response?.headers.get("set-cookie")).toBe(
			"dev3_session=ios-session-token; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict",
		);
		expect(exchangeQrForSession).toHaveBeenCalledWith("qr-token", "ios");

		vi.mocked(exchangeQrForSession).mockClear();
		const browserSpoof = await dispatch(request("/auth/exchange", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://dev3.test:4242",
			},
			body: JSON.stringify({ token: "qr-token", client: "ios" }),
		}));
		expect(browserSpoof.response?.status).toBe(200);
		expect(browserSpoof.response?.headers.get("set-cookie")).toContain("Max-Age=86400");
		expect(exchangeQrForSession).toHaveBeenCalledWith("qr-token", undefined);
	});

	it("refreshes a valid session and clears only a presented invalid session", async () => {
		const refreshed = await dispatch(authenticatedRequest("/auth/refresh", { method: "POST" }));
		expect(refreshed.response?.status).toBe(200);
		expect(await refreshed.response?.json()).toEqual({ ok: true });
		expect(refreshed.response?.headers.get("set-cookie")).toBe(
			"dev3_session=refreshed-session-token; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict",
		);

		const missing = await dispatch(request("/auth/refresh", { method: "POST" }));
		expect(missing.response?.status).toBe(401);
		expect(missing.response?.headers.get("set-cookie")).toBeNull();

		vi.mocked(refreshSession).mockResolvedValueOnce(null);
		const invalid = await dispatch(request("/auth/refresh", {
			method: "POST",
			headers: { cookie: "dev3_session=invalid-session" },
		}));
		expect(invalid.response?.status).toBe(401);
		expect(invalid.response?.headers.get("set-cookie")).toBe(
			"dev3_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict",
		);

		vi.mocked(refreshSession).mockResolvedValueOnce("refreshed-ios-session-token");
		const native = await dispatch(authenticatedRequest("/auth/refresh", { method: "POST" }));
		expect(native.response?.headers.get("set-cookie")).toBe(
			"dev3_session=refreshed-ios-session-token; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict",
		);
	});

	it("serves unauthenticated versioned instance metadata and restricts the method", async () => {
		const { response } = await dispatch(request("/instance"));
		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(await response?.json()).toEqual({
			instanceId: "0190f3d1-0e39-4f72-87a7-48c7a4d93847",
			name: "Test Mac",
			appVersion: "1.36.0",
			protocolVersion: 1,
		});

		const wrongMethod = await dispatch(request("/instance", { method: "POST" }));
		expect(wrongMethod.response?.status).toBe(405);
		expect(wrongMethod.response?.headers.get("allow")).toBe("GET");
	});

	it("requires a session cookie for health and returns PTY availability", async () => {
		const unauthorized = await dispatch(request("/health"));
		expect(unauthorized.response?.status).toBe(401);

		const healthy = await dispatch(authenticatedRequest("/health"));
		expect(healthy.response?.status).toBe(200);
		expect(await healthy.response?.json()).toEqual({ ok: true, ptyPort: 43210 });
	});

	it("authenticates RPC and preserves the exact upgrade metadata", async () => {
		const unauthorized = await dispatch(request("/rpc"));
		expect(unauthorized.response?.status).toBe(401);

		const { response, upgrade } = await dispatch(authenticatedRequest("/rpc"));
		expect(response).toBeUndefined();
		expect(upgrade).toHaveBeenCalledWith(expect.any(Request), { data: { type: "rpc" } });
	});

	it("rejects cross-origin RPC upgrades before cookie authentication", async () => {
		const { response, upgrade } = await dispatch(authenticatedRequest("/rpc", {
			headers: { origin: "https://hostile.example" },
		}));
		expect(response?.status).toBe(403);
		expect(upgrade).not.toHaveBeenCalled();
	});

	it("accepts task and project PTY session forms and rejects a missing session", async () => {
		for (const sessionId of ["task-123", "project-project-456"]) {
			const { response, upgrade } = await dispatch(authenticatedRequest(
				`/pty?session=${encodeURIComponent(sessionId)}`,
			));
			expect(response).toBeUndefined();
			expect(upgrade).toHaveBeenCalledWith(expect.any(Request), {
				data: { type: "pty", sessionId },
			});
		}

		const missing = await dispatch(authenticatedRequest("/pty"));
		expect(missing.response?.status).toBe(400);
		expect(await missing.response?.text()).toBe("Missing session param");
	});
});

describe("RPC WebSocket contract", () => {
	it("correlates successful and unknown-method responses by request id", async () => {
		const ws = fakeSocket({ type: "rpc" });
		serveOptions.websocket.open(ws);

		serveOptions.websocket.message(ws, JSON.stringify({
			type: "request", id: 41, method: "echo", params: { value: "ok" },
		}));
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(1));
		expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
			type: "response", id: 41, success: true, payload: { value: "ok" },
		});

		serveOptions.websocket.message(ws, JSON.stringify({
			type: "request", id: "request-42", method: "missing", params: null,
		}));
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
		expect(JSON.parse(ws.send.mock.calls[1][0])).toEqual({
			type: "response",
			id: "request-42",
			success: false,
			error: "Unknown RPC method: missing",
		});

		serveOptions.websocket.close(ws);
	});

	it("ignores client packets that are not requests", async () => {
		const ws = fakeSocket({ type: "rpc" });
		serveOptions.websocket.open(ws);
		serveOptions.websocket.message(ws, JSON.stringify({ type: "message", id: "client-event", payload: {} }));
		await Promise.resolve();
		expect(ws.send).not.toHaveBeenCalled();
		serveOptions.websocket.close(ws);
	});

	it("pushes only to currently connected clients and does not replay", () => {
		const first = fakeSocket({ type: "rpc" });
		serveOptions.websocket.open(first);
		expect(getConnectedClientCount()).toBe(1);

		pushToBrowserClients("taskUpdated", { projectId: "project-1", task: { id: "task-1" } });
		expect(JSON.parse(first.send.mock.calls[0][0])).toEqual({
			type: "message",
			id: "taskUpdated",
			payload: { projectId: "project-1", task: { id: "task-1" } },
		});

		serveOptions.websocket.close(first);
		const second = fakeSocket({ type: "rpc" });
		serveOptions.websocket.open(second);
		expect(second.send).not.toHaveBeenCalled();
		serveOptions.websocket.close(second);
	});
});

describe("PTY proxy close contract", () => {
	it("uses 4002 when the internal PTY server is unavailable", () => {
		ptyPort = 0;
		const ws = fakeSocket({ type: "pty", sessionId: "task-1" });
		serveOptions.websocket.open(ws);
		expect(ws.close).toHaveBeenCalledWith(4002, "PTY server not available");
	});

	it("uses 4003 on upstream failure", () => {
		const originalWebSocket = globalThis.WebSocket;
		const listeners = new Map<string, (event?: any) => void>();
		class FakeWebSocket {
			static OPEN = 1;
			readyState = 1;
			addEventListener(name: string, listener: (event?: any) => void) {
				listeners.set(name, listener);
			}
			send() {}
			close() {}
		}
		globalThis.WebSocket = FakeWebSocket as any;

		try {
			const ws = fakeSocket({ type: "pty", sessionId: "missing-task" });
			serveOptions.websocket.open(ws);
			listeners.get("error")?.();
			expect(ws.close).toHaveBeenCalledOnce();
			expect(ws.close).toHaveBeenCalledWith(4003, "PTY upstream error");
			// A close event after the error must not replace the first failure.
			listeners.get("close")?.({ code: 1006, reason: "" });
			expect(ws.close).toHaveBeenCalledOnce();
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}
	});

	it.each([
		[4000, "Missing session parameter"],
		[4001, "Unknown session"],
		[4002, "PTY server not available"],
		[4003, "PTY upstream error"],
	])("preserves upstream close code %i and its reason", (code, reason) => {
		const originalWebSocket = globalThis.WebSocket;
		const listeners = new Map<string, (event?: any) => void>();
		class FakeWebSocket {
			static OPEN = 1;
			readyState = 1;
			addEventListener(name: string, listener: (event?: any) => void) {
				listeners.set(name, listener);
			}
			send() {}
			close() {}
		}
		globalThis.WebSocket = FakeWebSocket as any;

		try {
			const ws = fakeSocket({ type: "pty", sessionId: "task-1" });
			serveOptions.websocket.open(ws);
			listeners.get("close")?.({ code, reason });
			expect(ws.close).toHaveBeenCalledOnce();
			expect(ws.close).toHaveBeenCalledWith(code, reason);
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}
	});

	it("keeps non-protocol upstream closes generic", () => {
		const originalWebSocket = globalThis.WebSocket;
		const listeners = new Map<string, (event?: any) => void>();
		class FakeWebSocket {
			static OPEN = 1;
			readyState = 1;
			addEventListener(name: string, listener: (event?: any) => void) {
				listeners.set(name, listener);
			}
			send() {}
			close() {}
		}
		globalThis.WebSocket = FakeWebSocket as any;

		try {
			const ws = fakeSocket({ type: "pty", sessionId: "task-1" });
			serveOptions.websocket.open(ws);
			listeners.get("close")?.({ code: 1000, reason: "upstream complete" });
			expect(ws.close).toHaveBeenCalledWith();
		} finally {
			globalThis.WebSocket = originalWebSocket;
		}
	});
});
