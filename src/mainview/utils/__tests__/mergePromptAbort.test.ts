import { createMergePromptAbort } from "../mergePromptAbort";

function fireTaskUpdated(detail: unknown) {
	window.dispatchEvent(new CustomEvent("rpc:taskUpdated", { detail }));
}
function fireMergeResolved(detail: unknown) {
	window.dispatchEvent(new CustomEvent("rpc:mergePromptResolved", { detail }));
}

describe("createMergePromptAbort", () => {
	it("aborts when the task is completed (worktree dropped) elsewhere", () => {
		const { signal, cleanup } = createMergePromptAbort("t1");
		expect(signal.aborted).toBe(false);
		fireTaskUpdated({ task: { id: "t1", status: "completed", worktreePath: null } });
		expect(signal.aborted).toBe(true);
		cleanup();
	});

	it("aborts when the merge prompt is declined elsewhere", () => {
		const { signal, cleanup } = createMergePromptAbort("t1");
		fireMergeResolved({ taskId: "t1", projectId: "p1", fingerprint: "fp" });
		expect(signal.aborted).toBe(true);
		cleanup();
	});

	it("ignores updates for a different task", () => {
		const { signal, cleanup } = createMergePromptAbort("t1");
		fireTaskUpdated({ task: { id: "t2", status: "completed", worktreePath: null } });
		fireMergeResolved({ taskId: "t2" });
		expect(signal.aborted).toBe(false);
		cleanup();
	});

	it("does not abort while the task stays in review with a live worktree", () => {
		const { signal, cleanup } = createMergePromptAbort("t1");
		fireTaskUpdated({ task: { id: "t1", status: "review-by-user", worktreePath: "/w" } });
		expect(signal.aborted).toBe(false);
		cleanup();
	});

	it("stops listening after cleanup", () => {
		const { signal, cleanup } = createMergePromptAbort("t1");
		cleanup();
		fireTaskUpdated({ task: { id: "t1", status: "completed", worktreePath: null } });
		fireMergeResolved({ taskId: "t1" });
		expect(signal.aborted).toBe(false);
	});
});
