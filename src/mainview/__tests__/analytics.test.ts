import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Polyfill PromiseRejectionEvent for happy-dom (not natively available)
if (typeof globalThis.PromiseRejectionEvent === "undefined") {
	(globalThis as any).PromiseRejectionEvent = class PromiseRejectionEvent extends Event {
		reason: unknown;
		promise: Promise<unknown>;
		constructor(type: string, init: { reason: unknown; promise: Promise<unknown> }) {
			super(type, { cancelable: true });
			this.reason = init.reason;
			this.promise = init.promise;
		}
	};
}

vi.mock("../rpc", () => ({
	api: {
		request: {
			logRendererError: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

// Stub localStorage
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => { store[key] = value; },
		removeItem: (key: string) => { delete store[key]; },
	},
	writable: true,
});

// Stub navigator
Object.defineProperty(globalThis, "navigator", {
	value: { userAgent: "test", language: "en", platform: "test" },
	writable: true,
});

// Stub screen
Object.defineProperty(globalThis, "screen", {
	value: { width: 1920, height: 1080 },
	writable: true,
});

// Stub crypto
Object.defineProperty(globalThis, "crypto", {
	value: { randomUUID: () => "test-uuid-1234" },
	writable: true,
});

// Stub fetch
globalThis.fetch = vi.fn().mockResolvedValue(undefined) as unknown as typeof fetch;

import {
	initAnalytics,
	destroyAnalytics,
	trackAgentLaunched,
	registerAgents,
	agentNameFromId,
	trackEvent,
	trackPageView,
	trackDiffView,
	analyticsLocationForRoute,
} from "../analytics";
import type { CodingAgent } from "../../shared/types";
import { taskSeqLabel } from "../../shared/types";
import type { Route } from "../state";

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

/** Parsed bodies of every GA4 hit (the mp/collect POSTs), oldest first. */
function gaHits(fetchMock: ReturnType<typeof vi.fn>) {
	return fetchMock.mock.calls
		.filter((c) => typeof c[0] === "string" && c[0].includes("mp/collect"))
		.map((c) => JSON.parse((c[1] as { body: string }).body));
}

describe("initAnalytics", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Clear localStorage entries
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
	});

	afterEach(() => {
		destroyAnalytics();
		vi.useRealTimers();
	});

	it("calling initAnalytics twice does not stack duplicate heartbeat intervals", () => {
		const clearSpy = vi.spyOn(globalThis, "clearInterval");

		initAnalytics("1.0.0");
		initAnalytics("1.0.0"); // second call should clear the first interval

		// clearInterval should have been called once (to clear the first interval)
		expect(clearSpy).toHaveBeenCalledTimes(1);

		// Advance past one heartbeat period — only one heartbeat event should fire
		const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
		vi.advanceTimersByTime(10 * 60 * 1000 + 100);
		const heartbeatCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length - fetchCalls;
		// Exactly 1 heartbeat (not 2 from stacked intervals)
		expect(heartbeatCalls).toBe(1);

		clearSpy.mockRestore();
	});

	it("destroyAnalytics stops heartbeat interval", () => {
		initAnalytics("1.0.0");
		destroyAnalytics();

		const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
		vi.advanceTimersByTime(10 * 60 * 1000 + 100);
		const heartbeatCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length - fetchCalls;
		expect(heartbeatCalls).toBe(0);
	});
});

describe("trackAgentLaunched", () => {
	const AGENTS: CodingAgent[] = [
		{
			id: "builtin-claude",
			name: "Claude",
			baseCommand: "claude",
			isDefault: true,
			configurations: [
				{ id: "claude-auto", name: "Auto (Opus)", model: "claude-opus", permissionMode: "auto" },
				{ id: "claude-bypass", name: "Bypass (Sonnet)", model: "sonnet", permissionMode: "bypassPermissions" },
			],
			defaultConfigId: "claude-auto",
		},
		{
			id: "user-custom-1",
			name: "My Custom CLI",
			baseCommand: "mycli",
			configurations: [{ id: "custom-cfg", name: "Default" }],
			defaultConfigId: "custom-cfg",
		},
	];

	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		initAnalytics("1.0.0");
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockClear();
	});

	afterEach(() => {
		destroyAnalytics();
	});

	function lastEventParams() {
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.events[0].name).toBe("agent_launched");
		return body.events[0].params;
	}

	it("emits agent name + permission mode for an explicit selection", () => {
		trackAgentLaunched(AGENTS, "builtin-claude", "claude-bypass");
		const p = lastEventParams();
		expect(p).toMatchObject({
			agent_name: "Claude",
			permission_mode: "bypassPermissions",
		});
	});

	it("resolves the default agent + config when agentId/configId are null", () => {
		trackAgentLaunched(AGENTS, null, null);
		const p = lastEventParams();
		expect(p.agent_name).toBe("Claude");
		expect(p.permission_mode).toBe("auto");
	});

	it("defaults the permission mode when the config has none", () => {
		trackAgentLaunched(AGENTS, "user-custom-1", "custom-cfg");
		const p = lastEventParams();
		expect(p.agent_name).toBe("My Custom CLI");
		expect(p.permission_mode).toBe("default");
	});

	it("falls back to unknown when the agent list is empty", () => {
		trackAgentLaunched([], "builtin-claude", "claude-auto");
		const p = lastEventParams();
		expect(p.agent_name).toBe("unknown");
		expect(p.permission_mode).toBe("default");
	});
});

describe("registerAgents / agentNameFromId", () => {
	it("resolves a registered agent's display name by id", () => {
		registerAgents([
			{ id: "builtin-claude", name: "Claude", baseCommand: "claude", configurations: [] },
			{ id: "builtin-codex", name: "Codex", baseCommand: "codex", configurations: [] },
		]);
		expect(agentNameFromId("builtin-codex")).toBe("Codex");
	});

	it("returns 'unknown' for null / undefined / unregistered ids", () => {
		registerAgents([]);
		expect(agentNameFromId(null)).toBe("unknown");
		expect(agentNameFromId(undefined)).toBe("unknown");
		expect(agentNameFromId("nope")).toBe("unknown");
	});
});

describe("ip_override (geolocation)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockReset();
		fetchMock.mockImplementation((url: string) =>
			typeof url === "string" && url.includes("ipify")
				? Promise.resolve({ json: () => Promise.resolve({ ip: "203.0.113.7" }) })
				: Promise.resolve(undefined),
		);
	});

	afterEach(() => {
		destroyAnalytics();
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	it("adds ip_override to the GA payload once the public IP resolves", async () => {
		initAnalytics("1.0.0");
		await flushMicrotasks();
		fetchMock.mockClear();

		trackEvent("ping");
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.ip_override).toBe("203.0.113.7");
	});

	it("caches the resolved IP and skips the lookup on the next launch", async () => {
		initAnalytics("1.0.0");
		await flushMicrotasks();

		const ipifyCalls = () =>
			fetchMock.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("ipify")).length;
		expect(ipifyCalls()).toBe(1);

		destroyAnalytics();
		initAnalytics("1.0.0"); // cache is fresh → no second ipify request
		await flushMicrotasks();
		expect(ipifyCalls()).toBe(1);
	});

	it("omits ip_override when the lookup fails (best-effort)", async () => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined); // ipify resolves to undefined → json() throws
		initAnalytics("1.0.0");
		await flushMicrotasks();
		fetchMock.mockClear();

		trackEvent("ping");
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.ip_override).toBeUndefined();
	});
});

describe("unhandledrejection handler", () => {
	let logRendererError: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		const rpcMod = await import("../rpc");
		logRendererError = rpcMod.api.request.logRendererError as ReturnType<typeof vi.fn>;
		logRendererError.mockClear();
		(fetch as unknown as ReturnType<typeof vi.fn>).mockClear();
		initAnalytics("1.0.0");
	});

	afterEach(() => {
		destroyAnalytics();
	});

	it("tracks RPC timeout as app_exception in GA", () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

		const event = new PromiseRejectionEvent("unhandledrejection", {
			reason: new Error('RPC "getBranchStatus" timed out (120 000 ms)'),
			promise: Promise.resolve(),
		});

		window.dispatchEvent(event);

		expect(fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(body.events[0].name).toBe("app_exception");
		expect(body.events[0].params.error_message).toContain("getBranchStatus");
		expect(body.events[0].params.error_message).toContain("timed out");
	});

	it("logs RPC timeout to backend", () => {
		const event = new PromiseRejectionEvent("unhandledrejection", {
			reason: new Error('RPC "showConfirm" timed out (120 000 ms)'),
			promise: Promise.resolve(),
		});

		window.dispatchEvent(event);

		expect(logRendererError).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining("showConfirm"),
				source: "unhandledrejection",
			}),
		);
	});

	it("tracks non-timeout rejections as app_exception", () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

		const event = new PromiseRejectionEvent("unhandledrejection", {
			reason: new Error("Something else broke"),
			promise: Promise.resolve(),
		});

		window.dispatchEvent(event);

		expect(fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(body.events[0].name).toBe("app_exception");
		expect(body.events[0].params.error_message).toContain("Something else broke");
	});

	it("handles non-Error reason (string)", () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockClear();

		const event = new PromiseRejectionEvent("unhandledrejection", {
			reason: "some string error",
			promise: Promise.resolve(),
		});

		window.dispatchEvent(event);

		expect(fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
		expect(body.events[0].params.error_message).toContain("some string error");
		expect(body.events[0].params.stack_line).toContain("no stack");
	});
});

describe("taskSeqLabel", () => {
	it("returns bare seq when the task has no variant", () => {
		expect(taskSeqLabel({ seq: 981, variantIndex: null })).toBe("981");
	});

	it("appends the variant index when present (including 0)", () => {
		expect(taskSeqLabel({ seq: 981, variantIndex: 1 })).toBe("981-1");
		expect(taskSeqLabel({ seq: 42, variantIndex: 0 })).toBe("42-0");
	});
});

describe("analyticsLocationForRoute", () => {
	it("maps project-less screens to prefixed /app paths", () => {
		expect(analyticsLocationForRoute({ screen: "dashboard" }).path).toBe("/app/dashboard");
		expect(analyticsLocationForRoute({ screen: "settings" }).path).toBe("/app/settings");
		expect(analyticsLocationForRoute({ screen: "stats" }).path).toBe("/app/stats");
	});

	it("uses the internal project/task id (never the project name)", () => {
		expect(analyticsLocationForRoute({ screen: "project", projectId: "p1" }).path).toBe("/app/project/p1/kanban");
		expect(analyticsLocationForRoute({ screen: "task", projectId: "p1", taskId: "t9" }).path).toBe("/app/project/p1/task/t9");
		expect(analyticsLocationForRoute({ screen: "project-settings", projectId: "p1" }).path).toBe("/app/project/p1/settings");
	});

	it("treats a split project view with an active task as the task surface", () => {
		const loc = analyticsLocationForRoute({ screen: "project", projectId: "p1", activeTaskId: "t3" });
		expect(loc.screen).toBe("task");
		expect(loc.path).toBe("/app/project/p1/task/t3");
	});

	it("uses the human-readable seq label in the task path when provided", () => {
		expect(analyticsLocationForRoute({ screen: "task", projectId: "p1", taskId: "hash-xyz" }, "981-1").path)
			.toBe("/app/project/p1/task/981-1");
		expect(analyticsLocationForRoute({ screen: "project", projectId: "p1", activeTaskId: "hash-xyz" }, "981-2").path)
			.toBe("/app/project/p1/task/981-2");
	});

	it("falls back to a generic /app hit for an unknown route", () => {
		const loc = analyticsLocationForRoute({ screen: "totally-new" } as unknown as Route);
		expect(loc.path).toBe("/app");
	});
});

describe("trackPageView / trackDiffView", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		initAnalytics("1.0.0");
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockClear();
	});

	afterEach(() => {
		destroyAnalytics();
	});

	it("emits a page_view carrying the task seq label (not the hash)", () => {
		trackPageView({ screen: "task", projectId: "p1", taskId: "hash-xyz" }, "981-1");
		const hit = gaHits(fetchMock)[0];
		expect(hit.events[0].name).toBe("page_view");
		expect(hit.events[0].params.page_location).toBe("https://dev3.local/app/project/p1/task/981-1");
		expect(hit.events[0].params.page_title).toBe("Task");
	});

	it("falls back to the raw task id when no seq label is available", () => {
		trackPageView({ screen: "task", projectId: "p1", taskId: "hash-xyz" });
		const hit = gaHits(fetchMock)[0];
		expect(hit.events[0].params.page_location).toBe("https://dev3.local/app/project/p1/task/hash-xyz");
	});

	it("emits a diff page_view under /app/project/<id>/diff/<seqLabel>", () => {
		trackDiffView("p1", "981-1");
		const hit = gaHits(fetchMock)[0];
		expect(hit.events[0].name).toBe("page_view");
		expect(hit.events[0].params.page_location).toBe("https://dev3.local/app/project/p1/diff/981-1");
	});

	// Regression guard: GA4 only derives the "Page path" dimension when
	// page_location is a real http(s) URL. A custom scheme (the old app://dev3)
	// left Page path "(not set)". Keep page_location parseable as https.
	it("emits a page_location that parses as an https URL (Page path works)", () => {
		trackPageView({ screen: "dashboard" });
		const loc = gaHits(fetchMock)[0].events[0].params.page_location as string;
		const url = new URL(loc);
		expect(url.protocol).toBe("https:");
		expect(url.pathname).toBe("/app/dashboard");
	});
});

describe("first_visit (web new-user event)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockClear();
	});

	afterEach(() => {
		destroyAnalytics();
	});

	it("fires first_visit (not first_open) on the very first launch", () => {
		initAnalytics("1.0.0");
		const names = gaHits(fetchMock)[0].events.map((e: { name: string }) => e.name);
		expect(names).toContain("first_visit");
		expect(names).not.toContain("first_open");
	});

	it("does not re-fire first_visit on the next launch", () => {
		initAnalytics("1.0.0"); // marks the device as seen
		destroyAnalytics();
		fetchMock.mockClear();
		initAnalytics("1.0.0");
		const names = gaHits(fetchMock)[0].events.map((e: { name: string }) => e.name);
		expect(names).not.toContain("first_visit");
	});
});

describe("engagement_time_msec (real foreground time)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockClear();
		initAnalytics("1.0.0");
	});

	afterEach(() => {
		destroyAnalytics();
		vi.useRealTimers();
	});

	it("reports the elapsed foreground time since the last hit, not a fixed constant", () => {
		fetchMock.mockClear();
		vi.advanceTimersByTime(5000);
		trackEvent("ping");
		const hit = gaHits(fetchMock)[0];
		expect(hit.events[0].name).toBe("ping");
		expect(hit.events[0].params.engagement_time_msec).toBe("5000");
	});

	it("attaches engagement to the first event only in a multi-event batch", () => {
		// The init hit (from beforeEach) batches first_visit + session_start on a
		// fresh store — so GA4 doesn't multi-count the same interval.
		const initHit = gaHits(fetchMock)[0];
		expect(initHit.events.length).toBeGreaterThanOrEqual(2);
		expect(initHit.events[0].params.engagement_time_msec).toBeDefined();
		expect(initHit.events[1].params.engagement_time_msec).toBeUndefined();
	});
});
