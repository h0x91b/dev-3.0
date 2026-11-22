import { describe, expect, it } from "vitest";
import { ciWarning, fetchWithNetworkRetry, networkFailureIn, retryOnNetworkFailure } from "../../../scripts/network-retry";

// Verbatim final lines from red Canary publish runs (run ids in comments).
const NETWORK_LINES = [
	"Error: Failed to download electrobun CLI: Download failed: 504", // 42476227243
	"Failed to download core dependencies for win-x64: Failed to download binaries: 504 Gateway Time-out", // 42580057606
	"Failed to set up custom Bun 1.3.14 for win-x64: HTTP 504: Gateway Time-out", // 42583860398
	"Failed to download core dependencies for linux-x64: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()", // 34686171813
	' output: [ null, "Processing: /Users/runner/work/dev-3.0/dev-3.0/build/canary-macos-x64/dev-3.0-canary.app\\nerror is Error Domain=NSURLErrorDomain Code=-1005 \\"The network connection was lost.\\"', // 42396871249
	'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."', // 40661864794
	'  code: "ECONNRESET"', // 40669536003
	"::error::uploading canary-win-x64-dev-3.0-canary.zip failed: HTTP 502: Server Error (https://api.github.com/repos/h0x91b/dev-3.0/releases/assets/709022182)", // 41814991416
	'"message":"failed to initialize pricing manager: failed to sync pricing data: failed to load pricing data from URL and no existing data available: failed to download pricing data: HTTP 503"', // 41222745880
	"failed to sync model parameters data: failed to load model parameters from URL and no existing data in database: failed to download model parameters data: Get \"https://getbifrost.ai/datasheet/model-parameters\": read: connection reset by peer", // bifrost v1.6.10 params.go wording; no captured run
];

const NOT_NETWORK_LINES = [
	"Error: HTTP status code: 403. A required agreement is missing or has expired.", // 43707156206 — needs a human
	'Cannot find an overload for "ExtractToDirectory" and the argument count: "3".', // 44875201105
	"AssertionError: expected +0 to be 6 // Object.is equality", // 32879370320
	"hdiutil: create failed - No space left on device", // 32976325705
	"Failed to download core dependencies: 404 Not Found", // a missing release is not transient
];

describe("networkFailureIn", () => {
	it.each(NETWORK_LINES)("recognises a real network failure: %s", (line) => {
		expect(networkFailureIn(`building...\n${line}\nerror: script "build" exited with code 1`)).toBe(line.trim());
	});

	it.each(NOT_NETWORK_LINES)("never retries a real failure: %s", (line) => {
		expect(networkFailureIn(`building...\n${line}\n`)).toBeNull();
	});
});

describe("retryOnNetworkFailure", () => {
	const harness = (results: Array<[number, string]>) => {
		const slept: number[] = [];
		const warnings: string[] = [];
		let calls = 0;
		const run = () =>
			retryOnNetworkFailure(
				"electrobun",
				async () => {
					const [exitCode, output] = results[Math.min(calls, results.length - 1)];
					calls += 1;
					return { exitCode, output };
				},
				{ sleep: async (ms) => void slept.push(ms), warn: (m) => void warnings.push(m) },
			);
		return { run, slept, warnings, calls: () => calls };
	};

	it("retries a network failure after 30s and returns the later success", async () => {
		const h = harness([[1, NETWORK_LINES[0]], [1, NETWORK_LINES[4]], [0, "done"]]);
		expect(await h.run()).toBe(0);
		expect(h.calls()).toBe(3);
		expect(h.slept).toEqual([30_000, 30_000]);
		expect(h.warnings[0]).toMatch(/attempt 1\/5 failed on the network \(Error: Failed to download electrobun CLI: Download failed: 504\)/);
	});

	it("fails at once, without sleeping, on a non-network failure", async () => {
		const h = harness([[1, NOT_NETWORK_LINES[0]]]);
		expect(await h.run()).toBe(1);
		expect(h.calls()).toBe(1);
		expect(h.slept).toEqual([]);
		expect(h.warnings).toEqual([]);
	});

	it("gives up after 5 attempts and says so, keeping the CLI's exit code", async () => {
		const h = harness([[7, NETWORK_LINES[1]]]);
		expect(await h.run()).toBe(7);
		expect(h.calls()).toBe(5);
		expect(h.slept).toHaveLength(4);
		expect(h.warnings[h.warnings.length - 1]).toMatch(/persisted through 5 attempts — giving up/);
	});

	it("does not retry a success", async () => {
		const h = harness([[0, NETWORK_LINES[0]]]);
		expect(await h.run()).toBe(0);
		expect(h.calls()).toBe(1);
	});
});

describe("ciWarning", () => {
	it("is a workflow annotation on GitHub Actions and plain text elsewhere", () => {
		expect(ciWarning("x", { GITHUB_ACTIONS: "true" })).toBe("::warning title=Network retry::x");
		expect(ciWarning("x", {})).toBe("[network-retry] x");
	});
});

describe("fetchWithNetworkRetry", () => {
	const hooks = (answers: Array<number | Error>) => {
		const slept: number[] = [];
		let calls = 0;
		return {
			slept,
			calls: () => calls,
			opts: {
				fetchImpl: async () => {
					const next = answers[Math.min(calls++, answers.length - 1)];
					if (next instanceof Error) throw next;
					return new Response("body", { status: next });
				},
				sleep: async (ms: number) => void slept.push(ms),
				warn: () => {},
			},
		};
	};

	it("retries a dropped socket and a 5xx, then returns the success", async () => {
		const h = hooks([new Error("The socket connection was closed unexpectedly"), 503, 200]);
		const res = await fetchWithNetworkRetry("https://x", h.opts);
		expect(res.status).toBe(200);
		expect(h.calls()).toBe(3);
		expect(h.slept).toEqual([30_000, 30_000]);
	});

	it("returns a 404 at once — a missing file is not transient", async () => {
		const h = hooks([404]);
		expect((await fetchWithNetworkRetry("https://x", h.opts)).status).toBe(404);
		expect(h.calls()).toBe(1);
	});

	it("hands back the last 5xx after 5 attempts so the caller reports it", async () => {
		const h = hooks([502]);
		expect((await fetchWithNetworkRetry("https://x", h.opts)).status).toBe(502);
		expect(h.calls()).toBe(5);
	});

	it("rethrows the network error once the attempts run out", async () => {
		const h = hooks([new Error("ECONNRESET")]);
		await expect(fetchWithNetworkRetry("https://x", h.opts)).rejects.toThrow(/ECONNRESET/);
		expect(h.calls()).toBe(5);
	});
});
