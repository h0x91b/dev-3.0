import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { ModelCatalog } from "../../shared/model-catalog";

const h = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	getDescendantPids: vi.fn<(pid: number) => Promise<number[]>>(),
	fs: {
		existsSync: vi.fn((p: string) => p === "/opt/dev3/bifrost-http"),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn((_p: string): string => {
			throw new Error("ENOENT");
		}),
		writeFileSync: vi.fn(),
		chmodSync: vi.fn(),
		realpathSync: vi.fn(() => "/apps/dev3.app/Contents/MacOS/bun"),
	},
	catalog: vi.fn<() => ModelCatalog>(),
	keys: vi.fn<() => Record<string, string>>(),
}));

vi.mock("../spawn", () => ({ spawn: h.spawnMock }));
vi.mock("../port-scanner", () => ({ getDescendantPids: h.getDescendantPids }));
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

async function freshModule() {
	vi.resetModules();
	return import("../model-sidecar");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	process.env.DEV3_BIFROST_BINARY = "/opt/dev3/bifrost-http";
	h.getDescendantPids.mockResolvedValue([]);
	h.catalog.mockReturnValue(CATALOG);
	h.keys.mockReturnValue({ "p-or": "sk-or-live", "p-custom": "sk-custom" });
	h.fs.existsSync.mockImplementation((p: string) => p === "/opt/dev3/bifrost-http");
	h.fs.readFileSync.mockImplementation(() => {
		throw new Error("ENOENT");
	});
	h.spawnMock.mockImplementation(() => liveProcess());
	stubHttp();
});

describe("binary resolution", () => {
	it("prefers an explicit development override", async () => {
		const { resolveSidecarBinary } = await freshModule();
		expect(resolveSidecarBinary()).toBe("/opt/dev3/bifrost-http");
	});

	it("reports the binary as missing when the override does not exist", async () => {
		process.env.DEV3_BIFROST_BINARY = "/nope/bifrost-http";
		const { resolveSidecarBinary } = await freshModule();
		expect(resolveSidecarBinary()).toBeUndefined();
	});

	it("looks for the bundled copy inside the app, not on PATH", async () => {
		const { bundledSidecarCandidates } = await freshModule();
		expect(bundledSidecarCandidates("/apps/dev3.app/Contents/MacOS")).toContain(
			"/apps/dev3.app/Contents/Resources/app/bifrost/bifrost-http",
		);
	});

	it("has no candidates when the executable's directory is unknown", async () => {
		const { bundledSidecarCandidates } = await freshModule();
		expect(bundledSidecarCandidates(undefined)).toEqual([]);
	});
});

describe("credentials", () => {
	it("hands each provider's key to the child process under its own variable", async () => {
		const { buildSidecarEnv } = await freshModule();
		const env = buildSidecarEnv(CATALOG, { "p-or": "sk-or-live" }, { sessionKey: "sk-bf-1", encryptionKey: "abc" });
		expect(env.DEV3_LLM_KEY_OPENROUTER).toBe("sk-or-live");
		expect(env.DEV3_BIFROST_VIRTUAL_KEY).toBe("sk-bf-1");
	});

	it("skips a provider the user has not given a key yet", async () => {
		const { buildSidecarEnv } = await freshModule();
		const env = buildSidecarEnv(CATALOG, { "p-or": "sk-or-live" }, { sessionKey: "k", encryptionKey: "e" });
		expect(env.DEV3_LLM_KEY_OPENAI).toBeUndefined();
	});

	it("gives a keyless custom endpoint a stand-in key, so the proxy will serve it", async () => {
		// Without a value the sidecar refuses every request against that provider
		// locally ("no keys found that support model"), and the connect flow offers
		// Ollama with no key field at all.
		const { buildSidecarEnv } = await freshModule();
		const env = buildSidecarEnv(CATALOG, {}, { sessionKey: "k", encryptionKey: "e" });
		expect(env.DEV3_LLM_KEY_CUSTOM_MY_BOX).toBeTruthy();
	});

	it("passes a custom endpoint's base URL through the environment too", async () => {
		const { buildSidecarEnv } = await freshModule();
		const env = buildSidecarEnv(CATALOG, { "p-custom": "sk" }, { sessionKey: "k", encryptionKey: "e" });
		expect(env.DEV3_LLM_BASE_URL_CUSTOM_MY_BOX).toBe("https://llm.example.com/v1");
	});
});

describe("starting", () => {
	it("comes up on a loopback port and reports it", async () => {
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		const runtime = await ensureModelSidecar();
		expect(runtime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(runtime.sessionKey).toMatch(/^sk-bf-/);
		expect(getModelSidecarStatus().running).toBe(true);
	});

	it("writes the generated config before launching, with the key only as a reference", async () => {
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		const [, written] = h.fs.writeFileSync.mock.calls[0];
		expect(String(written)).toContain("env.DEV3_LLM_KEY_OPENROUTER");
		expect(String(written)).not.toContain("sk-or-live");
	});

	it("never puts a credential on the command line", async () => {
		const { ensureModelSidecar } = await freshModule();
		await ensureModelSidecar();
		expect(h.spawnMock.mock.calls[0][0].join(" ")).not.toContain("sk-");
	});

	it("serves concurrent launches from one process instead of racing two", async () => {
		const { ensureModelSidecar } = await freshModule();
		const [a, b] = await Promise.all([ensureModelSidecar(), ensureModelSidecar()]);
		expect(a.baseUrl).toBe(b.baseUrl);
		expect(h.spawnMock).toHaveBeenCalledTimes(1);
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

	it("says plainly when this build ships no proxy binary", async () => {
		process.env.DEV3_BIFROST_BINARY = "/nope/bifrost-http";
		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await expect(ensureModelSidecar()).rejects.toThrow(/missing from this build/);
		expect(getModelSidecarStatus().binaryAvailable).toBe(false);
	});
});

describe("surviving a restart", () => {
	/** What the last start wrote to endpoint.json, or null. */
	function rememberedEndpoint(): { port: number; sessionKey: string } | null {
		const call = h.fs.writeFileSync.mock.calls.find(([target]) => String(target).endsWith("endpoint.json"));
		return call ? JSON.parse(String(call[1])) : null;
	}

	function remember(endpoint: unknown) {
		h.fs.readFileSync.mockImplementation((target: string) => {
			if (String(target).endsWith("endpoint.json")) return JSON.stringify(endpoint);
			throw new Error("ENOENT");
		});
	}

	it("remembers the port and the session key it launched on", async () => {
		const { ensureModelSidecar } = await freshModule();
		const runtime = await ensureModelSidecar();
		const saved = rememberedEndpoint();
		expect(saved).toBeTruthy();
		expect(runtime.baseUrl).toBe(`http://127.0.0.1:${saved?.port}`);
		expect(saved?.sessionKey).toBe(runtime.sessionKey);
	});

	// A running agent has the base URL and token baked into its launch env, so a
	// proxy that comes back elsewhere strands every session it was serving.
	it("comes back with the same session key, so running agents keep working", async () => {
		remember({ port: 47311, sessionKey: "sk-bf-rememberedkey" });
		const { ensureModelSidecar } = await freshModule();
		const runtime = await ensureModelSidecar();
		expect(runtime.sessionKey).toBe("sk-bf-rememberedkey");
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

	it("ignores a corrupt endpoint file instead of failing to start", async () => {
		h.fs.readFileSync.mockImplementation(() => "{not json");
		const { ensureModelSidecar } = await freshModule();
		const runtime = await ensureModelSidecar();
		expect(runtime.sessionKey).toMatch(/^sk-bf-/);
		expect(runtime.sessionKey).not.toBe("sk-bf-rememberedkey");
	});

	it("refuses a key that is not one of ours", async () => {
		remember({ port: 47311, sessionKey: "hijacked" });
		const { ensureModelSidecar } = await freshModule();
		const runtime = await ensureModelSidecar();
		expect(runtime.sessionKey).toMatch(/^sk-bf-/);
	});
});

describe("choosing the port", () => {
	const REMEMBERED = { port: 47311, sessionKey: "sk-bf-rememberedkey" };
	/** Ports the probe should call free; everything else is treated as taken. */
	const freeOnly = (...ports: number[]) => async (port: number) => ports.includes(port);

	it("uses one fixed address, so the proxy is at the same place every run", async () => {
		const { choosePort, DEFAULT_SIDECAR_PORT } = await freshModule();
		expect(await choosePort(1, REMEMBERED, freeOnly(DEFAULT_SIDECAR_PORT, REMEMBERED.port))).toBe(DEFAULT_SIDECAR_PORT);
	});

	it("keeps the fixed address even with nothing remembered", async () => {
		const { choosePort, DEFAULT_SIDECAR_PORT } = await freshModule();
		expect(await choosePort(1, null, freeOnly(DEFAULT_SIDECAR_PORT))).toBe(DEFAULT_SIDECAR_PORT);
	});

	// Second best: the address the agents already running were launched against.
	it("falls back to the last run's port when the fixed one is taken", async () => {
		const { choosePort } = await freshModule();
		expect(await choosePort(1, REMEMBERED, freeOnly(REMEMBERED.port))).toBe(REMEMBERED.port);
	});

	it("takes any free port when both are taken, rather than refusing to start", async () => {
		const { choosePort, DEFAULT_SIDECAR_PORT } = await freshModule();
		const port = await choosePort(1, REMEMBERED, freeOnly());
		expect(port).not.toBe(DEFAULT_SIDECAR_PORT);
		expect(port).not.toBe(REMEMBERED.port);
		expect(port).toBeGreaterThan(0);
	});

	// A port that answered the health check but died right after is not a port to
	// keep retrying — later attempts stop insisting and just take a free one.
	it("stops insisting on a specific port after the early attempts", async () => {
		const { choosePort, DEFAULT_SIDECAR_PORT } = await freshModule();
		const port = await choosePort(3, REMEMBERED, freeOnly(DEFAULT_SIDECAR_PORT, REMEMBERED.port));
		expect(port).not.toBe(DEFAULT_SIDECAR_PORT);
		expect(port).not.toBe(REMEMBERED.port);
	});

	it("sits below the ephemeral range, so no OS hands it out behind our back", async () => {
		const { DEFAULT_SIDECAR_PORT } = await freshModule();
		expect(DEFAULT_SIDECAR_PORT).toBeGreaterThan(1024);
		expect(DEFAULT_SIDECAR_PORT).toBeLessThan(32768);
	});
});

describe("autostart", () => {
	it("brings the proxy up with the app, so the catalog needs no operating", async () => {
		const { autostartModelSidecar, getModelSidecarStatus } = await freshModule();
		await autostartModelSidecar();
		expect(getModelSidecarStatus().running).toBe(true);
		expect(h.spawnMock).toHaveBeenCalledTimes(1);
	});

	it("stays out of the way when there is no provider to serve", async () => {
		h.catalog.mockReturnValue({ providers: [], models: [] });
		const { autostartModelSidecar, getModelSidecarStatus } = await freshModule();
		await autostartModelSidecar();
		expect(h.spawnMock).not.toHaveBeenCalled();
		expect(getModelSidecarStatus().running).toBe(false);
	});

	// A provider without a key is still worth starting for: the user is mid-setup,
	// and the proxy is what they need up to load the provider's model ids.
	it("starts for a provider that has no key yet", async () => {
		h.keys.mockReturnValue({});
		const { autostartModelSidecar, getModelSidecarStatus } = await freshModule();
		await autostartModelSidecar();
		expect(getModelSidecarStatus().running).toBe(true);
	});

	it("never throws when the proxy refuses to come up — the app still boots", async () => {
		h.spawnMock.mockImplementation(() => deadProcess("bind: address already in use"));
		stubHttp([], () => false);
		const { autostartModelSidecar, getModelSidecarStatus } = await freshModule();
		await expect(autostartModelSidecar()).resolves.toBeUndefined();
		expect(getModelSidecarStatus().running).toBe(false);
		expect(getModelSidecarStatus().lastError).toContain("address already in use");
	});

	it("does nothing when the build ships no proxy binary", async () => {
		h.fs.existsSync.mockReturnValue(false);
		delete process.env.DEV3_BIFROST_BINARY;
		const { autostartModelSidecar } = await freshModule();
		await autostartModelSidecar();
		expect(h.spawnMock).not.toHaveBeenCalled();
	});
});

describe("stopping", () => {
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

	it("is safe to call when nothing is running", async () => {
		const { stopModelSidecar } = await freshModule();
		await expect(stopModelSidecar()).resolves.toBeUndefined();
	});

	// A proxy that dies after it came up used to stay "running" forever: every
	// later launch was handed a dead port, and the panel offered Stop instead of
	// Start.
	it("stops calling itself running once the process dies on its own", async () => {
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

		const { ensureModelSidecar, getModelSidecarStatus } = await freshModule();
		await ensureModelSidecar();
		expect(getModelSidecarStatus().running).toBe(true);

		die(9);
		await new Promise((r) => setTimeout(r, 0));

		expect(getModelSidecarStatus().running).toBe(false);
		expect(getModelSidecarStatus().lastError).toContain("exited on its own");
	});

	// Quitting seconds after a launch triggered a start used to kill nothing: the
	// instance is only published when the start resolves, so the finished process
	// outlived the app holding the loopback port and the provider keys.
	it("waits for a start already in flight, so it cannot leave an orphan", async () => {
		const killed: number[] = [];
		const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
			killed.push(pid);
			return true;
		}) as typeof process.kill);
		h.getDescendantPids.mockResolvedValue([]);

		const { ensureModelSidecar, stopModelSidecar } = await freshModule();
		const start = ensureModelSidecar();
		await stopModelSidecar();
		await start;

		expect(killed).toEqual([5150]);
		killSpy.mockRestore();
	});

	// A stop the user asked for dismisses the failure; the exit message used to sit
	// in the panel afterwards, reading as a fresh failure of a proxy that is off.
	it("clears the last error when the proxy is stopped on purpose", async () => {
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
		die(9);
		await new Promise((r) => setTimeout(r, 0));
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

	it("passes when every bound model is served", async () => {
		stubHttp(["openrouter/fast", "custom-my-box/local"]);
		const { preflightModelRoles } = await freshModule();
		expect(await preflightModelRoles("claude", bindings, CATALOG)).toEqual({ ok: true, problems: [] });
	});

	it("passes untouched when the preset binds no roles", async () => {
		const { preflightModelRoles } = await freshModule();
		expect(await preflightModelRoles("claude", {}, CATALOG)).toEqual({ ok: true, problems: [] });
	});

	it("names the role whose catalog model was deleted", async () => {
		const { preflightModelRoles } = await freshModule();
		const result = await preflightModelRoles("claude", { opus: "m-gone" }, CATALOG);
		expect(result).toEqual({ ok: false, problems: [{ roleId: "opus", code: "missing-model" }] });
	});

	it("names the role whose model the proxy will not serve", async () => {
		stubHttp(["openrouter/fast"]);
		const { preflightModelRoles } = await freshModule();
		const result = await preflightModelRoles("claude", bindings, CATALOG);
		expect(result.ok).toBe(false);
		expect(result.problems).toEqual([
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

	it("does not fail a launch just because the proxy lists nothing", async () => {
		stubHttp([]);
		const { preflightModelRoles } = await freshModule();
		expect((await preflightModelRoles("claude", bindings, CATALOG)).ok).toBe(true);
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
