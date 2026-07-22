import { describe, expect, it, vi } from "vitest";
import { handleMenuAction } from "../menuRouter";
import type { AppState } from "../state";

// These palette actions only dispatch a window CustomEvent (App.tsx opens the
// palette) — they never touch state, dispatch, or locale, so a bare ctx is fine.
const ctx = {
	state: { route: { screen: "dashboard" } } as unknown as AppState,
	dispatch: vi.fn(),
	setLocale: vi.fn(),
};

describe("handleMenuAction — palette openers", () => {
	it("dispatches menu:open-project-switch for open-project-switch", async () => {
		const listener = vi.fn();
		window.addEventListener("menu:open-project-switch", listener);
		await handleMenuAction("open-project-switch", ctx);
		window.removeEventListener("menu:open-project-switch", listener);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("dispatches menu:open-command-palette for open-command-palette", async () => {
		const listener = vi.fn();
		window.addEventListener("menu:open-command-palette", listener);
		await handleMenuAction("open-command-palette", ctx);
		window.removeEventListener("menu:open-command-palette", listener);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("handleMenuAction — toggle-streamer-mode", () => {
	it("flips streamer mode on and off (html attribute + persistence)", async () => {
		localStorage.removeItem("dev3-streamer-mode");
		delete document.documentElement.dataset.streamer;
		await handleMenuAction("toggle-streamer-mode", ctx);
		expect(document.documentElement.dataset.streamer).toBe("on");
		expect(localStorage.getItem("dev3-streamer-mode")).toBe("on");
		await handleMenuAction("toggle-streamer-mode", ctx);
		expect(document.documentElement.dataset.streamer).toBeUndefined();
		expect(localStorage.getItem("dev3-streamer-mode")).toBe("off");
	});
});

describe("handleMenuAction — term-close-pane", () => {
	const taskCtx = {
		state: { route: { screen: "task", projectId: "p1", taskId: "task-42" } } as unknown as AppState,
		dispatch: vi.fn(),
		setLocale: vi.fn(),
	};

	it("opens the two-step pane picker for the current task", async () => {
		const listener = vi.fn();
		window.addEventListener("dev3:closePanePicker", listener);
		await handleMenuAction("term-close-pane", taskCtx);
		window.removeEventListener("dev3:closePanePicker", listener);
		expect(listener).toHaveBeenCalledTimes(1);
		expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: "task-42" });
	});

	it("is a no-op when no task is focused", async () => {
		const listener = vi.fn();
		window.addEventListener("dev3:closePanePicker", listener);
		await handleMenuAction("term-close-pane", ctx);
		window.removeEventListener("dev3:closePanePicker", listener);
		expect(listener).not.toHaveBeenCalled();
	});
});
