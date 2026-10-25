import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTokenCostUsd } from "../../shared/agent-pricing";

const DAY_MS = 24 * 60 * 60_000;
let dir: string;
let now: number;
let fetchMock: ReturnType<typeof vi.fn>;

function feed(input = 3, output = 12) {
	return {
		openai: { models: { "gpt-6.1-sol": { cost: { input, output, cache_read: 0.15, cache_write: 4 } } } },
		anthropic: { models: { "claude-new": { cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } } } },
		openrouter: { models: { "openai/gpt-6.1-sol": { cost: { input: 7, output: 21, cache_read: 0.7 } } } },
	};
}

function reply(value: unknown): Response {
	return new Response(JSON.stringify(value));
}

async function resolver() {
	return (await import("../agent-pricing-refresh")).getPricingResolver();
}

beforeEach(() => {
	vi.resetModules();
	dir = mkdtempSync(join(tmpdir(), "dev3-pricing-"));
	vi.stubEnv("DEV3_HOME", dir);
	now = Date.parse("2026-10-25T12:00:00Z");
	vi.spyOn(Date, "now").mockImplementation(() => now);
	fetchMock = vi.fn().mockResolvedValue(reply(feed()));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("daily agent pricing refresh", () => {
	it("applies public input, output and cache-write updates to token costs without a release", async () => {
		const rate = await resolver();
		expect(rate("gpt-6.1-sol")).toEqual({ input: 3, output: 12, cacheRead: 0.15, cacheWrite5m: 4, cacheWrite1h: 6 });
		expect(computeTokenCostUsd("gpt-6.1-sol", {
			inputTokens: 1_000_000, outputTokens: 1_000_000,
			cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000,
		}, rate)).toEqual({ costUsd: 19.15, priced: true });
		expect(rate("claude-new")).toMatchObject({ input: 4, output: 20 });
		expect(rate("claude-new[1m]")).toMatchObject({ input: 4, output: 20 });
		expect(JSON.parse(readFileSync(join(dir, "agent-pricing-v1.json"), "utf8"))).toMatchObject({ version: 1, fetchedAt: now });
	});

	it("refreshes once a day while existing resolvers retain a consistent snapshot", async () => {
		const first = await resolver();
		await resolver();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		now += DAY_MS;
		fetchMock.mockResolvedValue(reply(feed(6, 24)));
		const latest = await resolver();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(latest("gpt-6.1-sol")).toMatchObject({ input: 6, output: 24 });
		expect(first("gpt-6.1-sol")).toMatchObject({ input: 3, output: 12 });
	});

	it("retains the last good rates across restarts and a later offline refresh", async () => {
		await resolver();
		vi.resetModules();
		fetchMock.mockRejectedValue(new Error("offline"));
		const cached = await resolver();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(cached("gpt-6.1-sol")?.input).toBe(3);
		now += DAY_MS;
		expect((await resolver())("gpt-6.1-sol")?.input).toBe(3);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retains omitted and malformed models while accepting valid feed changes", async () => {
		await resolver();
		now += DAY_MS;
		fetchMock.mockResolvedValue(reply({ openai: { models: {
			"gpt-6.1-sol": { cost: { input: -9, output: 0 } },
			"new-priced-model": { cost: { input: 1, output: 2 } },
		} } }));
		const latest = await resolver();
		expect(latest("gpt-6.1-sol")?.input).toBe(3);
		expect(latest("claude-new")?.input).toBe(4);
		expect(latest("new-priced-model")).toMatchObject({ input: 1, output: 2 });
		vi.resetModules();
		expect((await resolver())("claude-new")?.input).toBe(4);
	});

	it("retries malformed responses with increasing cooldown and keeps last good prices", async () => {
		await resolver();
		now += DAY_MS;
		fetchMock.mockImplementation(() => Promise.resolve(new Response("{bad-json")));
		expect((await resolver())("gpt-6.1-sol")?.input).toBe(3);
		await resolver();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		now += 5 * 60_000;
		await resolver();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		now += 5 * 60_000;
		await resolver();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		now += 5 * 60_000;
		fetchMock.mockResolvedValue(reply(feed(6)));
		expect((await resolver())("gpt-6.1-sol")?.input).toBe(6);
	});

	it("shares a single in-flight refresh between simultaneous dashboard requests", async () => {
		let finish!: (response: Response) => void;
		fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
		const requests = [resolver(), resolver(), resolver()];
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		finish(reply(feed()));
		const results = await Promise.all(requests);
		expect(results.every((rate) => rate("gpt-6.1-sol")?.input === 3)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("fetches only the fixed complete feed without model ids or local identifiers", async () => {
		const rate = await resolver();
		rate("private-model-name");
		rate("account-secret/my-route");
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe("https://models.dev/api.json");
		expect(options).toEqual({ method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal) });
		expect(options.body).toBeUndefined();
		expect(options.headers).toBeUndefined();
		expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/private-model-name|account-secret|dev3-pricing-/);
	});

	it("keeps direct provider models and exact routed OpenRouter ids distinct", async () => {
		const data = feed();
		Object.assign(data, { "unrelated-vendor": { models: { "gpt-6.1-sol": { cost: { input: 999, output: 999 } } } } });
		fetchMock.mockResolvedValue(reply(data));
		const rate = await resolver();
		expect(rate("gpt-6.1-sol")?.input).toBe(3);
		expect(rate("openai/gpt-6.1-sol")?.input).toBe(7);
		expect(rate("openrouter/openai/gpt-6.1-sol")?.input).toBe(7);
		expect(rate("anthropic/claude-new[1m]")?.input).toBe(4);
		expect(rate("openrouter/anthropic/claude-new")).toBeNull();
		expect(rate("unrelated-vendor/gpt-6.1-sol")).toBeNull();
	});

	it.each([{}, null, { openai: { models: { bad: { cost: { input: "1", output: 2 } } } } }])(
		"uses bundled offline rates when the feed has no usable prices: %j", async (invalid) => {
			fetchMock.mockResolvedValue(reply(invalid));
			const rate = await resolver();
			expect(rate("gpt-6.1-sol")).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
			expect(rate("unknown-model")).toBeNull();
		});

	it("rejects oversized feeds and retains bundled prices", async () => {
		fetchMock.mockResolvedValue(new Response(" ".repeat(16 * 1024 * 1024 + 1)));
		expect((await resolver())("gpt-6.1-sol")?.input).toBe(2);
	});

	it("ignores invalid saved prices and recovers using the current public feed", async () => {
		writeFileSync(join(dir, "agent-pricing-v1.json"), JSON.stringify({ version: 1, fetchedAt: now, rates: { "openai:gpt-6.1-sol": { input: -1 } } }));
		expect((await resolver())("gpt-6.1-sol")?.input).toBe(3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
