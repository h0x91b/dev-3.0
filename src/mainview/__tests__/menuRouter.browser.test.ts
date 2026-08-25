import { describe, expect, it, vi, beforeEach } from "vitest";

const { getAppVersion, taskPaneAction } = vi.hoisted(() => ({
	getAppVersion: vi.fn(),
	taskPaneAction: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../rpc", () => ({
	isElectrobun: false,
	api: { request: { getAppVersion, taskPaneAction } },
}));

import { handleMenuAction, BROWSER_HANDLED_ACTIONS } from "../menuRouter";
import type { AppState } from "../state";

function makeCtx() {
	return {
		state: { route: { screen: "dashboard" } } as unknown as AppState,
		dispatch: vi.fn(),
		setLocale: vi.fn(),
		t: ((key: string) => key) as never,
	};
}

beforeEach(() => {
	getAppVersion.mockReset();
	getAppVersion.mockResolvedValue({ version: "9.9.9", channel: "dev", buildChannel: "dev" });
});

describe("BROWSER_HANDLED_ACTIONS", () => {
	it("contains actions the router executes in the browser", () => {
		for (const a of ["open-new-task", "task-move-todo", "term-split-h", "about", "help-github", "gauge-demo", "native-pane-layout-lab", "view-dashboard", "task-mark-completed", "task-mark-cancelled"]) {
			expect(BROWSER_HANDLED_ACTIONS.has(a)).toBe(true);
		}
	});

	it("carries the pane swap items, so the browser menu bar shows them", () => {
		// An action missing from this set is HIDDEN in remote mode — the menu bar
		// reads it as bun-only. The swap items run entirely in the renderer.
		expect(BROWSER_HANDLED_ACTIONS.has("term-swap-next")).toBe(true);
		expect(BROWSER_HANDLED_ACTIONS.has("term-swap-prev")).toBe(true);
	});

	it("excludes bun-only / unhandled actions", () => {
		for (const a of ["new-window", "check-for-updates", "toggle-devtools", "zoom-in", "open-logs-directory", "show-remote-qr", "task-rename"]) {
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
		// buildChannel travels with the version. About has to tell a canary install from the
		// stable release of the same version, and the bundle's version.json never carries the
		// `+canary.<sha>` suffix that would say so on its own — this is the browser-mode path,
		// which must stay in step with the desktop one in src/bun/index.ts.
		expect(detail).toEqual({ version: "9.9.9", buildChannel: "dev" });
	});
});

describe("handleMenuAction — pane swap", () => {
	const taskCtx = {
		state: { route: { screen: "task", projectId: "p1", taskId: "task-42" } } as unknown as AppState,
		dispatch: vi.fn(),
		setLocale: vi.fn(),
		t: ((key: string) => key) as never,
	};

	it("sends swapStep for the focused task, in both directions", async () => {
		taskPaneAction.mockClear();
		await handleMenuAction("term-swap-next", taskCtx);
		await handleMenuAction("term-swap-prev", taskCtx);
		expect(taskPaneAction).toHaveBeenNthCalledWith(1, { taskId: "task-42", action: { kind: "swapStep", step: "next" } });
		expect(taskPaneAction).toHaveBeenNthCalledWith(2, { taskId: "task-42", action: { kind: "swapStep", step: "prev" } });
	});

	it("is a no-op with no task focused", async () => {
		taskPaneAction.mockClear();
		await handleMenuAction("term-swap-next", makeCtx());
		expect(taskPaneAction).not.toHaveBeenCalled();
	});
});
