import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../rpc", () => ({ api: { request: { reportTaskActivity: vi.fn(async () => {}), setActiveContext: vi.fn() } } }));
import { api } from "../../rpc";
import { useTaskActivity } from "../useTaskActivity";

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("task activity reporting", () => {
	it("reports activity on plain HTTP origins without native randomUUID", () => {
		const nativeRandomUUID = crypto.randomUUID;
		Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
		try { renderHook(() => useTaskActivity("task")); } finally {
			Object.defineProperty(crypto, "randomUUID", { configurable: true, value: nativeRandomUUID });
		}
		expect(api.request.reportTaskActivity).toHaveBeenCalledWith(expect.objectContaining({ clientId: expect.stringMatching(/^[0-9a-f-]{36}$/), taskId: "task" }));
	});

	it("keeps a focused reader awake without pointer or keyboard activity", () => {
		renderHook(() => useTaskActivity("task"));
		act(() => { vi.advanceTimersByTime(60_000); });
		expect(api.request.reportTaskActivity).toHaveBeenCalledTimes(7);
		expect(api.request.reportTaskActivity).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task", focused: true }));
		expect(api.request.setActiveContext).not.toHaveBeenCalled();
	});

	it("does not keep a background task awake", () => {
		vi.mocked(document.hasFocus).mockReturnValue(false);
		renderHook(() => useTaskActivity("task"));
		act(() => { vi.advanceTimersByTime(60_000); });
		expect(api.request.reportTaskActivity).toHaveBeenCalledTimes(1);
		expect(api.request.reportTaskActivity).toHaveBeenLastCalledWith(expect.objectContaining({ focused: false }));
	});

	it("releases the viewer on blur and immediately reports returning focus", () => {
		renderHook(() => useTaskActivity("task"));
		vi.mocked(document.hasFocus).mockReturnValue(false);
		act(() => { window.dispatchEvent(new Event("blur")); });
		expect(api.request.reportTaskActivity).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task", focused: false }));
		vi.mocked(document.hasFocus).mockReturnValue(true);
		act(() => { window.dispatchEvent(new Event("focus")); });
		expect(api.request.reportTaskActivity).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task", focused: true }));
	});

	it("releases a closed task and stops its heartbeat", () => {
		const { unmount } = renderHook(() => useTaskActivity("task"));
		unmount();
		expect(api.request.reportTaskActivity).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: null, focused: false }));
		const calls = vi.mocked(api.request.reportTaskActivity).mock.calls.length;
		act(() => { vi.advanceTimersByTime(60_000); });
		expect(api.request.reportTaskActivity).toHaveBeenCalledTimes(calls);
	});
});
