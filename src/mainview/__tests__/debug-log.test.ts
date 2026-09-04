import { debugEnabled, debugLog, underTest } from "../debug-log";

// The whole point of the channel is that terminal/rpc setup traces stay in the app and
// stay out of the test output — 1.4k lines of one renderer run were these.
describe("renderer debug channels", () => {
	beforeEach(() => {
		localStorage.removeItem("dev3-debug");
	});

	it("requires explicit opt-in for freeze tracing in a normal app build", () => {
		vi.stubEnv("MODE", "production");
		vi.stubEnv("VITEST", "");
		try {
			expect(debugEnabled("terminal")).toBe(true);
			expect(debugEnabled("freeze")).toBe(false);
			localStorage.setItem("dev3-debug", "terminal,rpc,boot,freeze");
			expect(debugEnabled("freeze")).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("knows it is under test", () => {
		expect(underTest()).toBe(true);
	});

	it("is silent by default here", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		debugLog("terminal", "[TerminalView] noise");
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("opens the channels the override names, and only those", () => {
		localStorage.setItem("dev3-debug", "terminal, boot");
		expect(debugEnabled("terminal")).toBe(true);
		expect(debugEnabled("boot")).toBe(true);
		expect(debugEnabled("rpc")).toBe(false);
	});

	it("opens everything on * and closes everything on off", () => {
		localStorage.setItem("dev3-debug", "*");
		expect(debugEnabled("rpc")).toBe(true);
		localStorage.setItem("dev3-debug", "off");
		expect(debugEnabled("rpc")).toBe(false);
	});

	it("logs once the channel is open", () => {
		localStorage.setItem("dev3-debug", "terminal");
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		debugLog("terminal", "[TerminalView] wanted");
		expect(spy).toHaveBeenCalledWith("[TerminalView] wanted");
		spy.mockRestore();
	});
});
