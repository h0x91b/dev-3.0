import { describe, expect, it } from "vitest";
import { selfPaneId } from "../pane-env";

describe("selfPaneId", () => {
	it("prefers the native pane id over a TMUX_PANE that leaked into a native pane", () => {
		expect(selfPaneId({ DEV3_PANE_ID: " pane-3 ", TMUX_PANE: "%9" })).toBe("pane-3");
	});

	it("falls back to the tmux pane, and to null when neither names one", () => {
		expect(selfPaneId({ TMUX_PANE: "%9" })).toBe("%9");
		expect(selfPaneId({ DEV3_PANE_ID: " ", TMUX_PANE: "%9" })).toBe("%9");
		expect(selfPaneId({})).toBeNull();
	});
});
