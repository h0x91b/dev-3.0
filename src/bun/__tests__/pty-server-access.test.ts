/**
 * The PTY server hands out a shell. These pin who may reach it: this machine
 * only, holding the token minted for this launch.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { PTY_TOKEN_PARAM, redactPtyUrl } from "../../shared/pty-url";
import { hasPtyAccessToken, isLoopbackAddress, ptyHttpUrl, ptyWsUrl } from "../pty-server-access";

interface ServeConfig {
	hostname?: string;
	fetch(req: Request, server: unknown): Response | undefined;
}
let served!: ServeConfig;
const bun = globalThis as unknown as { Bun: { serve: (config: unknown) => unknown } };
const stubServe = bun.Bun.serve;
bun.Bun.serve = (config: unknown) => {
	served = config as ServeConfig;
	return stubServe(config);
};

await import("../pty-server");

const PORT = 9999;

function fakeServer(peer: string | null = "127.0.0.1") {
	return {
		requestIP: () => (peer === null ? null : { address: peer }),
		upgrade: vi.fn(() => true),
	};
}

/** The terminal URL the app would hand out, as an HTTP request the server sees. */
function upgradeRequest(mutate: (url: URL) => void = () => {}): Request {
	const url = new URL(ptyWsUrl(PORT, "task-1").replace(/^ws:/, "http:"));
	mutate(url);
	return new Request(url);
}

describe("ptyWsUrl", () => {
	it("names the loopback literal and carries the session and a token", () => {
		const url = new URL(ptyWsUrl(PORT, "task-1"));
		expect(url.protocol).toBe("ws:");
		expect(url.host).toBe(`127.0.0.1:${PORT}`);
		expect(url.searchParams.get("session")).toBe("task-1");
		expect(url.searchParams.get(PTY_TOKEN_PARAM)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("keeps a pane session key readable, as the viewer and the logs expect it", () => {
		expect(ptyWsUrl(PORT, "task-1~pane-2")).toContain("?session=task-1~pane-2&");
	});

	it("does not let a session key smuggle its own token in", () => {
		const url = new URL(ptyWsUrl(PORT, "task-1&token=forged"));
		expect(url.searchParams.get("session")).toBe("task-1&token=forged");
		expect(url.searchParams.getAll(PTY_TOKEN_PARAM)).toHaveLength(1);
		expect(hasPtyAccessToken(url)).toBe(true);
	});
});

describe("hasPtyAccessToken", () => {
	const withToken = (token: string | null) => {
		const url = new URL(ptyWsUrl(PORT, "task-1"));
		if (token === null) url.searchParams.delete(PTY_TOKEN_PARAM);
		else url.searchParams.set(PTY_TOKEN_PARAM, token);
		return url;
	};
	const real = new URL(ptyWsUrl(PORT, "task-1")).searchParams.get(PTY_TOKEN_PARAM)!;

	it("accepts the token this launch minted", () => {
		expect(hasPtyAccessToken(withToken(real))).toBe(true);
	});

	it.each([
		["no token at all", null],
		["an empty token", ""],
		["a token of the right length but wrong value", "x".repeat(real.length)],
		["a prefix of the real token", real.slice(0, -1)],
		["the real token with a suffix", `${real}x`],
	])("refuses %s", (_label, token) => {
		expect(hasPtyAccessToken(withToken(token))).toBe(false);
	});
});

describe("isLoopbackAddress", () => {
	it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("accepts %s", (address) => {
		expect(isLoopbackAddress(address)).toBe(true);
	});

	it.each(["192.168.0.217", "10.0.0.5", "::ffff:192.168.0.217", "0.0.0.0", "", undefined])("refuses %s", (address) => {
		expect(isLoopbackAddress(address)).toBe(false);
	});
});

describe("ptyHttpUrl", () => {
	it("points a plain route at the same loopback literal", () => {
		expect(ptyHttpUrl(PORT, "/pane-exited?session=dev3-abc")).toBe(`http://127.0.0.1:${PORT}/pane-exited?session=dev3-abc`);
	});
});

describe("redactPtyUrl", () => {
	it("masks the token and nothing else", () => {
		expect(redactPtyUrl("ws://127.0.0.1:9999?session=task-1&token=s3cret&since=7")).toBe(
			"ws://127.0.0.1:9999?session=task-1&token=***&since=7",
		);
	});

	it("leaves a URL without a token untouched", () => {
		expect(redactPtyUrl("wss://host/pty?session=task-1")).toBe("wss://host/pty?session=task-1");
	});
});

describe("the PTY server", () => {
	it("listens on loopback only, never on every interface", () => {
		expect(served.hostname).toBe("127.0.0.1");
	});

	it("upgrades a terminal request that carries the token", () => {
		const server = fakeServer();
		const response = served.fetch(upgradeRequest(), server);
		expect(server.upgrade).toHaveBeenCalledTimes(1);
		expect(response).toBeUndefined();
	});

	it.each([
		["no token", (url: URL) => url.searchParams.delete(PTY_TOKEN_PARAM)],
		["a wrong token", (url: URL) => url.searchParams.set(PTY_TOKEN_PARAM, "x".repeat(43))],
	])("refuses a terminal request with %s, even from this machine and with a real session id", (_label, mutate) => {
		const server = fakeServer();
		const response = served.fetch(upgradeRequest(mutate), server);
		expect(response?.status).toBe(401);
		expect(server.upgrade).not.toHaveBeenCalled();
	});

	it.each([
		["a LAN peer", "192.168.0.217"],
		["an unknown peer", null],
	])("refuses %s outright, token or not", (_label, peer) => {
		const server = fakeServer(peer);
		const response = served.fetch(upgradeRequest(), server);
		expect(response?.status).toBe(403);
		expect(server.upgrade).not.toHaveBeenCalled();
	});

	it("still takes the tmux pane-exited hook, which holds no token", async () => {
		const response = served.fetch(new Request(ptyHttpUrl(PORT, "/pane-exited?session=dev3-abc&pane=%251")), fakeServer());
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("ok");
	});

	it("refuses the pane-exited hook from off this machine", () => {
		const response = served.fetch(new Request(ptyHttpUrl(PORT, "/pane-exited?session=dev3-abc&pane=%251")), fakeServer("192.168.0.217"));
		expect(response?.status).toBe(403);
	});
});
