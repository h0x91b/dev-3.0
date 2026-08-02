/**
 * The pane-state bus (seq 1382).
 *
 * Guards the two properties the split/layout latency fix rests on:
 *  1. a server response reaches every subscriber, not just the caller;
 *  2. a response that resolves out of order is dropped, so a slow poll can never
 *     reinstate the geometry an action already replaced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { api } from "../rpc";
import {
	_resetPaneStateBus,
	fetchPaneState,
	runPaneAction,
	subscribePaneState,
} from "../pane-state-bus";
import type { TaskPaneState } from "../../shared/task-panes";

vi.mock("../rpc", () => ({
	api: { request: { taskPaneState: vi.fn(), taskPaneAction: vi.fn() } },
}));

function makeState(paneCount: number): TaskPaneState {
	return {
		backend: "native",
		panes: Array.from({ length: paneCount }, (_, i) => ({
			paneId: `pane-${i + 1}`,
			index: i,
			label: "",
			active: i === 0,
			zoomed: false,
			rect: { x: 0, y: 0, width: 1, height: 1 },
		})),
		activePaneId: "pane-1",
		zoomedPaneId: null,
		layout: `layout-${paneCount}`,
		layoutPreset: null,
		capabilities: ["split"],
	};
}

/** A promise plus the handle to resolve it later, for ordering cases. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe("pane-state bus", () => {
	beforeEach(() => {
		_resetPaneStateBus();
		vi.mocked(api.request.taskPaneState).mockReset();
		vi.mocked(api.request.taskPaneAction).mockReset();
	});

	it("delivers an action's own response to every subscriber", async () => {
		const state = makeState(3);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(state);
		const first = vi.fn();
		const second = vi.fn();
		subscribePaneState("task-1", first);
		subscribePaneState("task-1", second);

		await runPaneAction("task-1", { kind: "splitH" });

		expect(first).toHaveBeenCalledWith(state);
		expect(second).toHaveBeenCalledWith(state);
	});

	it("delivers a read's response the same way", async () => {
		const state = makeState(2);
		vi.mocked(api.request.taskPaneState).mockResolvedValue(state);
		const seen = vi.fn();
		subscribePaneState("task-1", seen);

		await fetchPaneState("task-1");

		expect(seen).toHaveBeenCalledWith(state);
	});

	it("drops a poll that was issued first but resolves after a later action", async () => {
		const stale = makeState(2);
		const fresh = makeState(3);
		const slowPoll = deferred<TaskPaneState>();
		vi.mocked(api.request.taskPaneState).mockReturnValue(slowPoll.promise);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(fresh);
		const seen = vi.fn();
		subscribePaneState("task-1", seen);

		const pollDone = fetchPaneState("task-1");   // ticket 1, still in flight
		await runPaneAction("task-1", { kind: "splitH" }); // ticket 2, lands first
		slowPoll.resolve(stale);
		await pollDone;

		expect(seen).toHaveBeenCalledTimes(1);
		expect(seen).toHaveBeenCalledWith(fresh);
	});

	it("keeps one task's state out of another task's subscribers", async () => {
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(makeState(2));
		const other = vi.fn();
		subscribePaneState("task-2", other);

		await runPaneAction("task-1", { kind: "splitH" });

		expect(other).not.toHaveBeenCalled();
	});

	it("stops delivering after unsubscribe", async () => {
		vi.mocked(api.request.taskPaneState).mockResolvedValue(makeState(2));
		const seen = vi.fn();
		subscribePaneState("task-1", seen)();

		await fetchPaneState("task-1");

		expect(seen).not.toHaveBeenCalled();
	});

	it("still returns the response to its own caller when it is stale", async () => {
		const stale = makeState(2);
		const fresh = makeState(4);
		const slowPoll = deferred<TaskPaneState>();
		vi.mocked(api.request.taskPaneState).mockReturnValue(slowPoll.promise);
		vi.mocked(api.request.taskPaneAction).mockResolvedValue(fresh);

		const pollDone = fetchPaneState("task-1");
		await runPaneAction("task-1", { kind: "layoutCycle" });
		slowPoll.resolve(stale);

		await expect(pollDone).resolves.toBe(stale);
	});
});
