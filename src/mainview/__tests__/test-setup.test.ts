import { _actOffenderForTests, _isBlockedTestUrl, _isUnlayoutableChartWarning } from "../test-setup";

// Guards the localStorage substitute installed by test-setup.ts — Node 26's
// experimental global shadows happy-dom's and is undefined without
// --localstorage-file, which took the whole mainview suite down (decision 164).

describe("test environment storage", () => {
	it("exposes a working localStorage on both globalThis and window", () => {
		localStorage.setItem("dev3-probe", "value");
		expect(localStorage.getItem("dev3-probe")).toBe("value");
		expect(window.localStorage.getItem("dev3-probe")).toBe("value");
		localStorage.removeItem("dev3-probe");
		expect(localStorage.getItem("dev3-probe")).toBeNull();
	});

	it("reports length and clears", () => {
		localStorage.clear();
		localStorage.setItem("a", "1");
		localStorage.setItem("b", "2");
		expect(localStorage.length).toBe(2);
		expect(localStorage.key(0)).toBe("a");
		localStorage.clear();
		expect(localStorage.length).toBe(0);
	});

	it("returns null for a missing key", () => {
		expect(localStorage.getItem("never-written")).toBeNull();
		expect(localStorage.key(99)).toBeNull();
	});
});

// The act(...) tally replaces React's seven-line boilerplate, which one renderer run
// repeated 680 times. It must recognise every phrasing React uses, or the noise is
// back; and it must never swallow an unrelated console.error.
describe("act(...) warning tally", () => {
	it("names the component from an inlined message", () => {
		expect(_actOffenderForTests([
			"An update to GlobalHeader inside a test was not wrapped in act(...).\n",
		])).toBe("GlobalHeader");
	});

	it("names the component from React's %s form", () => {
		expect(_actOffenderForTests([
			"An update to %s inside a test was not wrapped in act(...).",
			"RateLimitIndicator",
		])).toBe("RateLimitIndicator");
	});

	it("recognises the suspense and post-teardown phrasings", () => {
		expect(_actOffenderForTests([
			"A suspended resource finished loading inside a test, but the event was not wrapped in act(...)",
		])).toBe("<suspended resource>");
		expect(_actOffenderForTests([
			"The current testing environment is not configured to support act(...)",
		])).toBe("<after teardown>");
	});

	it("lets an unrelated error through", () => {
		expect(_actOffenderForTests(["Failed to load spaces:", new Error("boom")])).toBeNull();
		expect(_actOffenderForTests([{ not: "a string" }])).toBeNull();
	});

	it("blocks every http(s) and origin-relative request", () => {
		expect(_isBlockedTestUrl("https://www.google-analytics.com/mp/collect?x=1")).toBe(true);
		expect(_isBlockedTestUrl("https://api.ipify.org")).toBe(true);
		expect(_isBlockedTestUrl(new URL("http://example.com/x"))).toBe(true);
		// happy-dom dials its own origin for these, which is why they count too.
		expect(_isBlockedTestUrl("http://127.0.0.1:3000/rpc")).toBe(true);
		expect(_isBlockedTestUrl("/rpc")).toBe(true);
		expect(_isBlockedTestUrl({ url: "/push/key" })).toBe(true);
		// Not a network request at all — data URLs and blobs stay usable.
		expect(_isBlockedTestUrl("data:text/plain,hi")).toBe(false);
		expect(_isBlockedTestUrl("blob:abc")).toBe(false);
		expect(_isBlockedTestUrl(undefined)).toBe(false);
	});

	it("actually rejects an off-machine fetch", async () => {
		await expect(fetch("https://www.google-analytics.com/mp/collect")).rejects.toThrow(
			/network blocked in tests/,
		);
	});

	it("drops only the unlayoutable-chart warning", () => {
		expect(_isUnlayoutableChartWarning([
			"The width(0) and height(0) of chart should be greater than 0, please check the style of container",
		])).toBe(true);
		expect(_isUnlayoutableChartWarning(["[task-sounds] playback refused"])).toBe(false);
	});
});
