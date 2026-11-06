import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { restoreFocusAfterViewer } from "../viewer-focus";
import { subscribeTaskTerminalFocus } from "../../terminal-focus-request";

describe("restoreFocusAfterViewer", () => {
	beforeEach(() => {
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("asks the task terminal for focus when its workspace is on screen", () => {
		const onRequest = vi.fn();
		const unsubscribe = subscribeTaskTerminalFocus("t1", onRequest);
		const fallback = vi.fn();
		restoreFocusAfterViewer(() => ({ screen: "task", projectId: "p1", taskId: "t1" }), "t1", fallback);
		unsubscribe();
		expect(onRequest).toHaveBeenCalledTimes(1);
		expect(onRequest).toHaveBeenCalledWith({ currentPane: true });
		expect(fallback).not.toHaveBeenCalled();
	});

	it("runs the fallback and requests nothing on another route", () => {
		const onRequest = vi.fn();
		const unsubscribe = subscribeTaskTerminalFocus("t1", onRequest);
		const fallback = vi.fn();
		restoreFocusAfterViewer(() => ({ screen: "task", projectId: "p1", taskId: "t2" }), "t1", fallback);
		restoreFocusAfterViewer(() => ({ screen: "dashboard" }), "t1", fallback);
		unsubscribe();
		expect(onRequest).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledTimes(2);
	});
});
