import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { startAfterCandidates } from "../StartAfterPicker";

function task(o: Partial<Task> & { id: string }): Task {
	return { projectId: "p1", seq: 1, status: "todo", groupId: null, variantIndex: null, ...o } as Task;
}

describe("startAfterCandidates", () => {
	const self = task({ id: "me", seq: 5 });

	it("offers a variant group once, by its lowest variant", () => {
		const v2 = task({ id: "a2", seq: 3, groupId: "g", variantIndex: 2, status: "in-progress" });
		const v1 = task({ id: "a1", seq: 3, groupId: "g", variantIndex: 1, status: "in-progress" });
		expect(startAfterCandidates(self, [self, v2, v1]).map((t) => t.id)).toEqual(["a1"]);
	});

	it("leaves out the task itself, its own variants, cancelled tasks and tasks already waiting on it", () => {
		const mine = task({ id: "me", seq: 5, groupId: "own", variantIndex: 1 });
		const sibling = task({ id: "me2", seq: 5, groupId: "own", variantIndex: 2 });
		const waiter = task({ id: "w", seq: 6, launchAfter: { taskId: "me", seq: 5, until: "completed", armedAt: "x" } });
		const gone = task({ id: "c", seq: 7, status: "cancelled" });
		const ok = task({ id: "ok", seq: 8 });
		expect(startAfterCandidates(mine, [mine, sibling, waiter, gone, ok]).map((t) => t.id)).toEqual(["ok"]);
	});

	it("lists only open tasks, newest first, leaving out completed ones", () => {
		const done = task({ id: "d", seq: 9, status: "completed" });
		const older = task({ id: "o", seq: 2, status: "in-progress" });
		const newer = task({ id: "n", seq: 4 });
		expect(startAfterCandidates(self, [done, older, newer]).map((t) => t.id)).toEqual(["n", "o"]);
	});
});
