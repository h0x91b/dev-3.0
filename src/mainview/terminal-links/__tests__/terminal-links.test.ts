import type { ILink, ILinkProvider, Terminal } from "ghostty-web";
import { act } from "@testing-library/react";
import type { Context } from "cordis";
import { getAppRoot } from "../../plugins/root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TERMINAL_LINK_PROVIDERS, BUILTIN_TERMINAL_LINKS_PLUGIN } from "../builtins";
import { installTerminalLinks, type TerminalLinksHandle } from "../host";
import { getTerminalLinksRegistry, type TerminalLinkEnv, type TerminalLinkInstance, type TerminalLinkProviderDef } from "../registry";

vi.mock("../../rpc", () => ({ api: { request: {} } }));

function link(text: string): ILink {
	return { text, range: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, activate: () => {} };
}

function fakeEnv() {
	const registered: ILinkProvider[] = [];
	const term = {
		registerLinkProvider: (provider: ILinkProvider) => registered.push(provider),
		buffer: { active: { getLine: () => undefined, length: 0 } },
		rows: 24,
	} as unknown as Terminal;
	const env: TerminalLinkEnv = {
		term,
		container: document.createElement("div"),
		taskId: "t1",
		projectId: "p1",
		t: () => ((key: string) => key) as never,
		osc8UriFor: () => undefined,
		requestUnderlineRedraw: vi.fn(),
	};
	return { env, registered };
}

function provider(id: string, order: number, instance: Partial<TerminalLinkInstance>, extra: Partial<TerminalLinkProviderDef> = {}) {
	const create = vi.fn(() => instance as TerminalLinkInstance);
	return { def: { id, order, create, ...extra } as TerminalLinkProviderDef, create };
}

function linksAt(composite: ILinkProvider, y = 0): Promise<string[] | undefined> {
	return new Promise((resolve) => composite.provideLinks(y, (links) => resolve(links?.map((l) => l.text))));
}

function answering(texts: string[], async = false): ILinkProvider {
	return {
		provideLinks(_y, callback) {
			const answer = () => callback(texts.length > 0 ? texts.map(link) : undefined);
			if (async) queueMicrotask(answer);
			else answer();
		},
	};
}

function register(...defs: TerminalLinkProviderDef[]): () => void {
	const registry = getTerminalLinksRegistry();
	const disposers = defs.map((def) => registry.register(def));
	return () => disposers.forEach((dispose) => dispose());
}

let handle: TerminalLinksHandle | null = null;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	resetPluginsForTests();
	getTerminalLinksRegistry();
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	handle?.dispose();
	handle = null;
	errorSpy.mockRestore();
});

describe("terminalLinks slot host", () => {
	it("registers ONE provider with ghostty and concatenates links in slot order", async () => {
		register(provider("b", 20, { provider: answering(["b1"], true) }).def, provider("a", 10, { provider: answering(["a1", "a2"]) }).def);
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		expect(registered).toHaveLength(1);
		expect(await linksAt(registered[0])).toEqual(["a1", "a2", "b1"]);
	});

	it("answers undefined when no provider has a link on the row", async () => {
		register(provider("a", 10, { provider: answering([]) }).def);
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		expect(await linksAt(registered[0])).toBeUndefined();
	});

	it("isolates a provider that throws: the others still answer", async () => {
		register(
			provider("boom", 10, {
				provider: {
					provideLinks() {
						throw new Error("boom");
					},
				},
				touchAt: () => {
					throw new Error("boom");
				},
				refAt: () => {
					throw new Error("boom");
				},
				underlines: () => {
					throw new Error("boom");
				},
			}).def,
			provider("ok", 20, {
				provider: answering(["ok"]),
				touchAt: () => ({ kind: "web", target: "https://ok", open: () => {} }),
				refAt: () => "dev3://seq/1",
				underlines: () => [{ start: { x: 0, y: 3 }, end: { x: 2, y: 3 } }],
			}).def,
		);
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		expect(await linksAt(registered[0])).toEqual(["ok"]);
		expect(handle.touchLinkAt(0, 0)?.target).toBe("https://ok");
		expect(handle.refAt(0, 0)).toBe("dev3://seq/1");
		expect(handle.underlinesForRows([3])).toEqual([{ start: { x: 0, y: 3 }, end: { x: 2, y: 3 } }]);
		expect(errorSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual([
			"[terminalLinks] boom provideLinks failed:",
			"[terminalLinks] boom touchAt failed:",
			"[terminalLinks] boom refAt failed:",
			"[terminalLinks] boom underlines failed:",
		]);
	});

	it("logs a provider's failing callback once, however often it is called, and again after a slot change", () => {
		const boom = () => {
			throw new Error("boom");
		};
		register(provider("boom", 10, { refAt: boom, underlines: boom }).def);
		const { env } = fakeEnv();
		handle = installTerminalLinks(env);
		for (let i = 0; i < 25; i++) {
			handle.refAt(0, i);
			handle.underlinesForRows([i]);
		}
		expect(errorSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual(["[terminalLinks] boom refAt failed:", "[terminalLinks] boom underlines failed:"]);
		register(provider("other", 20, {}).def);
		handle.refAt(0, 0);
		expect(errorSpy).toHaveBeenCalledTimes(3);
	});

	it("answers ghostty once with nothing when the terminal is disposed mid-scan", async () => {
		let release: (links: ILink[] | undefined) => void = () => {};
		register(provider("slow", 10, { provider: { provideLinks: (_y, callback) => { release = callback; } } }).def);
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		const answer = vi.fn();
		registered[0].provideLinks(0, answer);
		handle.dispose();
		handle = null;
		release([link("late")]);
		release([link("again")]);
		expect(answer.mock.calls).toEqual([[undefined]]);
	});

	it("skips a provider whose create throws", async () => {
		const broken = provider("broken", 10, {});
		broken.create.mockImplementation(() => {
			throw new Error("nope");
		});
		register(broken.def, provider("ok", 20, { provider: answering(["ok"]) }).def);
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		expect(await linksAt(registered[0])).toEqual(["ok"]);
	});

	it("ranks taps and preview refs by their own order, falling back to the click order", () => {
		register(
			provider("first-click", 10, { touchAt: () => ({ kind: "file", target: "file", open: () => {} }), refAt: () => "dev3://seq/1" }, { touchOrder: 40 }).def,
			provider("second-click", 20, { touchAt: () => ({ kind: "web", target: "web", open: () => {} }), refAt: () => "dev3://seq/2" }, { touchOrder: 10, refOrder: 5 }).def,
		);
		const { env } = fakeEnv();
		handle = installTerminalLinks(env);
		expect(handle.touchLinkAt(0, 0)?.target).toBe("web");
		expect(handle.refAt(0, 0)).toBe("dev3://seq/2");
	});

	it("rebuilds its snapshot only when the slot changes, never per call", async () => {
		const a = provider("a", 10, { provider: answering(["a"]) });
		register(a.def);
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		const listSpy = vi.spyOn(getTerminalLinksRegistry(), "list");
		for (let i = 0; i < 5; i++) {
			await linksAt(registered[0]);
			handle.touchLinkAt(0, 0);
			handle.refAt(0, 0);
			handle.underlinesForRows([0]);
		}
		expect(listSpy).not.toHaveBeenCalled();
		expect(a.create).toHaveBeenCalledTimes(1);

		const dispose = vi.fn();
		const b = provider("b", 20, { provider: answering(["b"]), dispose });
		const unregister = register(b.def);
		expect(await linksAt(registered[0])).toEqual(["a", "b"]);
		expect(env.requestUnderlineRedraw).toHaveBeenCalledTimes(2);
		unregister();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(await linksAt(registered[0])).toEqual(["a"]);
		expect(registered).toHaveLength(1);
	});

	it("[dispose] drops an unloading plugin's providers from an open terminal and keeps the others answering", async () => {
		register(provider("keeper", 10, { provider: answering(["keeper"]), refAt: () => "dev3://seq/1" }).def);
		const disposeLeaving = vi.fn();
		const leaving = provider("leaving", 5, { provider: answering(["leaving"]), refAt: () => "dev3://seq/2", dispose: disposeLeaving });
		const fiber = getAppRoot().plugin({
			name: "leaving-links",
			inject: ["terminalLinks"],
			apply(ctx: Context) {
				ctx.terminalLinks.register(leaving.def);
			},
		});
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		const { env, registered } = fakeEnv();
		handle = installTerminalLinks(env);
		expect(await linksAt(registered[0])).toEqual(["leaving", "keeper"]);
		expect(handle.refAt(0, 0)).toBe("dev3://seq/2");
		await fiber.dispose();
		expect(disposeLeaving).toHaveBeenCalledTimes(1);
		expect(await linksAt(registered[0])).toEqual(["keeper"]);
		expect(handle.refAt(0, 0)).toBe("dev3://seq/1");
		expect(registered).toHaveLength(1);
	});

	it("disposes every instance and stops listening on dispose", () => {
		const dispose = vi.fn();
		const a = provider("a", 10, { dispose });
		register(a.def);
		const { env } = fakeEnv();
		handle = installTerminalLinks(env);
		handle.dispose();
		handle = null;
		expect(dispose).toHaveBeenCalledTimes(1);
		register(provider("late", 20, {}).def);
		expect(a.create).toHaveBeenCalledTimes(1);
	});

	it("the built-in plugin registers the four built-in providers in click order", async () => {
		applyBuiltinPlugins([], [BUILTIN_TERMINAL_LINKS_PLUGIN]);
		for (let tick = 0; tick < 20; tick++) await act(async () => {});
		expect(getTerminalLinksRegistry().list().map((entry) => entry.def.id)).toEqual([
			"builtin:file-paths",
			"builtin:osc8",
			"builtin:deep-links",
			"builtin:plain-urls",
		]);
		expect(BUILTIN_TERMINAL_LINK_PROVIDERS.map((def) => def.id)).toEqual(getTerminalLinksRegistry().list().map((entry) => entry.def.id));
	});

	it("pins the built-ins' tap and preview-card precedence, which differ from the click order", () => {
		const rankBy = (key: "touchOrder" | "refOrder") =>
			BUILTIN_TERMINAL_LINK_PROVIDERS.filter((def) => key !== "refOrder" || def.refOrder !== undefined)
				.slice()
				.sort((a, b) => (a[key] ?? a.order) - (b[key] ?? b.order))
				.map((def) => def.id);
		expect(rankBy("touchOrder")).toEqual(["builtin:osc8", "builtin:deep-links", "builtin:plain-urls", "builtin:file-paths"]);
		expect(rankBy("refOrder")).toEqual(["builtin:deep-links", "builtin:osc8"]);
	});
});
