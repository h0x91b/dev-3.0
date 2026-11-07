import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogProvider } from "../../shared/model-catalog";

const mocks = vi.hoisted(() => ({
	providers: [] as CatalogProvider[],
	keys: {} as Record<string, string>,
	tracking: true,
	fetch: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

vi.mock("../model-catalog-store", () => ({
	loadModelCatalog: () => ({ providers: mocks.providers, models: [] }),
	loadProviderKeys: () => mocks.keys,
}));
vi.mock("../settings", () => ({ loadSettings: async () => ({ agentRateLimitTracking: mocks.tracking }) }));
vi.mock("../agent-accounts", () => ({ listClaudeAccountDirs: () => [], listCodexAccountDirs: () => [] }));
vi.mock("../codex-rate-limits", () => ({ fetchCodexRateLimitSnapshot: async () => null }));
vi.mock("../data", () => ({ loadProjects: async () => [], loadTasks: async () => [], loadVirtualProjects: async () => [] }));

import { getAgentRateLimitsReport, stopRateLimitMonitor } from "../rate-limit-monitor";

const USAGE = {
	usages: {
		limit_5h: { used_ratio: 0.5, reset_time: "2026-11-05T11:34:44Z" },
		limit_month_total: { used_ratio: 0.1, reset_time: "2026-12-05T00:00:00Z" },
	},
};
const provider = (over: Partial<CatalogProvider> = {}): CatalogProvider => ({
	id: "kimi-1",
	kind: "custom",
	label: "Kimi Code",
	baseUrl: "https://api.example.test/coding/",
	usageSource: "kimi-code",
	...over,
});
const okResponse = () => new Response(JSON.stringify(USAGE), { status: 200 });

beforeEach(() => {
	stopRateLimitMonitor();
	mocks.providers = [];
	mocks.keys = {};
	mocks.tracking = true;
	mocks.warn.mockReset();
	mocks.fetch.mockReset().mockImplementation(async () => okResponse());
	vi.stubGlobal("fetch", mocks.fetch);
	vi.stubEnv("CODEX_HOME", "/nonexistent-dev3-test-codex-home");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	stopRateLimitMonitor();
});

const kimiSnapshots = (r: Awaited<ReturnType<typeof getAgentRateLimitsReport>>) => r.snapshots.filter((s) => s.source === "kimi");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The report never waits for Kimi: let a started request finish, then read again. */
async function poll() {
	await getAgentRateLimitsReport();
	await settle();
	return getAgentRateLimitsReport();
}

const T0 = 1_800_000_000_000;
const clock = () => {
	const spy = vi.spyOn(Date, "now");
	return { at: (minutes: number) => spy.mockReturnValue(T0 + minutes * 60_000), restore: () => spy.mockRestore() };
};
const respond = (status: number, body = "{}") => mocks.fetch.mockImplementation(async () => new Response(body, { status }));

beforeEach(() => {
	mocks.providers = [provider()];
	mocks.keys = { "kimi-1": "sk-test" };
});

describe("Kimi usage in the rate-limit report", () => {
	it("ignores a provider that did not opt in", async () => {
		mocks.providers = [provider({ usageSource: undefined })];
		const report = await poll();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(report.usageProviders).toEqual([]);
	});

	it("lists an opted-in provider without a key but sends no request", async () => {
		mocks.keys = {};
		const report = await poll();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(report.usageProviders).toEqual([{ id: "kimi-1", label: "Kimi Code", source: "kimi-code", missingKey: true }]);
		expect(kimiSnapshots(report)).toHaveLength(0);
	});

	it("reads <baseUrl>/v1/usages with the provider key as a Bearer token, without following redirects", async () => {
		const report = await poll();
		const [url, init] = mocks.fetch.mock.calls[0];
		expect(String(url)).toBe("https://api.example.test/coding/v1/usages");
		expect(init.headers).toEqual({ Authorization: "Bearer sk-test" });
		expect(init.redirect).toBe("error");
		const [snap] = kimiSnapshots(report);
		expect(snap.providerId).toBe("kimi-1");
		expect(snap.windows.map((w) => w.id)).toEqual(["five_hour", "monthly"]);
	});

	it("does not flag a provider with a stored key as missing one", async () => {
		const report = await poll();
		expect(report.usageProviders).toEqual([{ id: "kimi-1", label: "Kimi Code", source: "kimi-code" }]);
	});

	it("does not wait for the request: the first report has no reading, the next one does", async () => {
		let release: (r: Response) => void = () => {};
		mocks.fetch.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
		const first = await getAgentRateLimitsReport();
		expect(kimiSnapshots(first)).toHaveLength(0);
		release(okResponse());
		await settle();
		expect(kimiSnapshots(await getAgentRateLimitsReport())).toHaveLength(1);
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
	});

	it("starts one request while another is still in flight", async () => {
		const c = clock();
		mocks.fetch.mockImplementation(() => new Promise<Response>(() => {}));
		c.at(0);
		await getAgentRateLimitsReport();
		c.at(6);
		await getAgentRateLimitsReport();
		c.restore();
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
	});

	it("resolves a base URL without a trailing slash the same way", async () => {
		mocks.providers = [provider({ baseUrl: "https://api.example.test/coding" })];
		await poll();
		expect(String(mocks.fetch.mock.calls[0][0])).toBe("https://api.example.test/coding/v1/usages");
	});

	it("does not double a /v1 already on the base URL", async () => {
		mocks.providers = [provider({ baseUrl: "https://api.example.test/coding/v1" })];
		await poll();
		expect(String(mocks.fetch.mock.calls[0][0])).toBe("https://api.example.test/coding/v1/usages");
	});

	it("does not ask again within five minutes", async () => {
		await poll();
		const second = await poll();
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(kimiSnapshots(second)).toHaveLength(1);
	});

	it.each([
		["a server error", () => respond(500)],
		["a timeout", () => mocks.fetch.mockRejectedValue(new DOMException("t", "TimeoutError"))],
		["an unreadable answer", () => respond(200)],
	])("keeps the last good reading after %s", async (_name, fail) => {
		const c = clock();
		c.at(0);
		const first = await poll();
		fail();
		c.at(6);
		const second = await poll();
		c.restore();
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		expect(kimiSnapshots(second)[0].capturedAt).toBe(kimiSnapshots(first)[0].capturedAt);
	});

	it.each([401, 403])("drops the old reading when the key is refused with %i", async (status) => {
		const c = clock();
		c.at(0);
		expect(kimiSnapshots(await poll())).toHaveLength(1);
		respond(status);
		c.at(6);
		const second = await poll();
		c.restore();
		expect(kimiSnapshots(second)).toHaveLength(0);
		expect(second.usageProviders).toHaveLength(1);
	});

	it("treats a redirect as a failed request, not a followed one", async () => {
		mocks.fetch.mockRejectedValue(new TypeError("redirect"));
		const report = await poll();
		expect(kimiSnapshots(report)).toHaveLength(0);
		expect(mocks.warn).toHaveBeenCalledWith("Kimi usage read failed", expect.objectContaining({ kind: "request" }));
	});

	it("shows no reading, and no crash, when the endpoint answers garbage", async () => {
		respond(200);
		const report = await poll();
		expect(kimiSnapshots(report)).toHaveLength(0);
		expect(report.usageProviders).toHaveLength(1);
	});

	it("logs a 200 that is not JSON as a parse failure, not a failed request", async () => {
		respond(200, "<html>maintenance</html>");
		const report = await poll();
		expect(kimiSnapshots(report)).toHaveLength(0);
		await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledWith("Kimi usage read failed", { providerId: "kimi-1", kind: "parse" }));
	});

	it.each([
		["a new key", { keys: { "kimi-1": "sk-other" } }],
		["a new base URL", { providers: [provider({ baseUrl: "https://elsewhere.example.test/" })] }],
	])("fetches at once and drops the old reading after %s", async (_name, change) => {
		await poll();
		Object.assign(mocks, change);
		respond(401);
		const afterChange = await getAgentRateLimitsReport();
		expect(kimiSnapshots(afterChange)).toHaveLength(0);
		await settle();
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("forgets a provider that is no longer tracked, so re-adding it fetches again", async () => {
		await poll();
		mocks.providers = [provider({ usageSource: undefined })];
		await poll();
		mocks.providers = [provider()];
		await poll();
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("warns again when a failure follows a success", async () => {
		const c = clock();
		respond(500);
		c.at(0);
		await poll();
		c.at(6);
		await poll();
		expect(mocks.warn).toHaveBeenCalledTimes(1);
		mocks.fetch.mockImplementation(async () => okResponse());
		c.at(12);
		await poll();
		respond(500);
		c.at(18);
		await poll();
		c.restore();
		expect(mocks.warn).toHaveBeenCalledTimes(2);
	});

	it("never carries the key into the report or the log", async () => {
		mocks.keys = { "kimi-1": "sk-secret-value" };
		respond(500, "sk-secret-value");
		const report = await poll();
		expect(JSON.stringify(report)).not.toContain("sk-secret-value");
		expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("sk-secret-value");
	});

	it("does nothing when tracking is off", async () => {
		mocks.tracking = false;
		const report = await poll();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(report.snapshots).toEqual([]);
		expect(report.usageProviders).toBeUndefined();
	});
});
