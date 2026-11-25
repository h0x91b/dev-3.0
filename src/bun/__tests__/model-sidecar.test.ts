import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { ModelCatalog } from "../../shared/model-catalog";

const h = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	getDescendantPids: vi.fn<(pid: number) => Promise<number[]>>(),
	findPortHolders: vi.fn(),
	freePorts: null as Set<number> | null,
	fs: {
		existsSync: vi.fn((p: string) => p === "/opt/dev3/bifrost-http"),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn((_p: string): string => {
			throw new Error("ENOENT");
		}),
		writeFileSync: vi.fn(),
		chmodSync: vi.fn(),
		appendFileSync: vi.fn(),
		realpathSync: vi.fn((_path?: string) => "/apps/dev3.app/Contents/MacOS/bun"),
	},
	catalog: vi.fn<() => ModelCatalog>(),
	keys: vi.fn<() => Record<string, string>>(),
}));

vi.mock("../spawn", () => ({ spawn: h.spawnMock }));
vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	return {
		...actual,
		createServer: (...args: Parameters<typeof actual.createServer>) => {
			if (!h.freePorts) return actual.createServer(...args);
			let error!: () => void;
			let port = 0;
			const server = {
				unref() {},
				once(_event: string, callback: () => void) { error = callback; },
				listen(options: { port: number }, callback: () => void) {
					port = options.port || 47312;
					queueMicrotask(() => options.port === 0 || h.freePorts?.has(port) ? callback() : error());
				},
				address: () => ({ port }),
				close(callback?: () => void) { callback?.(); },
			};
			return server;
		},
	};
});
vi.mock("../port-scanner", () => ({
	getDescendantPids: h.getDescendantPids,
	findPortHolders: h.findPortHolders,
}));
vi.mock("node:fs", () => h.fs);
vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-model-catalog-test" }));
vi.mock("../model-catalog-store", () => ({
	loadModelCatalog: h.catalog,
	loadProviderKeys: h.keys,
	loadOrCreateEncryptionKey: () => "0".repeat(64),
}));

const CATALOG: ModelCatalog = {
	providers: [
		{ id: "p-or", kind: "openrouter", label: "OpenRouter" },
		{ id: "p-custom", kind: "custom", label: "My Box", baseUrl: "https://llm.example.com/v1" },
		{ id: "p-oai", kind: "openai", label: "OpenAI" },
	],
	models: [
		{ id: "m-fast", providerId: "p-or", name: "fast", modelId: "deepseek/flash" },
		{ id: "m-local", providerId: "p-custom", name: "local", modelId: "qwen3" },
	],
};

/** A spawned process that stays alive and prints `banner`. */
function liveProcess(pid = 5150, banner = "bifrost up") {
	return {
		pid,
		exited: new Promise<number>(() => {}),
		stdout: streamOf(banner),
		stderr: streamOf(""),
		kill: vi.fn(),
	};
}

/** A spawned process that dies immediately with the given output. */
function deadProcess(output: string) {
	return {
		pid: 5151,
		exited: Promise.resolve(1),
		stdout: streamOf(output),
		stderr: streamOf(""),
		kill: vi.fn(),
	};
}

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (text) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

/** Answer /health and /v1/models. `healthy` decides per call, so a test can
 *  make the port refuse connections until the attempt that should succeed. */
function stubHttp(models: string[] = [], healthy: () => boolean = () => true) {
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (String(url).endsWith("/health")) {
			if (!healthy()) throw new Error("connection refused");
			return { ok: true, status: 200 } as Response;
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: models.map((id) => ({ id })) }),
		} as unknown as Response;
	}));
}

let loaded: typeof import("../model-sidecar") | null = null;

async function freshModule() {
	loaded?.cancelScheduledRestart();
	vi.resetModules();
	loaded = await import("../model-sidecar");
	return loaded;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	process.env.DEV3_BIFROST_BINARY = "/opt/dev3/bifrost-http";
	h.getDescendantPids.mockResolvedValue([]);
	h.findPortHolders.mockResolvedValue([]);
	h.freePorts = null;
	h.fs.realpathSync.mockImplementation((path?: string) =>
		path?.includes("model-catalog-runtime") ? path : "/apps/dev3.app/Contents/MacOS/bun");
	h.catalog.mockReturnValue(CATALOG);
	h.keys.mockReturnValue({ "p-or": "sk-or-live", "p-custom": "sk-custom" });
	h.fs.existsSync.mockImplementation((p: string) => p === "/opt/dev3/bifrost-http");
	h.fs.readFileSync.mockImplementation(() => {
		throw new Error("ENOENT");
	});
	h.spawnMock.mockImplementation(() => liveProcess());
	stubHttp();
});

afterEach(() => {
	// A failed start queues a restart; it must not fire into the next test's mocks.
	loaded?.cancelScheduledRestart();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function remember(endpoint: unknown) {
	h.fs.readFileSync.mockImplementation((target: string) => {
		if (String(target).endsWith("endpoint.json")) return JSON.stringify(endpoint);
		throw new Error("ENOENT");
	});
}

describe("binary resolution", () => {
	it("prefers an explicit development override, reports it missing, and looks for the bundled copy inside the app, not on PATH", async () => {
		expect((await freshModule()).resolveSidecarBinary()).toBe("/opt/dev3/bifrost-http");
		process.env.DEV3_BIFROST_BINARY = "/nope/bifrost-http";
		const { resolveSidecarBinary, bundledSidecarCandidates } = await freshModule();
		expect(resolveSidecarBinary()).toBeUndefined();
		// The bundled copy is looked for inside the app, not on PATH.
		expect(bundledSidecarCandidates("/apps/dev3.app/Contents/MacOS")).toContain(
			"/apps/dev3.app/Contents/Resources/app/bifrost/bifrost-http",
		);
		expect(bundledSidecarCandidates(undefined)).toEqual([]);
	});
});

describe("credentials", () => {
	it("hands each provider's key to the child under its own variable, skipping keyless providers", async () => {
		const { buildSidecarEnv } = await freshModule();
		const env = buildSidecarEnv(CATALOG, { "p-or": "sk-or-live", "p-custom": "sk" }, { sessionKey: "sk-bf-1", encryptionKey: "abc" });
		expect(env.DEV3_LLM_KEY_OPENROUTER).toBe("sk-or-live");
		expect(env.DEV3_BIFROST_VIRTUAL_KEY).toBe("sk-bf-1");
		expect(env.DEV3_LLM_KEY_OPENAI).toBeUndefined();
		expect(env.DEV3_LLM_BASE_URL_CUSTOM_MY_BOX).toBe("https://llm.example.com/v1");

		// A keyless custom endpoint gets a stand-in key: without a value the sidecar
		// refuses every request against that provider locally ("no keys found that
		// support model"), and the connect flow offers Ollama with no key field at all.
		expect(buildSidecarEnv(CATALOG, {}, { sessionKey: "k", encryptionKey: "e" }).DEV3_LLM_KEY_CUSTOM_MY_BOX).toBeTruthy();
	});
});

describe("starting", () => {
	it("comes up on a loopback port and serves concurrent launches from one process instead of racing two", async () => {
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		const [runtime, other] = await Promise.all([ensureModelSidecar(), ensureModelSidecar()]);
		expect(runtime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(runtime.sessionKey).toMatch(/^sk-bf-/);
		expect(other.baseUrl).toBe(runtime.baseUrl);
		expect(h.spawnMock).toHaveBeenCalledTimes(1);
		expect(getModelSidecarStatus().running).toBe(true);
	});

	it("writes the config with the key only as a reference and never puts a credential on the command line", async () => {
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		const [, written] = h.fs.writeFileSync.mock.calls[0];
		expect(String(written)).toContain("env.DEV3_LLM_KEY_OPENROUTER");
		expect(String(written)).not.toContain("sk-or-live");
		expect(h.spawnMock.mock.calls[0][0].join(" ")).not.toContain("sk-");
	});

	it("tries another port when the first attempt dies on a taken one", async () => {
		h.spawnMock
			.mockImplementationOnce(() => deadProcess("listen tcp 127.0.0.1:41234: address already in use"))
			.mockImplementationOnce(() => liveProcess());
		// The taken port refuses connections; the second attempt's port answers.
		stubHttp([], () => h.spawnMock.mock.calls.length > 1);
		const { ensureModelSidecar } = await freshModule();
		await expect(ensureModelSidecar()).resolves.toBeTruthy();
		expect(h.spawnMock).toHaveBeenCalledTimes(2);
	});

	it("fails with the process's own last words, not a bare error code", async () => {
		h.spawnMock.mockImplementation(() => deadProcess("config error: provider openrouter has no key"));
		stubHttp([], () => false);
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await expect(ensureModelSidecar()).rejects.toThrow(/provider openrouter has no key/);
		expect(getModelSidecarStatus().lastError).toContain("provider openrouter has no key");
	});

	it("never publishes a proxy that died right after passing its health check", async () => {
		// It answers /health, then exits before it is handed out — a bad provider
		// config it only notices on the first real request looks exactly like this.
		h.spawnMock.mockImplementation(() => {
			let release: (code: number) => void = () => undefined;
			const exited = new Promise<number>((resolve) => (release = resolve));
			vi.stubGlobal("fetch", vi.fn(async (url: string) => {
				if (!String(url).endsWith("/health")) throw new Error("unexpected call");
				release(1);
				// Let the exit handler run before the health check returns.
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				return { ok: true, status: 200 } as Response;
			}));
			return { pid: 5152, exited, stdout: streamOf("upstream refused the key"), stderr: streamOf(""), kill: vi.fn() };
		});
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await expect(ensureModelSidecar()).rejects.toThrow(/exited right after starting/);
		const status = getModelSidecarStatus();
		expect(status.running).toBe(false);
		expect(status.lastError).toMatch(/exited right after starting/);
	});

	it("says plainly when this build ships no proxy binary", async () => {
		process.env.DEV3_BIFROST_BINARY = "/nope/bifrost-http";
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await expect(ensureModelSidecar()).rejects.toThrow(/missing from this build/);
		expect(getModelSidecarStatus().binaryAvailable).toBe(false);
		expect(getModelSidecarStatus().restart).toBeUndefined();
	});
});

describe("surviving a restart", () => {
	/** What the last start wrote to endpoint.json, or null. */
	function rememberedEndpoint(): { port: number; sessionKey: string; pid: number; ownerPid: number } | null {
		const call = h.fs.writeFileSync.mock.calls.find(([target]) => String(target).endsWith("endpoint.json"));
		return call ? JSON.parse(String(call[1])) : null;
	}

	it("remembers the port and the session key it launched on, and comes back with the same key", async () => {
		const { ensureModelSidecar } = await freshModule();
		const runtime = await ensureModelSidecar();
		const saved = rememberedEndpoint();
		expect(saved).toBeTruthy();
		expect(runtime.baseUrl).toBe(`http://127.0.0.1:${saved?.port}`);
		expect(saved?.sessionKey).toBe(runtime.sessionKey);
		expect(saved?.pid).toBe(5150);
		expect(saved?.ownerPid).toBe(process.pid);

		// A running agent has the base URL and token baked into its launch env, so a
		// proxy that comes back elsewhere strands every session it was serving.
		remember({ port: 47311, sessionKey: "sk-bf-rememberedkey" });
		expect((await (await freshModule()).ensureModelSidecar()).sessionKey).toBe("sk-bf-rememberedkey");
	});

	it("loads endpoints without ownership, dropping invalid ownership pids", async () => {
		const endpoint = { port: 47311, sessionKey: "sk-bf-rememberedkey" };
		for (const pid of [undefined, 0, -1, 1, 1.5, "123"]) {
			remember(pid === undefined ? endpoint : { ...endpoint, pid, ownerPid: pid });
			const { loadSidecarEndpoint } = await freshModule();
			expect(loadSidecarEndpoint(), `pid ${String(pid)}`).toEqual(endpoint);
		}
	});

	it("takes a real port when something else holds the fixed one", async () => {
		const squatter = createServer();
		const taken = await new Promise<number>((done) => {
			squatter.listen({ host: "127.0.0.1", port: 0 }, () => done((squatter.address() as AddressInfo).port));
		});
		try {
			remember({ port: taken, sessionKey: "sk-bf-rememberedkey" });
			const { ensureModelSidecar } = await freshModule();
			const runtime = await ensureModelSidecar();
			expect(runtime.baseUrl).not.toBe(`http://127.0.0.1:${taken}`);
			// Starting elsewhere beats not starting; the key still carries over.
			expect(runtime.sessionKey).toBe("sk-bf-rememberedkey");
		} finally {
			await new Promise((done) => squatter.close(done));
		}
	});

	it("ignores a corrupt endpoint file or a key that is not one of ours instead of failing to start", async () => {
		h.fs.readFileSync.mockImplementation(() => "{not json");
		const fromCorrupt = await (await freshModule()).ensureModelSidecar();
		expect(fromCorrupt.sessionKey).toMatch(/^sk-bf-/);
		remember({ port: 47311, sessionKey: "hijacked" });
		const fromHijacked = await (await freshModule()).ensureModelSidecar();
		expect(fromHijacked.sessionKey).toMatch(/^sk-bf-/);
	});
});

describe("choosing the port", () => {
	const REMEMBERED = { port: 47311, sessionKey: "sk-bf-rememberedkey" };
	/** Ports the probe should call free; everything else is treated as taken. */
	const freeOnly = (...ports: number[]) => async (port: number) => ports.includes(port);

	it("uses one fixed address below the ephemeral range, remembered or not", async () => {
		const { choosePort, DEFAULT_SIDECAR_PORT } = await freshModule();
		expect(await choosePort(1, REMEMBERED, freeOnly(DEFAULT_SIDECAR_PORT, REMEMBERED.port))).toBe(DEFAULT_SIDECAR_PORT);
		expect(await choosePort(1, null, freeOnly(DEFAULT_SIDECAR_PORT))).toBe(DEFAULT_SIDECAR_PORT);
		expect(DEFAULT_SIDECAR_PORT).toBeGreaterThan(1024);
		expect(DEFAULT_SIDECAR_PORT).toBeLessThan(32768);
	});

	// Second best: the address the agents already running were launched against.
	it("falls back to the last run's port, then any free port, and stops insisting after the early attempts", async () => {
		const { choosePort, DEFAULT_SIDECAR_PORT } = await freshModule();
		expect(await choosePort(1, REMEMBERED, freeOnly(REMEMBERED.port))).toBe(REMEMBERED.port);
		// Both taken: any free port rather than refusing to start.
		const any = await choosePort(1, REMEMBERED, freeOnly());
		expect(any).not.toBe(DEFAULT_SIDECAR_PORT);
		expect(any).not.toBe(REMEMBERED.port);
		expect(any).toBeGreaterThan(0);
		// A port that answered the health check but died right after is not a port to
		// keep retrying — later attempts stop insisting and just take a free one.
		const later = await choosePort(3, REMEMBERED, freeOnly(DEFAULT_SIDECAR_PORT, REMEMBERED.port));
		expect(later).not.toBe(DEFAULT_SIDECAR_PORT);
		expect(later).not.toBe(REMEMBERED.port);
	});
});

describe("reclaiming leaked proxies", () => {
	const PROXY = 7001;
	const OWNER = 7002;
	const OTHER_PROXY = 7003;
	const DEFAULT_PORT = 32123;
	const REMEMBERED_PORT = 47311;
	const RUNTIME = "/tmp/dev3-model-catalog-test/model-catalog-runtime";
	let alive: Set<number>;
	let table: string;
	let files: string;
	let holders: Map<number, number>;
	let kill: MockInstance<typeof process.kill>;

	beforeEach(() => {
		alive = new Set([PROXY]);
		table = `${PROXY} 1 /Applications/dev 3.app/bifrost-http\n`;
		files = `p${PROXY}\nn${RUNTIME}/config.db\nn${RUNTIME}/logs.db\n`;
		holders = new Map([[DEFAULT_PORT, PROXY]]);
		h.freePorts = new Set([REMEMBERED_PORT]);
		remember({ port: DEFAULT_PORT, sessionKey: "sk-bf-stable", pid: PROXY, ownerPid: OWNER });
		h.findPortHolders.mockImplementation(async (ports: number[]) =>
			ports.filter((port) => holders.has(port)).map((port) => ({ port, pid: holders.get(port), processName: "bifrost" })));
		h.spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd[0] === "ps" || cmd[0] === "lsof") {
				return { stdout: streamOf(cmd[0] === "ps" ? table : files), exited: Promise.resolve(0) };
			}
			return liveProcess();
		});
		kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
			if (signal === "SIGTERM" || signal === "SIGKILL") {
				alive.delete(pid);
				for (const [port, holder] of holders) {
					if (holder === pid) {
						h.freePorts?.add(port);
						holders.delete(port);
					}
				}
			}
			return true;
		});
	});

	const signals = () => kill.mock.calls.filter(([, signal]) => signal !== 0);

	it("terminates the recorded orphan before launching on the same default port and key", async () => {
		const { ensureModelSidecar } = await freshModule();
		expect(await ensureModelSidecar()).toEqual({ baseUrl: `http://127.0.0.1:${DEFAULT_PORT}`, sessionKey: "sk-bf-stable" });
		expect(signals()).toEqual([[PROXY, "SIGTERM"]]);
		expect(h.findPortHolders).not.toHaveBeenCalled();
		const launchIndex = h.spawnMock.mock.calls.findIndex(([cmd]) => cmd[0] === "/opt/dev3/bifrost-http");
		const signalIndex = kill.mock.calls.findIndex(([, signal]) => signal === "SIGTERM");
		expect(kill.mock.invocationCallOrder[signalIndex]).toBeLessThan(h.spawnMock.mock.invocationCallOrder[launchIndex]);
	});

	it("never reclaims a proxy owned by another live instance", async () => {
		alive.add(OWNER);
		const { ensureModelSidecar } = await freshModule();
		expect((await ensureModelSidecar()).baseUrl).not.toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
		expect(signals()).toEqual([]);
	});

	it("does not mistake denied owner inspection for a dead owner", async () => {
		const original = kill.getMockImplementation()!;
		kill.mockImplementation((pid, signal) => {
			if (pid === OWNER) throw Object.assign(new Error("denied"), { code: "EPERM" });
			return original(pid, signal);
		});
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		expect(signals()).toEqual([]);
	});

	it("protects a live parent even when the recorded owner is dead", async () => {
		alive.add(8001);
		table = `${PROXY} 8001 /Applications/dev3.app/bifrost-http\n`;
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		expect(signals()).toEqual([]);
	});

	it("reclaims a legacy orphan with no ownership fields", async () => {
		remember({ port: DEFAULT_PORT, sessionKey: "sk-bf-stable" });
		const { ensureModelSidecar } = await freshModule();
		expect((await ensureModelSidecar()).baseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
		expect(signals()).toEqual([[PROXY, "SIGTERM"]]);
		expect(h.spawnMock).toHaveBeenCalledWith(["ps", "-eo", "pid=,ppid=,comm="], expect.anything());
		expect(h.spawnMock).toHaveBeenCalledWith(["lsof", "-a", "-p", String(PROXY), "-Fn"], expect.anything());
	});

	it("never signals a recorded pid that has already exited", async () => {
		alive.delete(PROXY);
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		expect(signals()).toEqual([]);
	});

	it("leaves a reused pid or unrelated listener alone", async () => {
		table = `${PROXY} 1 /usr/bin/other-server\n`;
		const { ensureModelSidecar } = await freshModule();
		expect((await ensureModelSidecar()).baseUrl).not.toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
		expect(signals()).toEqual([]);
	});

	it("requires both database files from our exact runtime directory", async () => {
		for (const output of [`n${RUNTIME}/config.db\n`, "n/tmp/another-runtime/config.db\nn/tmp/another-runtime/logs.db\n"]) {
			files = output;
			await (await freshModule()).ensureModelSidecar();
			expect(signals(), output).toEqual([]);
		}
	});

	it("compares open files against the real runtime path, including symlinks", async () => {
		h.fs.realpathSync.mockReturnValue("/private/runtime");
		files = "n/private/runtime/config.db\nn/private/runtime/logs.db\n";
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		expect(signals()).toEqual([[PROXY, "SIGTERM"]]);
	});

	it("fails closed when ps or lsof is unavailable", async () => {
		const original = h.spawnMock.getMockImplementation()!;
		for (const tool of ["ps", "lsof"]) {
			h.spawnMock.mockImplementation((cmd, ...args) => {
				if (cmd[0] === tool) throw new Error("ENOENT");
				return original(cmd, ...args);
			});
			await (await freshModule()).ensureModelSidecar();
			expect(signals(), tool).toEqual([]);
		}
	});

	it("fails closed on Windows instead of trusting a reused pid", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		expect(signals()).toEqual([]);
		expect(h.spawnMock.mock.calls.every(([cmd]) => cmd[0] === "/opt/dev3/bifrost-http")).toBe(true);
	});

	it("does not kill a recorded orphan on another port when the default is free", async () => {
		h.freePorts?.add(DEFAULT_PORT);
		holders = new Map([[REMEMBERED_PORT, PROXY]]);
		remember({ port: REMEMBERED_PORT, sessionKey: "sk-bf-stable", pid: PROXY, ownerPid: OWNER });
		const { ensureModelSidecar } = await freshModule();
		expect((await ensureModelSidecar()).baseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
		expect(signals()).toEqual([]);
	});

	it("reclaims only the default orphan and leaves the other orphan serving its sessions", async () => {
		alive.add(OTHER_PROXY);
		holders.set(REMEMBERED_PORT, OTHER_PROXY);
		h.freePorts?.delete(REMEMBERED_PORT);
		remember({ port: REMEMBERED_PORT, sessionKey: "sk-bf-stable", pid: OTHER_PROXY, ownerPid: OWNER });
		const { ensureModelSidecar } = await freshModule();
		expect((await ensureModelSidecar()).baseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
		expect(signals()).toEqual([[PROXY, "SIGTERM"]]);
		expect(alive.has(OTHER_PROXY)).toBe(true);
	});

	it("reclaims the remembered port when an unrelated process holds the default", async () => {
		alive.add(OTHER_PROXY);
		holders = new Map([[DEFAULT_PORT, OTHER_PROXY], [REMEMBERED_PORT, PROXY]]);
		h.freePorts?.delete(REMEMBERED_PORT);
		table += `${OTHER_PROXY} 1 /usr/bin/other-server\n`;
		remember({ port: REMEMBERED_PORT, sessionKey: "sk-bf-stable", pid: PROXY, ownerPid: OWNER });
		const { ensureModelSidecar } = await freshModule();
		expect((await ensureModelSidecar()).baseUrl).toBe(`http://127.0.0.1:${REMEMBERED_PORT}`);
		expect(signals()).toEqual([[PROXY, "SIGTERM"]]);
	});
});

describe("autostart", () => {
	it("brings the proxy up with the app, so the catalog needs no operating", async () => {
		const { autostartModelSidecar, getModelSidecarStatus } = await freshModule();
		await autostartModelSidecar();
		expect(getModelSidecarStatus().running).toBe(true);
		expect(h.spawnMock).toHaveBeenCalledTimes(1);

		// A provider without a key is still worth starting for: the user is mid-setup,
		// and the proxy is what they need up to load the provider's model ids.
		h.keys.mockReturnValue({});
		const keyless = await freshModule();
		await keyless.autostartModelSidecar();
		expect(keyless.getModelSidecarStatus().running).toBe(true);
	});

	it("stays out of the way when there is no provider to serve or no proxy binary", async () => {
		h.catalog.mockReturnValue({ providers: [], models: [] });
		const first = await freshModule();
		await first.autostartModelSidecar();
		expect(first.getModelSidecarStatus().running).toBe(false);
		h.catalog.mockReturnValue(CATALOG);
		h.fs.existsSync.mockReturnValue(false);
		delete process.env.DEV3_BIFROST_BINARY;
		await (await freshModule()).autostartModelSidecar();
		expect(h.spawnMock).not.toHaveBeenCalled();
	});

	it("never throws when the proxy refuses to come up — the app still boots", async () => {
		h.spawnMock.mockImplementation(() => deadProcess("bind: address already in use"));
		stubHttp([], () => false);
		const { autostartModelSidecar, getModelSidecarStatus } = await freshModule();
		await expect(autostartModelSidecar()).resolves.toBeUndefined();
		expect(getModelSidecarStatus().running).toBe(false);
		expect(getModelSidecarStatus().lastError).toContain("address already in use");
	});
});

describe("restarting after a failed start", () => {
	/** Every launch dies until `upAfter` spawns have happened; the next one serves. */
	function failUntil(upAfter: number) {
		h.spawnMock.mockImplementation(() =>
			h.spawnMock.mock.calls.length > upAfter ? liveProcess() : deadProcess("failed to download pricing data: HTTP 503"),
		);
		stubHttp([], () => h.spawnMock.mock.calls.length > upAfter);
	}

	/** Fake time in small steps, letting real I/O (port probes) through between them. */
	async function advanceUntil(done: () => boolean, maxMs = 300_000): Promise<void> {
		for (let elapsed = 0; elapsed < maxMs && !done(); elapsed += 50) {
			await vi.advanceTimersByTimeAsync(50);
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(done()).toBe(true);
	}

	async function failedStart(start: Promise<unknown>): Promise<void> {
		let settled = false;
		const outcome = start.then(
			() => "resolved",
			() => "rejected",
		).finally(() => (settled = true));
		await advanceUntil(() => settled, 4_000);
		expect(await outcome).toBe("rejected");
	}

	beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));

	it("backs off from 5s, doubling, and never waits longer than two minutes", async () => {
		const { restartBackoffMs } = await freshModule();
		expect([1, 2, 3, 4, 5, 6, 7, 30].map(restartBackoffMs)).toEqual([
			5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000,
		]);
	});

	it("comes up on its own once the outage ends, and says when it will try next meanwhile", async () => {
		failUntil(8); // two whole starts of four attempts each fail
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await failedStart(ensureModelSidecar());
		const first = getModelSidecarStatus();
		expect(first.restart?.attempt).toBe(1);
		expect(first.restart?.inMs).toBeGreaterThan(4_000);
		expect(first.lastError).toMatch(/HTTP 503/);

		await advanceUntil(() => getModelSidecarStatus().restart?.attempt === 2);
		expect(h.spawnMock).toHaveBeenCalledTimes(8);
		expect(getModelSidecarStatus().restart?.inMs).toBeGreaterThan(9_000);

		await advanceUntil(() => getModelSidecarStatus().running);
		const status = getModelSidecarStatus();
		expect(status.restart).toBeUndefined();
		expect(status.lastError).toBeUndefined();
	});

	it("drops the queued restart when the user stops the proxy, and never restarts after the app starts quitting", async () => {
		failUntil(Number.POSITIVE_INFINITY);
		for (const how of ["stop", "quit"] as const) {
			const { ensureModelSidecar, stopModelSidecar, killModelSidecarNow, getModelSidecarStatus } = await freshModule();
			await failedStart(ensureModelSidecar());
			const spawned = h.spawnMock.mock.calls.length;
			if (how === "stop") await stopModelSidecar();
			else killModelSidecarNow();
			expect(getModelSidecarStatus().restart, how).toBeUndefined();
			await vi.advanceTimersByTimeAsync(600_000);
			expect(h.spawnMock, how).toHaveBeenCalledTimes(spawned);
		}
	});

	it("stays a stoppable retry while an automatic attempt runs, and a stop cuts that attempt short", async () => {
		failUntil(Number.POSITIVE_INFINITY);
		const { ensureModelSidecar, stopModelSidecar, getModelSidecarStatus } = await freshModule();
		await failedStart(ensureModelSidecar());
		// The retry hangs the way bifrost does while it retries its datasheet fetch.
		let exit!: (code: number) => void;
		const hanging = {
			pid: 5152,
			exited: new Promise<number>((resolve) => (exit = resolve)),
			stdout: streamOf(""),
			stderr: streamOf(""),
			kill: vi.fn(() => exit(143)),
		};
		h.spawnMock.mockImplementation(() => hanging);
		await advanceUntil(() => getModelSidecarStatus().starting, 10_000);
		expect(getModelSidecarStatus().restart).toEqual({ attempt: 1 });

		const spawned = h.spawnMock.mock.calls.length;
		let stopped = false;
		void stopModelSidecar().then(() => (stopped = true));
		await advanceUntil(() => stopped, 2_000); // not the 4 × 45s the attempt would take
		expect(hanging.kill).toHaveBeenCalled();
		expect(getModelSidecarStatus()).toMatchObject({ starting: false, running: false, lastError: undefined });
		expect(getModelSidecarStatus().restart).toBeUndefined();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(h.spawnMock).toHaveBeenCalledTimes(spawned);
	});

	it("drops the queued restart once the catalog has no provider left, and queues none without one", async () => {
		failUntil(Number.POSITIVE_INFINITY);
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await failedStart(ensureModelSidecar());
		const spawned = h.spawnMock.mock.calls.length;
		h.catalog.mockReturnValue({ providers: [], models: [] });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(h.spawnMock).toHaveBeenCalledTimes(spawned);
		expect(getModelSidecarStatus().restart).toBeUndefined();

		// With no provider from the start, no restart is queued at all.
		const empty = await freshModule();
		await failedStart(empty.ensureModelSidecar());
		expect(empty.getModelSidecarStatus().restart).toBeUndefined();
	});
});

describe("stopping", () => {
	it("signals the running proxy before the synchronous quit call returns, and nothing when none exists", async () => {
		const { ensureModelSidecar, killModelSidecarNow } = await freshModule();
		await ensureModelSidecar();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		killModelSidecarNow();
		expect(kill).toHaveBeenCalledExactlyOnceWith(5150, "SIGTERM");
		expect(h.getDescendantPids).not.toHaveBeenCalled();

		// With no proxy at all, neither quit nor stop signals anything.
		kill.mockClear();
		const empty = await freshModule();
		expect(empty.killModelSidecarNow).not.toThrow();
		await expect(empty.stopModelSidecar()).resolves.toBeUndefined();
		expect(kill).not.toHaveBeenCalled();
	});

	it("signals a spawned proxy before its health check resolves and never retries", async () => {
		const { ensureModelSidecar, killModelSidecarNow } = await freshModule();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		let release!: (response: Response) => void;
		let entered!: () => void;
		const checking = new Promise<void>((resolve) => { entered = resolve; });
		vi.stubGlobal("fetch", vi.fn(() => {
			entered();
			return new Promise<Response>((resolve) => { release = resolve; });
		}));
		const start = ensureModelSidecar();
		const rejected = expect(start).rejects.toThrow(/shutting down/);
		await checking;
		killModelSidecarNow();
		expect(kill).toHaveBeenCalledExactlyOnceWith(5150, "SIGTERM");
		release({ ok: true } as Response);
		await rejected;
		expect(h.spawnMock).toHaveBeenCalledTimes(1);
	});

	it("does not spawn after quitting before the port probe resolves", async () => {
		const { ensureModelSidecar, killModelSidecarNow } = await freshModule();
		const start = ensureModelSidecar();
		const rejected = expect(start).rejects.toThrow(/shutting down/);
		killModelSidecarNow();
		await rejected;
		expect(h.spawnMock).not.toHaveBeenCalled();
	});

	it("signals the proxy even while an RPC stop is waiting for its descendant scan", async () => {
		const { ensureModelSidecar, stopModelSidecar, killModelSidecarNow } = await freshModule();
		await ensureModelSidecar();
		let release!: (pids: number[]) => void;
		h.getDescendantPids.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const stop = stopModelSidecar();
		killModelSidecarNow();
		expect(kill).toHaveBeenCalledExactlyOnceWith(5150, "SIGTERM");
		release([]);
		await stop;
	});

	it("never throws when signalling fails with ESRCH or EPERM", async () => {
		for (const code of ["ESRCH", "EPERM"]) {
			const { ensureModelSidecar, killModelSidecarNow } = await freshModule();
			await ensureModelSidecar();
			const spy = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
			expect(killModelSidecarNow, code).not.toThrow();
			spy.mockRestore();
		}
	});

	it("terminates the process tree, not only the parent", async () => {
		h.getDescendantPids.mockResolvedValue([6001]);
		const killed: number[] = [];
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
			killed.push(pid);
			return true;
		}) as typeof process.kill);

		const { ensureModelSidecar, stopModelSidecar, getModelSidecarStatus } = await freshModule();
		await ensureModelSidecar();
		await stopModelSidecar();

		expect(killed).toEqual([6001, 5150]);
		expect(getModelSidecarStatus().running).toBe(false);
		killSpy.mockRestore();
	});

	// Quitting seconds after a launch triggered a start used to kill nothing: the
	// instance is only published when the start resolves, so the finished process
	// outlived the app holding the loopback port and the provider keys.
	it("cuts a start in flight short, so it cannot leave an orphan", async () => {
		const killed: number[] = [];
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
			killed.push(pid);
			return true;
		}) as typeof process.kill);
		h.getDescendantPids.mockResolvedValue([]);

		const { ensureModelSidecar, stopModelSidecar, getModelSidecarStatus } = await freshModule();
		const start = ensureModelSidecar().catch((err: unknown) => err);
		await stopModelSidecar();

		expect(String(await start)).toMatch(/start was stopped/);
		for (const { value } of h.spawnMock.mock.results) expect(value.kill).toHaveBeenCalled();
		expect(killed).toEqual([]);
		expect(getModelSidecarStatus()).toMatchObject({ running: false, starting: false });
		killSpy.mockRestore();
	});

	// A proxy that dies after it came up used to stay "running" forever: every
	// later launch was handed a dead port, and the panel offered Stop instead of
	// Start. A stop the user asked for then dismisses the failure; the exit message
	// used to sit in the panel afterwards, reading as a fresh failure of a proxy that is off.
	it("stops calling itself running once the process dies, and clears the error on a deliberate stop", async () => {
		let die: (code: number) => void = () => {};
		h.spawnMock.mockImplementation(() => ({
			pid: 5150,
			exited: new Promise<number>((resolveExit) => {
				die = resolveExit;
			}),
			stdout: streamOf("bifrost up"),
			stderr: streamOf(""),
			kill: vi.fn(),
		}));

		const { ensureModelSidecar, stopModelSidecar, getModelSidecarStatus } = await freshModule();
		await ensureModelSidecar();
		expect(getModelSidecarStatus().running).toBe(true);
		die(9);
		await new Promise((r) => setTimeout(r, 0));
		expect(getModelSidecarStatus().running).toBe(false);
		expect(getModelSidecarStatus().lastError).toContain("exited on its own");

		await stopModelSidecar();
		expect(getModelSidecarStatus().lastError).toBeUndefined();
	});

	// SIGTERM returns long before a Go server has finished shutting down, and a
	// restart picks its port immediately after. Without the wait the fixed address
	// still looks taken, the new process lands on a random one, and every agent
	// already launched against the old URL is stranded.
	it("waits for the port to come back, so a restart can reclaim the same address", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		const { ensureModelSidecar, stopModelSidecar, getModelSidecarStatus } = await freshModule();
		await ensureModelSidecar();
		const port = getModelSidecarStatus().port as number;

		// Stand in for the dying process: something real still holds the port.
		const holder = createServer();
		await new Promise<void>((done) => holder.listen({ host: "127.0.0.1", port }, done));

		let released = false;
		setTimeout(() => holder.close(() => (released = true)), 150);
		await stopModelSidecar();

		expect(released).toBe(true);
		killSpy.mockRestore();
	});
});

describe("preflight", () => {
	const bindings = { opus: "m-fast", sonnet: "m-local" };

	it("passes when every bound model is served, the preset binds no roles, or the proxy lists nothing", async () => {
		stubHttp(["openrouter/fast", "custom-my-box/local"]);
		const { preflightModelRoles } = await freshModule();
		expect(await preflightModelRoles("claude", bindings, CATALOG)).toEqual({ ok: true, problems: [] });
		expect(await preflightModelRoles("claude", {}, CATALOG)).toEqual({ ok: true, problems: [] });
		// A proxy that lists nothing does not fail a launch either.
		stubHttp([]);
		expect((await preflightModelRoles("claude", bindings, CATALOG)).ok).toBe(true);
	});

	it("names the role whose catalog model was deleted, or whose model the proxy will not serve", async () => {
		const { preflightModelRoles } = await freshModule();
		const result = await preflightModelRoles("claude", { opus: "m-gone" }, CATALOG);
		expect(result).toEqual({ ok: false, problems: [{ roleId: "opus", code: "missing-model" }] });

		stubHttp(["openrouter/fast"]);
		const unserved = await preflightModelRoles("claude", bindings, CATALOG);
		expect(unserved.ok).toBe(false);
		expect(unserved.problems).toEqual([
			expect.objectContaining({ roleId: "sonnet", code: "model-unreachable", detail: "custom-my-box/local" }),
		]);
	});

	it("reports the proxy itself when it cannot be reached", async () => {
		h.spawnMock.mockImplementation(() => deadProcess("boom"));
		stubHttp([], () => false);
		const { preflightModelRoles } = await freshModule();
		const result = await preflightModelRoles("claude", bindings, CATALOG);
		expect(result.problems[0].code).toBe("proxy-unreachable");
	});

	it("keeps the encryption key stable, so a restart does not die on decrypt", async () => {
		const { ensureModelSidecar, stopModelSidecar } = await freshModule();
		await ensureModelSidecar();
		const first = h.spawnMock.mock.calls[0][1].env.DEV3_BIFROST_ENCRYPTION_KEY;
		await stopModelSidecar();
		await ensureModelSidecar();
		expect(h.spawnMock.mock.calls[1][1].env.DEV3_BIFROST_ENCRYPTION_KEY).toBe(first);
	});

	// dev3's own generated config denies `list_models` to a custom endpoint
	// speaking the Anthropic protocol, so its models are absent from every
	// listing by construction. Another provider that DOES list makes the listing
	// non-empty — which used to turn that absence into a blocked launch.
	it("does not block a provider it told the proxy not to list", async () => {
		const mixed: ModelCatalog = {
			providers: [
				{ id: "p-or", kind: "openrouter", label: "OpenRouter" },
				{ id: "p-anthropic-box", kind: "custom", label: "My Box", baseUrl: "https://llm.example.com", apiFormat: "anthropic" },
			],
			models: [
				{ id: "m-fast", providerId: "p-or", name: "fast", modelId: "deepseek/flash" },
				{ id: "m-box", providerId: "p-anthropic-box", name: "boxed", modelId: "claude-ish" },
			],
		};
		stubHttp(["openrouter/fast"]);
		const { preflightModelRoles } = await freshModule();
		const result = await preflightModelRoles("claude", { opus: "m-fast", sonnet: "m-box" }, mixed);
		expect(result).toEqual({ ok: true, problems: [] });
	});
});
