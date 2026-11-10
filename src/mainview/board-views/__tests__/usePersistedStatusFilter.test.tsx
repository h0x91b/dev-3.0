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
import { rememberFilter, resetRememberedFiltersForTests, useRememberedFilter } from "../../hooks/useRememberedFilter";
import { resetPersistedStatusFilterForTests, usePersistedStatusFilter } from "../usePersistedStatusFilter";
import type { BoardRef } from "../../../shared/board-view-state";

const getState = vi.mocked(api.request.getBoardFilterState);
const setState = vi.mocked(api.request.setBoardFilterState);

function useBoard(id: string) {
	const key = `board:${id}`;
	const board: BoardRef = { kind: "project", id };
	const [query, setQuery] = useRememberedFilter(key);
	usePersistedStatusFilter(board, key, query, setQuery);
	return { query, setQuery };
}

beforeEach(() => {
	resetRememberedFiltersForTests();
	resetPersistedStatusFilterForTests();
	getState.mockReset();
	getState.mockResolvedValue({ statuses: [] });
	setState.mockClear();
});

describe("usePersistedStatusFilter", () => {
	it("restores the saved statuses on first open", async () => {
		getState.mockResolvedValue({ statuses: ["todo", "On hold"] });
		const { result } = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(result.current.query).toBe('status:todo status:"On hold"'));
		expect(getState).toHaveBeenCalledWith({ board: { kind: "project", id: "p1" } });
		expect(setState).not.toHaveBeenCalled();
	});

	it("does not read or write on a first-visit preset, and writes once statuses change", async () => {
		rememberFilter("board:p1", "epic:x");
		const { result } = renderHook(() => useBoard("p1"));
		await act(async () => {});
		expect(getState).not.toHaveBeenCalled();
		expect(setState).not.toHaveBeenCalled();
		expect(result.current.query).toBe("epic:x");
		act(() => result.current.setQuery("epic:x status:todo"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		expect(setState.mock.calls[0][0].state).toEqual({ statuses: ["todo"] });
	});

	it("ignores a read that lands after the user edited the query", async () => {
		let resolveRead!: (v: { statuses: string[] }) => void;
		getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
		const { result } = renderHook(() => useBoard("p1"));
		act(() => result.current.setQuery("my text"));
		await act(async () => resolveRead({ statuses: ["todo"] }));
		expect(result.current.query).toBe("my text");
		await act(async () => {});
		expect(setState).not.toHaveBeenCalled();
	});

	it("saves statuses the user typed while the read was in flight", async () => {
		let resolveRead!: (v: { statuses: string[] }) => void;
		getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
		const { result } = renderHook(() => useBoard("p1"));
		act(() => result.current.setQuery("status:todo"));
		await act(async () => resolveRead({ statuses: ["done"] }));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		expect(setState.mock.calls[0][0].state).toEqual({ statuses: ["todo"] });
	});

	it("saves when statuses change, not when only free text changes", async () => {
		const { result } = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await act(async () => {});
		expect(setState).not.toHaveBeenCalled();

		act(() => result.current.setQuery("status:todo"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		expect(setState.mock.calls[0][0].state).toEqual({ statuses: ["todo"] });

		act(() => result.current.setQuery("status:todo bug"));
		act(() => result.current.setQuery("status:todo bug P1"));
		await act(async () => {});
		expect(setState).toHaveBeenCalledTimes(1);

		act(() => result.current.setQuery("bug"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(2));
		expect(setState.mock.calls[1][0].state).toEqual({ statuses: [] });
	});

	it("keeps separate boards separate", async () => {
		getState.mockImplementation(async ({ board }) => ({ statuses: board.id === "p1" ? ["todo"] : ["completed"] }));
		const a = renderHook(() => useBoard("p1"));
		const b = renderHook(() => useBoard("p2"));
		await waitFor(() => expect(a.result.current.query).toBe("status:todo"));
		await waitFor(() => expect(b.result.current.query).toBe("status:completed"));
	});

	it("opens normally when the read fails and writes nothing until statuses change", async () => {
		getState.mockRejectedValue(new Error("boom"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(warn).toHaveBeenCalled());
		await act(async () => {});
		expect(result.current.query).toBe("");
		expect(setState).not.toHaveBeenCalled();
		act(() => result.current.setQuery("status:todo"));
		await waitFor(() => expect(setState).toHaveBeenCalledTimes(1));
		warn.mockRestore();
	});

	it("neither re-reads nor re-writes a board when switching A to B to A", async () => {
		getState.mockResolvedValue({ statuses: ["todo"] });
		const { result, rerender } = renderHook(({ id }) => useBoard(id), { initialProps: { id: "p1" } });
		await waitFor(() => expect(result.current.query).toBe("status:todo"));
		rerender({ id: "p2" });
		await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
		rerender({ id: "p1" });
		await act(async () => {});
		expect(result.current.query).toBe("status:todo");
		expect(getState).toHaveBeenCalledTimes(2);
		expect(setState).not.toHaveBeenCalled();
	});
});

describe("races", () => {
	it("keeps an explicit clear after edit then return to the initial query", async () => {
		let finish!: (state: { statuses: string[] }) => void;
		getState.mockReturnValue(new Promise((r) => { finish = r; }));
		const h = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		act(() => h.result.current.setQuery("temporary"));
		act(() => h.result.current.setQuery(""));
		await act(async () => { finish({ statuses: ["todo"] }); });
		expect(h.result.current.query).toBe("");
	});

	it("saves a status edit made before hydration even if the board is left and reopened", async () => {
		let finish!: (state: { statuses: string[] }) => void;
		getState.mockReturnValue(new Promise((r) => { finish = r; }));
		const h = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		act(() => h.result.current.setQuery("status:completed"));
		h.unmount();
		await act(async () => { finish({ statuses: ["todo"] }); });
		const back = renderHook(() => useBoard("p1"));
		await act(async () => {});
		expect(back.result.current.query).toBe("status:completed");
		expect(setState).toHaveBeenCalledTimes(1);
		expect(setState).toHaveBeenCalledWith({ board: { kind: "project", id: "p1" }, state: { statuses: ["completed"] } });
	});

	it("sends one write at a time and the newest list lands last", async () => {
		const pending: Array<() => void> = [];
		let disk: string[] = [];
		setState.mockImplementation(({ state }) => new Promise((resolve) => pending.push(() => { disk = state.statuses; resolve(state); })));
		const h = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await act(async () => {});
		for (const q of ["status:todo", "status:review-by-user", "status:completed"]) {
			await act(async () => h.result.current.setQuery(q));
		}
		expect(pending).toHaveLength(1);
		await act(async () => pending[0]());
		expect(pending).toHaveLength(2);
		await act(async () => pending[1]());
		expect(pending).toHaveLength(2);
		expect(disk).toEqual(["completed"]);
		setState.mockImplementation(async ({ state }) => state);
	});

	it("re-reads and restores on remount when an unsettled board was left before the read landed", async () => {
		let finish!: (state: { statuses: string[] }) => void;
		getState.mockReturnValueOnce(new Promise((r) => { finish = r; }));
		const first = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
		first.unmount();
		await act(async () => { finish({ statuses: ["done"] }); });
		getState.mockResolvedValue({ statuses: ["todo"] });
		const back = renderHook(() => useBoard("p1"));
		await waitFor(() => expect(back.result.current.query).toBe("status:todo"));
		expect(getState).toHaveBeenCalledTimes(2);
		expect(setState).not.toHaveBeenCalled();
	});
});

