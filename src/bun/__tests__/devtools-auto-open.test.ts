import { describe, expect, it } from "vitest";
import { shouldAutoOpenDevTools } from "../devtools-auto-open";

describe("shouldAutoOpenDevTools", () => {
	it("auto-opens off macOS and below macOS 26; skips Darwin 25+ and unparseable releases (the docked inspector blanks the WKWebView)", () => {
		expect(shouldAutoOpenDevTools({}, "linux", "6.8.0")).toBe(true);
		expect(shouldAutoOpenDevTools({}, "win32", "10.0.22631")).toBe(true);
		expect(shouldAutoOpenDevTools({}, "darwin", "24.6.0")).toBe(true);
		expect(shouldAutoOpenDevTools({}, "darwin", "25.0.0")).toBe(false);
		expect(shouldAutoOpenDevTools({}, "darwin", "26.1.0")).toBe(false);
		expect(shouldAutoOpenDevTools({}, "darwin", "")).toBe(false);
		expect(shouldAutoOpenDevTools({}, "darwin", "beta")).toBe(false);
	});

	it("DEV3_DEVTOOLS=1/0 force it on/off; other values are ignored", () => {
		expect(shouldAutoOpenDevTools({ DEV3_DEVTOOLS: "1" }, "darwin", "25.6.0")).toBe(true);
		expect(shouldAutoOpenDevTools({ DEV3_DEVTOOLS: "0" }, "linux", "6.8.0")).toBe(false);
		expect(shouldAutoOpenDevTools({ DEV3_DEVTOOLS: "0" }, "darwin", "24.6.0")).toBe(false);
		expect(shouldAutoOpenDevTools({ DEV3_DEVTOOLS: "yes" }, "darwin", "25.6.0")).toBe(false);
		expect(shouldAutoOpenDevTools({ DEV3_DEVTOOLS: "" }, "darwin", "24.6.0")).toBe(true);
	});
});
