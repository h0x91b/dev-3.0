/**
 * QA (independent) tests for the named-view part of useBoardViewState: a read that
 * lands after the user saved, StrictMode, and session memory keyed per board.
 */
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getBoardViewState: vi.fn(),
			setBoardViewState: vi.fn(),
			changeNamedBoardView: vi.fn(),
		},
	},
}));

import { api } from "../../rpc";
import { resetBoardViewStateCacheForTests, useBoardViewState } from "../useBoardViewState";
import { applyNamedViewChange, defaultBoardViewState, normalizeBoardViewState, withNamedViewsFrom, type BoardViewState } from "../../../shared/board-view-state";

const getState = vi.mocked(api.request.getBoardViewState);
const setState = vi.mocked(api.request.setBoardViewState);
const changeNamed = vi.mocked(api.request.changeNamedBoardView);
/** The fake host file, emulating src/bun/board-view-state-data.ts. */
let disk: BoardViewState = defaultBoardViewState();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const board = { kind: "project", id: "p1" } as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function diskWithNamed(name: string): BoardViewState {
	const base = defaultBoardViewState();
	return { ...base, savedViews: [...base.savedViews, { id: "sv-named-1", name, viewType: "builtin:kanban", query: "old", layouts: {} }] };
}

const lastSaved = () => disk;
const writes = () => setState.mock.calls.length + changeNamed.mock.calls.length;
const namesIn = (state: BoardViewState) => state.savedViews.filter((v) => v.name !== null).map((v) => v.name);

beforeEach(() => {
	resetBoardViewStateCacheForTests();
	getState.mockReset();
	disk = defaultBoardViewState();
	setState.mockReset().mockImplementation(async ({ state }) => clone(disk = withNamedViewsFrom(normalizeBoardViewState(clone(state)), disk)));
	changeNamed.mockReset().mockImplementation(async ({ change }) => clone(disk = normalizeBoardViewState(applyNamedViewChange(disk, clone(change)))));
});

describe("QA: a read that lands after the user saved a named view", () => {
	it("does not wipe the view the user just saved", async () => {
		const read = deferred<BoardViewState>();
		getState.mockReturnValue(read.promise);
		const { result } = renderHook(() => useBoardViewState(board, "wide"));
		act(() => result.current.saveNamed("Mine", "q"));
		expect(result.current.namedViews.map((v) => v.name)).toEqual(["Mine"]);
		await act(async () => { read.resolve(defaultBoardViewState()); await read.promise; });
		expect(result.current.namedViews.map((v) => v.name)).toEqual(["Mine"]);
		expect(result.current.appliedNamedId).toBe(result.current.namedViews[0].id);
	});

	it("does not drop the named views already on disk when the user saves before the read lands", async () => {
		// After the 3s read timeout the board renders on the default state, so a user can
		// save a view before the file arrives. The late read is then ignored and the save
		// that already went out overwrote the file without the older named views.
		disk = diskWithNamed("Old");
		const read = deferred<BoardViewState>();
		getState.mockReturnValue(read.promise);
		const { result } = renderHook(() => useBoardViewState(board, "wide"));
		act(() => result.current.saveNamed("Mine", "q"));
		await waitFor(() => expect(changeNamed).toHaveBeenCalled());
		await act(async () => { read.resolve(clone(disk)); await read.promise; });
		expect(namesIn(lastSaved()).sort()).toEqual(["Mine", "Old"]);
		// The renderer adopts the host's answer, so the screen lists both too.
		await waitFor(() => expect(result.current.namedViews.map((v) => v.name).sort()).toEqual(["Mine", "Old"]));
	});
});

describe("QA: StrictMode", () => {
	it("saveNamed under StrictMode adds one view and saves once", async () => {
		getState.mockResolvedValue(defaultBoardViewState());
		const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
		const { result } = renderHook(() => useBoardViewState(board, "wide"), { wrapper });
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await act(async () => { await Promise.resolve(); });
		act(() => result.current.saveNamed("Once", ""));
		await waitFor(() => expect(changeNamed).toHaveBeenCalledTimes(1));
		expect(setState).not.toHaveBeenCalled();
		expect(namesIn(lastSaved())).toEqual(["Once"]);
		expect(getState).toHaveBeenCalledTimes(1);
	});
});

describe("QA: session memory per board and form factor", () => {
	it("an applied id on a project board does not leak to a space board with the same id", async () => {
		disk = diskWithNamed("Shared");
		getState.mockImplementation(async () => clone(disk));
		const project = renderHook(() => useBoardViewState(board, "wide"));
		await waitFor(() => expect(project.result.current.namedViews).toHaveLength(1));
		act(() => { project.result.current.applyNamed("sv-named-1"); });
		expect(project.result.current.appliedNamedId).toBe("sv-named-1");
		const space = renderHook(() => useBoardViewState({ kind: "space", id: "p1" }, "wide"));
		await waitFor(() => expect(space.result.current.namedViews).toHaveLength(1));
		expect(space.result.current.appliedNamedId).toBeNull();
	});

	it("applyNamed of an unknown id returns null and changes nothing", async () => {
		disk = diskWithNamed("Shared");
		getState.mockImplementation(async () => clone(disk));
		const { result } = renderHook(() => useBoardViewState(board, "wide"));
		await waitFor(() => expect(result.current.namedViews).toHaveLength(1));
		let query: string | null = "x";
		act(() => { query = result.current.applyNamed("nope"); });
		expect(query).toBeNull();
		expect(result.current.appliedNamedId).toBeNull();
		expect(writes()).toBe(0);
	});

	it("a re-apply of an unmodified view does not write the file again", async () => {
		disk = diskWithNamed("Shared");
		getState.mockImplementation(async () => clone(disk));
		const { result } = renderHook(() => useBoardViewState(board, "wide"));
		await waitFor(() => expect(result.current.namedViews).toHaveLength(1));
		act(() => { result.current.applyNamed("sv-named-1"); });
		const before = writes();
		act(() => { result.current.applyNamed("sv-named-1"); });
		expect(writes()).toBe(before);
	});
});

describe("QA: optimistic changes and the host's answer", () => {
	it("two quick edits: the first answer does not roll back the second", async () => {
		getState.mockImplementation(async () => clone(disk));
		const first = deferred<BoardViewState>();
		const { result } = renderHook(() => useBoardViewState(board, "wide"));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await act(async () => { await Promise.resolve(); });
		changeNamed.mockImplementationOnce(async ({ change }) => {
			disk = normalizeBoardViewState(applyNamedViewChange(disk, clone(change)));
			const answer = clone(disk);
			await first.promise;
			return answer;
		});
		act(() => result.current.saveNamed("Draft", ""));
		const id = result.current.namedViews[0].id;
		act(() => result.current.renameNamed(id, "Final"));
		expect(result.current.namedViews.map((v) => v.name)).toEqual(["Final"]);
		await act(async () => { first.resolve(defaultBoardViewState()); await first.promise; await Promise.resolve(); await Promise.resolve(); });
		await waitFor(() => expect(changeNamed).toHaveBeenCalledTimes(2));
		expect(result.current.namedViews.map((v) => v.name)).toEqual(["Final"]);
		expect(namesIn(disk)).toEqual(["Final"]);
	});

	it("a plain layout save adopts a named view another window saved", async () => {
		getState.mockImplementation(async () => clone(disk));
		const { result } = renderHook(() => useBoardViewState(board, "wide"));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		await act(async () => { await Promise.resolve(); });
		disk = diskWithNamed("Elsewhere");
		act(() => result.current.setLayout("builtin:kanban", { collapsed: true }));
		await waitFor(() => expect(result.current.namedViews.map((v) => v.name)).toEqual(["Elsewhere"]));
		expect(result.current.layout("builtin:kanban")).toEqual({ collapsed: true });
	});

	it("a rejected named change tells the host page and falls back to the file", async () => {
		getState.mockImplementation(async () => clone(disk));
		changeNamed.mockRejectedValue(new Error("lock timeout"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const onNamedChangeFailed = vi.fn();
		const { result } = renderHook(() => useBoardViewState(board, "wide", { onNamedChangeFailed }));
		await waitFor(() => expect(getState).toHaveBeenCalled());
		act(() => result.current.saveNamed("Kept", ""));
		expect(result.current.namedViews.map((v) => v.name)).toEqual(["Kept"]);
		await waitFor(() => expect(onNamedChangeFailed).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(result.current.namedViews).toEqual([]));
		warn.mockRestore();
	});

	it("delete clears the applied marker in both form factors", async () => {
		disk = diskWithNamed("Both");
		getState.mockImplementation(async () => clone(disk));
		const wide = renderHook(() => useBoardViewState(board, "wide"));
		const narrow = renderHook(() => useBoardViewState(board, "narrow"));
		await waitFor(() => expect(wide.result.current.namedViews).toHaveLength(1));
		act(() => { wide.result.current.applyNamed("sv-named-1"); });
		act(() => { narrow.result.current.applyNamed("sv-named-1"); });
		act(() => narrow.result.current.deleteNamed("sv-named-1"));
		expect(wide.result.current.appliedNamedId).toBeNull();
		expect(narrow.result.current.appliedNamedId).toBeNull();
	});

	it("deleting on one board leaves the applied marker of a same-id view on another board", async () => {
		// Applied keys are `<kind>:<id>:<formFactor>`; delete matches the `<kind>:<id>:` prefix.
		disk = diskWithNamed("Same");
		getState.mockImplementation(async () => clone(disk));
		const a = renderHook(() => useBoardViewState({ kind: "project", id: "p1" }, "wide"));
		const b = renderHook(() => useBoardViewState({ kind: "project", id: "p10" }, "wide"));
		await waitFor(() => expect(b.result.current.namedViews).toHaveLength(1));
		await waitFor(() => expect(a.result.current.namedViews).toHaveLength(1));
		act(() => { a.result.current.applyNamed("sv-named-1"); });
		act(() => { b.result.current.applyNamed("sv-named-1"); });
		act(() => a.result.current.deleteNamed("sv-named-1"));
		expect(b.result.current.appliedNamedId).toBe("sv-named-1");
	});
});
