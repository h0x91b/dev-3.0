import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(async ({ state }) => state),
		},
	},
}));

import { api } from "../../rpc";
import {
	VIEW_STATE_READ_TIMEOUT_MS,
	prefetchBoardViewState,
	resetBoardViewStateCacheForTests,
	useBoardViewState,
	useBoardViewStateReady,
} from "../useBoardViewState";
import { defaultBoardViewState, withViewType } from "../../../shared/board-view-state";

const getState = vi.mocked(api.request.getBoardViewState);
const board = { kind: "project", id: "p1" } as const;
// The view handle plus the readiness the board gate uses.
const useBoth = (b: { kind: "project" | "space"; id: string }) => ({ ...useBoardViewState(b, "wide"), ready: useBoardViewStateReady(b) });
const table = withViewType(defaultBoardViewState(), "wide", "builtin:table");

beforeEach(() => {
	resetBoardViewStateCacheForTests();
	getState.mockReset();
	getState.mockResolvedValue(defaultBoardViewState());
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useBoardViewState readiness", () => {
	it("is not ready until the saved state lands, then shows it", async () => {
		getState.mockResolvedValue(table);
		const { result } = renderHook(() => useBoth(board));
		expect(result.current.ready).toBe(false);
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.viewType).toBe("builtin:table");
	});

	it("is ready at once when the state is already cached", async () => {
		getState.mockResolvedValue(table);
		const first = renderHook(() => useBoth(board));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		first.unmount();
		const again = renderHook(() => useBoth(board));
		expect(again.result.current.ready).toBe(true);
		expect(again.result.current.viewType).toBe("builtin:table");
	});

	it("on a cache hit renders at once, re-reads in the background and applies a different saved value", async () => {
		getState.mockResolvedValue(table);
		const first = renderHook(() => useBoth(board));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		first.unmount();

		const tree = withViewType(defaultBoardViewState(), "wide", "builtin:tree");
		getState.mockClear();
		getState.mockResolvedValue(tree);
		const again = renderHook(() => useBoth(board));
		expect(again.result.current.ready).toBe(true);
		expect(again.result.current.viewType).toBe("builtin:table");
		await waitFor(() => expect(again.result.current.viewType).toBe("builtin:tree"));
		expect(getState).toHaveBeenCalledTimes(1);
	});

	it("a background re-read does not override a change the user made", async () => {
		getState.mockResolvedValue(table);
		const first = renderHook(() => useBoth(board));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		first.unmount();

		let resolveRead!: (v: typeof table) => void;
		getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
		const again = renderHook(() => useBoth(board));
		act(() => again.result.current.setViewType("builtin:tree"));
		await act(async () => resolveRead(withViewType(defaultBoardViewState(), "wide", "builtin:kanban")));
		expect(again.result.current.viewType).toBe("builtin:tree");
	});

	it("is ready after a failed read and keeps the default view", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getState.mockRejectedValue(new Error("down"));
		const { result } = renderHook(() => useBoth(board));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.viewType).toBe(defaultBoardViewState().savedViews[0].viewType);
		warn.mockRestore();
	});

	it("is ready after the timeout, and a late read still applies", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let resolveRead!: (v: typeof table) => void;
		getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
		const { result } = renderHook(() => useBoth(board));
		expect(result.current.ready).toBe(false);
		await act(async () => { await vi.advanceTimersByTimeAsync(VIEW_STATE_READ_TIMEOUT_MS); });
		expect(result.current.ready).toBe(true);
		await act(async () => resolveRead(table));
		expect(result.current.viewType).toBe("builtin:table");
		warn.mockRestore();
	});

	it("a read that starts while a save is in flight cannot revert the user's view", async () => {
		getState.mockResolvedValue(table);
		const first = renderHook(() => useBoth(board));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		let finishSave!: () => void;
		vi.mocked(api.request.setBoardViewState).mockImplementationOnce(({ state }) => new Promise((r) => { finishSave = () => r(state); }));
		act(() => first.result.current.setViewType("builtin:tree"));
		first.unmount();

		// The host read does not wait for the save, so it still returns the old file.
		getState.mockResolvedValue(table);
		const again = renderHook(() => useBoth(board));
		await waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
		await act(async () => {});
		expect(again.result.current.viewType).toBe("builtin:tree");
		await act(async () => finishSave());
	});

	it("a user change does not stop later background reads from applying", async () => {
		getState.mockResolvedValue(table);
		const first = renderHook(() => useBoth(board));
		await waitFor(() => expect(first.result.current.ready).toBe(true));
		act(() => first.result.current.setViewType("builtin:tree"));
		await waitFor(() => expect(api.request.setBoardViewState).toHaveBeenCalled());
		await act(async () => {});
		first.unmount();

		getState.mockResolvedValue(withViewType(defaultBoardViewState(), "wide", "builtin:kanban"));
		const again = renderHook(() => useBoth(board));
		await waitFor(() => expect(again.result.current.viewType).toBe("builtin:kanban"));
	});

	it("a timed-out read frees its slot so the next mount reads again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		getState.mockReturnValue(new Promise(() => {}));
		const first = renderHook(() => useBoth(board));
		await act(async () => { await vi.advanceTimersByTimeAsync(VIEW_STATE_READ_TIMEOUT_MS); });
		first.unmount();
		getState.mockResolvedValue(table);
		const again = renderHook(() => useBoth(board));
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		expect(getState).toHaveBeenCalledTimes(2);
		expect(again.result.current.viewType).toBe("builtin:table");
		warn.mockRestore();
	});

	it("tracks readiness per board key", async () => {
		const { result, rerender } = renderHook(({ id }) => useBoth({ kind: "project", id }), { initialProps: { id: "p1" } });
		await waitFor(() => expect(result.current.ready).toBe(true));
		getState.mockReturnValue(new Promise(() => {}));
		rerender({ id: "p2" });
		expect(result.current.ready).toBe(false);
	});

	it("reuses a prefetch: no second read when the hook mounts", async () => {
		getState.mockResolvedValue(table);
		prefetchBoardViewState(board);
		const { result } = renderHook(() => useBoth(board));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.viewType).toBe("builtin:table");
		expect(getState).toHaveBeenCalledTimes(1);
	});

	it("a change made before the read lands wins over that read", async () => {
		let resolveRead!: (v: typeof table) => void;
		getState.mockReturnValue(new Promise((r) => { resolveRead = r; }));
		const { result } = renderHook(() => useBoth(board));
		act(() => result.current.setViewType("builtin:tree"));
		await act(async () => resolveRead(table));
		expect(result.current.viewType).toBe("builtin:tree");
	});
});
