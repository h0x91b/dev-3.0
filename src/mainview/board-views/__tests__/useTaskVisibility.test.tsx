import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getBoardFilterState: vi.fn(),
			setBoardFilterState: vi.fn(async ({ state }) => state),
		},
	},
}));

import { api } from "../../rpc";
import { VISIBILITY_READ_TIMEOUT_MS, resetTaskVisibilityForTests, useTaskVisibility } from "../useTaskVisibility";
import type { TaskVisibility } from "../../../shared/board-filter-state";

const getState = vi.mocked(api.request.getBoardFilterState);
const setState = vi.mocked(api.request.setBoardFilterState);

beforeEach(() => {
	resetTaskVisibilityForTests();
	getState.mockReset();
	getState.mockResolvedValue({ visibility: "all" });
	setState.mockClear();
});

describe("useTaskVisibility", () => {
	it("restores the saved visibility and is not ready until then", async () => {
		getState.mockResolvedValue({ visibility: "active" });
		const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		expect(result.current.visibility).toBe("all");
		expect(result.current.ready).toBe(false);
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.visibility).toBe("active");
		expect(getState).toHaveBeenCalledWith({ board: { kind: "project", id: "p1" } });
		expect(setState).not.toHaveBeenCalled();
	});

	it("keeps each board's visibility apart", async () => {
		getState.mockImplementation(async ({ board }) => ({ visibility: board.kind === "project" ? "active" : "all" }));
		const a = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		const b = renderHook(() => useTaskVisibility({ kind: "space", id: "sp1" }));
		await waitFor(() => expect(a.result.current.visibility).toBe("active"));
		await waitFor(() => expect(b.result.current.ready).toBe(true));
		expect(b.result.current.visibility).toBe("all");
		act(() => b.result.current.setVisibility("active"));
		expect(a.result.current.visibility).toBe("active");
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		expect(setState.mock.calls[0][0]).toEqual({ board: { kind: "space", id: "sp1" }, state: { visibility: "active" } });
	});

	it("writes the new visibility and the newest value wins", async () => {
		const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await waitFor(() => expect(result.current.ready).toBe(true));
		let release!: () => void;
		setState.mockImplementationOnce(({ state }) => new Promise((r) => { release = () => r(state); }));
		act(() => result.current.setVisibility("active"));
		expect(result.current.visibility).toBe("active");
		act(() => result.current.setVisibility("all"));
		act(() => result.current.setVisibility("active"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		await act(async () => release());
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(2));
		expect(setState.mock.calls[1][0].state).toEqual({ visibility: "active" });
	});

	it("lets a set during a pending read win over the read", async () => {
		let resolveRead!: (v: { visibility: TaskVisibility }) => void;
		getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
		const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		act(() => result.current.setVisibility("all"));
		await act(async () => resolveRead({ visibility: "active" }));
		expect(result.current.visibility).toBe("all");
		expect(result.current.ready).toBe(true);
	});

	it("does not re-read when going A -> B -> A, and A is ready at once", async () => {
		getState.mockResolvedValue({ visibility: "active" });
		const { result, rerender } = renderHook(({ id }) => useTaskVisibility({ kind: "project", id }), { initialProps: { id: "p1" } });
		await waitFor(() => expect(result.current.visibility).toBe("active"));
		rerender({ id: "p2" });
		expect(result.current.ready).toBe(false);
		await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
		rerender({ id: "p1" });
		expect(result.current).toMatchObject({ visibility: "active", ready: true });
		await act(async () => {});
		expect(getState).toHaveBeenCalledTimes(2);
	});

	it("settles as all and writes nothing when the read fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getState.mockRejectedValue(new Error("boom"));
		const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(warn).toHaveBeenCalled();
		expect(result.current.visibility).toBe("all");
		expect(setState).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("settles as ready on a read that never answers, and a late success still applies", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			let resolveRead!: (v: { visibility: TaskVisibility }) => void;
			getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
			const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
			expect(result.current.ready).toBe(false);
			await act(async () => { await vi.advanceTimersByTimeAsync(VISIBILITY_READ_TIMEOUT_MS); });
			expect(result.current).toMatchObject({ visibility: "all", ready: true });
			await act(async () => resolveRead({ visibility: "active" }));
			expect(result.current.visibility).toBe("active");
		} finally {
			warn.mockRestore();
			vi.useRealTimers();
		}
	});

	it("never lets a late read overwrite the user's own choice", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			let resolveRead!: (v: { visibility: TaskVisibility }) => void;
			getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
			const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
			await act(async () => { await vi.advanceTimersByTimeAsync(VISIBILITY_READ_TIMEOUT_MS); });
			act(() => result.current.setVisibility("all"));
			await act(async () => resolveRead({ visibility: "active" }));
			expect(result.current.visibility).toBe("all");
		} finally {
			warn.mockRestore();
			vi.useRealTimers();
		}
	});

	it("retries a failed read on the next mount", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getState.mockRejectedValueOnce(new Error("boom"));
		const first = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		first.unmount();
		getState.mockResolvedValue({ visibility: "active" });
		const second = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		expect(second.result.current.ready).toBe(true);
		await waitFor(() => expect(second.result.current.visibility).toBe("active"));
		expect(getState).toHaveBeenCalledTimes(2);
		second.unmount();
		renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await act(async () => {});
		expect(getState).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("does not retry the read once the user has chosen", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getState.mockRejectedValue(new Error("boom"));
		const first = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		act(() => first.result.current.setVisibility("active"));
		first.unmount();
		const second = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await act(async () => {});
		expect(getState).toHaveBeenCalledTimes(1);
		expect(second.result.current.visibility).toBe("active");
		warn.mockRestore();
	});

	it("survives an RPC method that throws synchronously", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getState.mockImplementation(() => { throw new TypeError("not a function"); });
		const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.visibility).toBe("all");
		setState.mockImplementationOnce(() => { throw new TypeError("not a function"); });
		act(() => result.current.setVisibility("active"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		expect(result.current.visibility).toBe("active");
		warn.mockRestore();
	});

	it("keeps writing after a failed write", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = renderHook(() => useTaskVisibility({ kind: "project", id: "p1" }));
		await waitFor(() => expect(result.current.ready).toBe(true));
		setState.mockRejectedValueOnce(new Error("disk full"));
		act(() => result.current.setVisibility("active"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(warn).toHaveBeenCalled());
		act(() => result.current.setVisibility("all"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(2));
		expect(setState.mock.calls[1][0].state).toEqual({ visibility: "all" });
		warn.mockRestore();
	});
});
