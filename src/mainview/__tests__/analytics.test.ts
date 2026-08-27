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
	analyticsVersion,
} from "../analytics";
import { setRuntimeTelemetryOptOut, _resetTelemetryRuntimeStateForTests } from "../telemetry";
import { BUILD_COMMIT } from "../../shared/build-info.generated";
import type { CodingAgent, TelemetryProfile } from "../../shared/types";
import { countryForTimezone } from "../../shared/timezone-country";
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

describe("the user's IP never leaves the machine", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		destroyAnalytics();
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	it("never requests the public IP from a third-party lookup service", async () => {
		initAnalytics("1.0.0");
		await flushMicrotasks();
		trackEvent("ping");

		const hosts = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(hosts.every((url) => url.startsWith("https://www.google-analytics.com/"))).toBe(true);
	});

	it("sends no ip_override field to GA", async () => {
		initAnalytics("1.0.0");
		await flushMicrotasks();
		fetchMock.mockClear();

		trackEvent("ping");
		const raw = fetchMock.mock.calls[0][1].body as string;
		expect(JSON.parse(raw).ip_override).toBeUndefined();
		expect(raw).not.toContain("ip_override");
	});

	it("erases an IP a previous version cached, even with telemetry off", async () => {
		store["dev3-ga-ip"] = "203.0.113.7";
		store["dev3-ga-ip-ts"] = String(Date.now());
		setRuntimeTelemetryOptOut(true);

		try {
			initAnalytics("1.0.0");
			await flushMicrotasks();
		} finally {
			_resetTelemetryRuntimeStateForTests();
		}

		expect(store["dev3-ga-ip"]).toBeUndefined();
		expect(store["dev3-ga-ip-ts"]).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("build channel and commit", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	afterEach(() => destroyAnalytics());

	const propsOfFirstHit = () =>
		JSON.parse(fetchMock.mock.calls[0][1].body).user_properties;

	it("reports a dev build as its own channel, not as the stable version", () => {
		initAnalytics("1.48.1", "dev");
		expect(propsOfFirstHit().build_channel.value).toBe("dev");
	});

	it("reports a canary build as canary", () => {
		initAnalytics("1.48.1", "canary");
		expect(propsOfFirstHit().build_channel.value).toBe("canary");
	});

	it("falls back to stable when the caller has no channel to give", () => {
		initAnalytics("1.48.1");
		expect(propsOfFirstHit().build_channel.value).toBe("stable");
	});

	it("carries the build commit as an EVENT parameter, not a user property", () => {
		initAnalytics("1.48.1", "canary");
		const hit = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(hit.events[0].params.build_commit).toBe(BUILD_COMMIT);
		expect(propsOfFirstHit().build_commit).toBeUndefined();
	});

	// The payload itself, not just the helper: app_version is the dimension GA
	// shows unaided, so a non-stable build must never report the bare version there.
	it("puts the channel into app_version, the dimension GA reports unaided", () => {
		initAnalytics("1.48.1", "canary");
		expect(propsOfFirstHit().app_version.value).toBe("canary-1.48.1");
	});

	// A source build must not mint a per-worktree version value: GA4 rolls a
	// dimension's long tail into "(other)", and the tail would be the releases.
	it("reports a bare \"dev\" for a source build, with no version in it", () => {
		initAnalytics("1.48.1", "dev");
		expect(propsOfFirstHit().app_version.value).toBe("dev");
	});

	it("leaves app_version bare for a stable install", () => {
		initAnalytics("1.48.1", "stable");
		expect(propsOfFirstHit().app_version.value).toBe("1.48.1");
	});
});

describe("analyticsVersion", () => {
	// app_version is a built-in GA4 dimension and shows up unaided, so the channel
	// rides in the string itself rather than only in a user property.
	it("leaves a stable install's version untouched", () => {
		expect(analyticsVersion("1.48.1", "stable")).toBe("1.48.1");
		expect(analyticsVersion("1.48.1", undefined)).toBe("1.48.1");
	});

	it("collapses every source build to one value, whatever version it was cut from", () => {
		expect(analyticsVersion("1.48.1", "dev")).toBe("dev");
		expect(analyticsVersion("2.0.0", "dev")).toBe("dev");
	});

	it("prefixes a canary build so it stops reading as the stable release", () => {
		expect(analyticsVersion("1.48.1", "canary")).toBe("canary-1.48.1");
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

const PROFILE: TelemetryProfile = {
	cpuArch: "arm64",
	osVersion: "15",
	installType: "brew-formula",
	terminalBackend: "tmux",
	defaultAgent: "claude",
	projectCountBucket: "16-30",
	taskCountBucket: "1001+",
	installAgeBucket: "month-06",
};

describe("device object", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	afterEach(() => destroyAnalytics());

	const firstHit = () => JSON.parse(fetchMock.mock.calls[0][1].body);

	// These three are Measurement Protocol fields. Left in user_properties they
	// cost three of the twenty-five slots AND show nothing until someone registers
	// each as a custom dimension.
	it("reports OS, language and screen size as GA's own device fields", () => {
		initAnalytics("1.0.0");
		expect(firstHit().device).toMatchObject({
			category: "desktop",
			language: "en",
			screen_resolution: "1920x1080",
		});
	});

	// WebKit says "Mac OS X 10_15_7" on every Mac ever made, so the version has to
	// come from the host or not at all.
	it("takes the OS version from the host, never from the User-Agent", () => {
		initAnalytics("1.0.0", "stable", { ...PROFILE, osVersion: "15" });
		expect(firstHit().device.operating_system_version).toBe("15");
	});

	it("omits the OS version rather than guessing it when the host gave none", () => {
		initAnalytics("1.0.0");
		expect(firstHit().device.operating_system_version).toBeUndefined();
	});

	it("keeps them OUT of user_properties", () => {
		initAnalytics("1.0.0");
		const props = firstHit().user_properties;
		expect(props.operating_system).toBeUndefined();
		expect(props.language).toBeUndefined();
		expect(props.screen_resolution).toBeUndefined();
	});
});

describe("install profile properties", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	afterEach(() => destroyAnalytics());

	const props = () => JSON.parse(fetchMock.mock.calls[0][1].body).user_properties;

	it("reports every profile field the host resolved", () => {
		initAnalytics("1.48.1", "stable", PROFILE);
		expect(props()).toMatchObject({
			cpu_arch: { value: "arm64" },
			install_type: { value: "brew-formula" },
			terminal_backend: { value: "tmux" },
			default_agent: { value: "claude" },
			project_count_bucket: { value: "16-30" },
			task_count_bucket: { value: "1001+" },
			install_age_bucket: { value: "month-06" },
		});
	});

	// A failed or slow host probe must cost the hit nothing.
	it("still sends the hit when the host gave no profile", () => {
		initAnalytics("1.48.1", "stable");
		expect(props().app_version.value).toBe("1.48.1");
		expect(props().cpu_arch).toBeUndefined();
	});

	// Twenty-five is a hard GA4 ceiling, and going over it drops properties silently.
	it("stays well inside GA4's 25-property limit, with legal names and values", () => {
		initAnalytics("1.48.1", "canary", PROFILE);
		const all = props() as Record<string, { value: string }>;
		expect(Object.keys(all).length).toBeLessThanOrEqual(25);
		for (const [name, { value }] of Object.entries(all)) {
			expect(name.length).toBeLessThanOrEqual(24);
			expect(value.length).toBeLessThanOrEqual(36);
		}
	});
});

function withTimezone(timeZone: string, run: () => void): void {
	const original = Intl.DateTimeFormat;
	(Intl as { DateTimeFormat: unknown }).DateTimeFormat = function () {
		return { resolvedOptions: () => ({ timeZone }) };
	};
	try {
		run();
	} finally {
		(Intl as { DateTimeFormat: unknown }).DateTimeFormat = original;
	}
}

describe("country without an IP", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(undefined);
	});

	afterEach(() => destroyAnalytics());

	// The zone is pinned rather than read off the machine: CI runs in UTC, which
	// belongs to no country, and the assertion would then read a missing field.
	it("sends the country as a top-level field, not as a user property", () => {
		withTimezone("Asia/Jerusalem", () => {
			initAnalytics("1.0.0");
			const hit = JSON.parse(fetchMock.mock.calls[0][1].body);
			expect(hit.user_location.country_id).toBe("IL");
			expect(countryForTimezone("Asia/Jerusalem")).toBe("IL");
			expect(hit.user_properties.country).toBeUndefined();
		});
	});

	// The whole reason ip_override went away: no request, no third party, no IP.
	it("costs no network request and never mentions an IP", () => {
		initAnalytics("1.0.0");
		const hosts = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(hosts.every((url) => url.startsWith("https://www.google-analytics.com/"))).toBe(true);
		expect(fetchMock.mock.calls[0][1].body as string).not.toContain("ip_override");
	});

	// A wrong country is worse than a missing one, so an unmapped zone must drop
	// the field rather than fall back to anything.
	it("omits user_location entirely when the timezone maps to no country", () => {
		withTimezone("Mars/Olympus", () => {
			initAnalytics("1.0.0");
			expect(JSON.parse(fetchMock.mock.calls[0][1].body).user_location).toBeUndefined();
		});
	});
});

describe("analyticsLocationForRoute", () => {
	it("maps project-less screens to prefixed /app paths", () => {
		expect(analyticsLocationForRoute({ screen: "dashboard" }).path).toBe("/app/dashboard");
		expect(analyticsLocationForRoute({ screen: "settings" }).path).toBe("/app/settings");
		expect(analyticsLocationForRoute({ screen: "stats" }).path).toBe("/app/stats");
	});

	// The path names the SCREEN. An id in it mints one Page-path row per project
	// and per task, which is exactly what the dimension must not become.
	it("carries no project id and no task id", () => {
		expect(analyticsLocationForRoute({ screen: "project", projectId: "p1" }).path).toBe("/app/project/kanban");
		expect(analyticsLocationForRoute({ screen: "task", projectId: "p1", taskId: "t9" }).path).toBe("/app/project/task");
		expect(analyticsLocationForRoute({ screen: "project-settings", projectId: "p1" }).path).toBe("/app/project/settings");
		expect(analyticsLocationForRoute({ screen: "project-terminal", projectId: "p1" }).path).toBe("/app/project/terminal");
	});

	it("treats a split project view with an active task as the task surface", () => {
		const loc = analyticsLocationForRoute({ screen: "project", projectId: "p1", activeTaskId: "t3" });
		expect(loc.screen).toBe("task");
		expect(loc.path).toBe("/app/project/task");
	});

	it("gives two different projects the same path", () => {
		const a = analyticsLocationForRoute({ screen: "task", projectId: "p1", taskId: "t9" }).path;
		const b = analyticsLocationForRoute({ screen: "task", projectId: "p2", taskId: "t4" }).path;
		expect(a).toBe(b);
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

	it("emits a page_view whose location holds no identifier at all", () => {
		trackPageView({ screen: "task", projectId: "p1", taskId: "hash-xyz" });
		const hit = gaHits(fetchMock)[0];
		expect(hit.events[0].name).toBe("page_view");
		expect(hit.events[0].params.page_location).toBe("https://dev3.local/app/project/task");
		expect(hit.events[0].params.page_title).toBe("Task");
	});

	it("emits a diff page_view under /app/project/diff", () => {
		trackDiffView();
		const hit = gaHits(fetchMock)[0];
		expect(hit.events[0].name).toBe("page_view");
		expect(hit.events[0].params.page_location).toBe("https://dev3.local/app/project/diff");
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

describe("VITE_TELEMETRY=off", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.stubEnv("VITE_TELEMETRY", "off");
		vi.useFakeTimers();
		for (const key of Object.keys(store)) delete store[key];
		destroyAnalytics();
		fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockClear();
	});

	afterEach(() => {
		destroyAnalytics();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("makes no request at all on init — neither the GA hit nor the public-IP lookup", () => {
		initAnalytics("1.0.0");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("starts no heartbeat", () => {
		initAnalytics("1.0.0");
		vi.advanceTimersByTime(60 * 60 * 1000);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("drops every explicit track call", () => {
		initAnalytics("1.0.0");
		trackEvent("ping");
		trackPageView({ screen: "dashboard" });
		trackDiffView();
		trackAgentLaunched([], null, null);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("resumes sending once the flag is back to its default", () => {
		vi.stubEnv("VITE_TELEMETRY", "on");
		initAnalytics("1.0.0");
		expect(gaHits(fetchMock).length).toBe(1);
	});

	it.each(["off", "OFF", " Off ", "false", "0", "no"])(
		"treats %j as off",
		(value) => {
			vi.stubEnv("VITE_TELEMETRY", value);
			initAnalytics("1.0.0");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
});
