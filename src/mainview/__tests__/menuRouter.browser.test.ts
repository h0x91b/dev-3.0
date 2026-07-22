import { describe, expect, it, vi, beforeEach } from "vitest";

const { getAppVersion } = vi.hoisted(() => ({ getAppVersion: vi.fn() }));

vi.mock("../rpc", () => ({
	isElectrobun: false,
	api: { request: { getAppVersion } },
}));

import { handleMenuAction, BROWSER_HANDLED_ACTIONS } from "../menuRouter";
import type { AppState } from "../state";

function makeCtx() {
	return {
		state: { route: { screen: "dashboard" } } as unknown as AppState,
		dispatch: vi.fn(),
		setLocale: vi.fn(),
	};
}

beforeEach(() => {
	getAppVersion.mockReset();
	getAppVersion.mockResolvedValue({ version: "9.9.9", channel: "dev", buildChannel: "dev" });
});

describe("BROWSER_HANDLED_ACTIONS", () => {
	it("contains actions the router executes in the browser", () => {
		for (const a of ["open-new-task", "task-move-todo", "term-split-h", "about", "help-github", "gauge-demo", "native-pane-layout-lab", "view-dashboard"]) {
			expect(BROWSER_HANDLED_ACTIONS.has(a)).toBe(true);
		}
	});

	it("excludes bun-only / unhandled actions", () => {
		for (const a of ["new-window", "check-for-updates", "toggle-devtools", "zoom-in", "open-logs-directory", "show-remote-qr", "task-rename", "task-mark-completed"]) {
			expect(BROWSER_HANDLED_ACTIONS.has(a)).toBe(false);
		}
	});
});

describe("handleMenuAction — browser-only actions", () => {
	it("opens the GitHub repo in a new tab for help-github", async () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		await handleMenuAction("help-github", makeCtx());
		expect(open).toHaveBeenCalledWith("https://github.com/h0x91b/dev-3.0", "_blank", "noopener,noreferrer");
		open.mockRestore();
	});

	it("navigates to the gauge demo for gauge-demo", async () => {
		const ctx = makeCtx();
		await handleMenuAction("gauge-demo", ctx);
		expect(ctx.dispatch).toHaveBeenCalledWith({ type: "navigate", route: { screen: "gauge-demo" } });
	});

	it("navigates to the native pane layout lab", async () => {
		const ctx = makeCtx();
		await handleMenuAction("native-pane-layout-lab", ctx);
		expect(ctx.dispatch).toHaveBeenCalledWith({ type: "navigate", route: { screen: "native-pane-layout-lab" } });
	});

	it("fetches the version and shows the About dialog for about", async () => {
		const listener = vi.fn();
		window.addEventListener("rpc:showAbout", listener);
		await handleMenuAction("about", makeCtx());
		window.removeEventListener("rpc:showAbout", listener);
		expect(getAppVersion).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledTimes(1);
		const detail = (listener.mock.calls[0][0] as CustomEvent).detail;
		expect(detail).toEqual({ version: "9.9.9" });
	});
});
