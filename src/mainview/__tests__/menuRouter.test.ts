import { describe, expect, it, vi } from "vitest";
import { handleMenuAction } from "../menuRouter";
import type { AppState } from "../state";

const { moveTaskToStatus } = vi.hoisted(() => ({ moveTaskToStatus: vi.fn((_opts: unknown) => Promise.resolve(true)) }));
vi.mock("../utils/moveTaskToStatus", () => ({ moveTaskToStatus }));

// These palette actions only dispatch a window CustomEvent (App.tsx opens the
// palette) — they never touch state, dispatch, or locale, so a bare ctx is fine.
const ctx = {
	state: { route: { screen: "dashboard" } } as unknown as AppState,
	dispatch: vi.fn(),
	setLocale: vi.fn(),
	t: ((key: string) => key) as never,
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
		t: ((key: string) => key) as never,
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

describe("handleMenuAction — task-sound probes", () => {
	it("plays the client sound through the same call the board moves use", async () => {
		const sounds = await import("../task-sounds");
		const spy = vi.spyOn(sounds, "playTaskCompletionSound").mockReturnValue(true);
		await handleMenuAction("debug-play-sound-completed", ctx);
		await handleMenuAction("debug-play-sound-cancelled", ctx);
		expect(spy.mock.calls).toEqual([["completed"], ["cancelled"]]);
		spy.mockRestore();
	});

});

describe("handleMenuAction — terminal moves from the menu", () => {
	const task = { id: "task-9", projectId: "p1", status: "in-progress" };
	const terminalCtx = {
		state: {
			route: { screen: "task", projectId: "p1", taskId: "task-9" },
			projects: [{ id: "p1", name: "demo" }],
			currentProjectTasks: [task],
		} as unknown as AppState,
		dispatch: vi.fn(),
		setLocale: vi.fn(),
		t: ((key: string) => key) as never,
	};

	it("routes Mark Completed / Mark Cancelled through the shared move helper, always confirming", async () => {
		moveTaskToStatus.mockClear();
		await handleMenuAction("task-mark-completed", terminalCtx);
		await handleMenuAction("task-mark-cancelled", terminalCtx);
		expect(moveTaskToStatus).toHaveBeenCalledTimes(2);
		expect(moveTaskToStatus.mock.calls[0][0]).toMatchObject({ newStatus: "completed", alwaysConfirm: true });
		expect(moveTaskToStatus.mock.calls[1][0]).toMatchObject({ newStatus: "cancelled", alwaysConfirm: true });
	});

	it("is a no-op when no task is focused", async () => {
		moveTaskToStatus.mockClear();
		await handleMenuAction("task-mark-completed", ctx);
		expect(moveTaskToStatus).not.toHaveBeenCalled();
	});
});
