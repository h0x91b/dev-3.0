import { afterEach, describe, expect, it } from "vitest";
import { createBoard, makeTask, recordingPorts, type Board } from "./board-operations-harness";

// Task metadata through the shared operation, on a real temp board: real data.ts,
// real file lock, a recording push port. No data or socket mocks.

const originalHome = process.env.HOME;
let board: Board | null = null;

afterEach(() => {
	board?.cleanup();
	board = null;
	process.env.HOME = originalHome;
});

async function ops() {
	return {
		meta: await import("../board-operations/task-metadata"),
		types: await import("../board-operations/types"),
		data: await import("../data"),
	};
}

describe("board operations — title rules and the actor", () => {
	it("a user title marks the title user-edited; an agent title does not", async () => {
		board = await createBoard({ tasks: [makeTask(), makeTask({ id: "task-2", seq: 2 })] });
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const byUser = await meta.updateTaskMetadata(ports, board.project, "task-1", { title: { value: "  Mine  " } }, types.USER_ACTOR);
		const byAgent = await meta.updateTaskMetadata(ports, board.project, "task-2", { title: { value: "Agent's" } }, types.AGENT_ACTOR);

		expect(byUser.task).toMatchObject({ customTitle: "Mine", titleEditedByUser: true });
		expect(byAgent.task.customTitle).toBe("Agent's");
		expect(byAgent.task.titleEditedByUser).toBeFalsy();
	});

	it("an agent cannot overwrite a user-edited title without force: guardRejected, no write, no push", async () => {
		board = await createBoard({ tasks: [makeTask({ customTitle: "User's", titleEditedByUser: true })] });
		const { meta, types } = await ops();
		const ports = recordingPorts();
		const inode = board.tasksInode();

		const refused = await meta.updateTaskMetadata(ports, board.project, "task-1", { title: { value: "Agent's" } }, types.AGENT_ACTOR);

		expect(refused).toMatchObject({ verdict: "guardRejected", rejected: ["title"] });
		expect(refused.task.customTitle).toBe("User's");
		expect(board.tasksInode()).toBe(inode);
		expect(ports.pushes).toEqual([]);

		const forced = await meta.updateTaskMetadata(ports, board.project, "task-1", { title: { value: "Agent's", force: true } }, types.AGENT_ACTOR);
		expect(forced).toMatchObject({ verdict: "applied", rejected: [] });
		expect(forced.task.customTitle).toBe("Agent's");
	});

	it("a refused title does not block the rest of the same change", async () => {
		board = await createBoard({ tasks: [makeTask({ customTitle: "User's", titleEditedByUser: true })] });
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const result = await meta.updateTaskMetadata(ports, board.project, "task-1", {
			title: { value: "Agent's" },
			overview: "progress",
		}, types.AGENT_ACTOR);

		expect(result).toMatchObject({ verdict: "applied", rejected: ["title"] });
		expect(result.task).toMatchObject({ customTitle: "User's", overview: "progress" });
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated"]);
	});

	it("clearing a title recomputes the auto title from the description, for either actor", async () => {
		board = await createBoard({
			tasks: [
				makeTask({ customTitle: "User's", titleEditedByUser: true, title: "stale", description: "Fix the login race" }),
				makeTask({ id: "task-2", seq: 2, customTitle: "Agent's", title: "stale", description: "Ship the report" }),
			],
		});
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const byUser = await meta.updateTaskMetadata(ports, board.project, "task-1", { title: { value: null } }, types.USER_ACTOR);
		const byAgent = await meta.updateTaskMetadata(ports, board.project, "task-2", { title: { value: "" } }, types.AGENT_ACTOR);

		expect(byUser.task).toMatchObject({ customTitle: null, titleEditedByUser: false, title: "Fix the login race" });
		expect(byAgent.task).toMatchObject({ customTitle: null, titleEditedByUser: false, title: "Ship the report" });
	});

	it("a description change recomputes the auto title only when no custom title exists", async () => {
		board = await createBoard({ tasks: [makeTask(), makeTask({ id: "task-2", seq: 2, customTitle: "Kept" })] });
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const plain = await meta.updateTaskMetadata(ports, board.project, "task-1", { description: "New brief" }, types.AGENT_ACTOR);
		const custom = await meta.updateTaskMetadata(ports, board.project, "task-2", { description: "New brief" }, types.AGENT_ACTOR);

		expect(plain.task.title).toBe("New brief");
		expect(custom.task).toMatchObject({ customTitle: "Kept", title: "Board ops task" });
	});

	it("a real title or description takes a task out of scratch; the placeholder does not", async () => {
		board = await createBoard({
			tasks: [
				makeTask({ scratch: true, description: "Scratch — 14:32" }),
				makeTask({ id: "task-2", seq: 2, scratch: true, description: "Scratch — 14:32" }),
				makeTask({ id: "task-3", seq: 3, scratch: true, description: "Scratch — 14:32" }),
			],
		});
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const titled = await meta.updateTaskMetadata(ports, board.project, "task-1", { title: { value: "Real" } }, types.USER_ACTOR);
		const described = await meta.updateTaskMetadata(ports, board.project, "task-2", { description: "Do the thing" }, types.AGENT_ACTOR);
		const placeholder = await meta.updateTaskMetadata(ports, board.project, "task-3", { description: "Scratch — 15:00" }, types.AGENT_ACTOR);

		expect(titled.task.scratch).toBe(false);
		expect(described.task.scratch).toBe(false);
		expect(placeholder.task.scratch).toBe(true);
	});
});

describe("board operations — one write per change", () => {
	it("type, title and description land in one write and one taskUpdated", async () => {
		board = await createBoard();
		const { meta, types, data } = await ops();
		const ports = recordingPorts();

		const result = await meta.updateTaskMetadata(ports, board.project, "task-1", {
			taskType: "coordinator",
			title: { value: "Board lead" },
			description: "PREAMBLE\n\nmy text",
		}, types.AGENT_ACTOR);

		const expected = { taskType: "coordinator", customTitle: "Board lead", description: "PREAMBLE\n\nmy text" };
		expect(result.task).toMatchObject(expected);
		// One push carrying all three fields: peers never see a role without its preamble.
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated"]);
		expect(ports.pushes[0].payload.task).toMatchObject(expected);
		expect(await data.getTask(board.project, "task-1")).toMatchObject(expected);
	});

	it("a change that matches what is stored is a no-op: no write, no push, no updatedAt bump", async () => {
		board = await createBoard({ tasks: [makeTask({ customTitle: "Same", overview: "same", manualCompletion: true })] });
		const { meta, types, data } = await ops();
		const ports = recordingPorts();
		const inode = board.tasksInode();
		const updatedAt = (await data.getTask(board.project, "task-1")).updatedAt;

		const result = await meta.updateTaskMetadata(ports, board.project, "task-1", {
			title: { value: "Same" },
			overview: " same ",
			manualCompletion: true,
		}, types.AGENT_ACTOR);

		expect(result.verdict).toBe("noop");
		expect(board.tasksInode()).toBe(inode);
		expect((await data.getTask(board.project, "task-1")).updatedAt).toBe(updatedAt);
		expect(ports.pushes).toEqual([]);
		expect(ports.clearMergeNotificationCalls).toEqual([]);
	});
});

describe("board operations — completion policy", () => {
	it("an agent flip resets the merge prompt, clears the reservation, and toasts", async () => {
		board = await createBoard({ tasks: [makeTask({ manualCompletion: false, mergeCompletionPrompt: { fingerprint: "x", decision: "not-now" } as never })] });
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const result = await meta.updateTaskMetadata(ports, board.project, "task-1", { manualCompletion: true }, types.AGENT_ACTOR);

		expect(result.task).toMatchObject({ manualCompletion: true, mergeCompletionPrompt: null });
		expect(ports.clearMergeNotificationCalls).toEqual(["task-1"]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated", "manualCompletionChanged"]);
		expect(ports.pushes[1].payload).toMatchObject({
			taskId: "task-1", projectId: "proj-1", manualCompletion: true, taskSeq: 1, taskTitle: "Board ops task", projectName: "Board Ops Project",
		});
	});

	it("a user flip does the same work but stays silent", async () => {
		board = await createBoard({ tasks: [makeTask({ manualCompletion: true })] });
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const result = await meta.updateTaskMetadata(ports, board.project, "task-1", { manualCompletion: false }, types.USER_ACTOR);

		expect(result.task.manualCompletion).toBe(false);
		expect(ports.clearMergeNotificationCalls).toEqual(["task-1"]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated"]);
	});
});

describe("board operations — overviews", () => {
	it("sets trimmed and clears to null, each door's field separately", async () => {
		board = await createBoard();
		const { meta, types } = await ops();
		const ports = recordingPorts();

		const set = await meta.updateTaskMetadata(ports, board.project, "task-1", { overview: "  agent note  ", userOverview: " mine " }, types.USER_ACTOR);
		const cleared = await meta.updateTaskMetadata(ports, board.project, "task-1", { overview: null }, types.AGENT_ACTOR);

		expect(set.task).toMatchObject({ overview: "agent note", userOverview: "mine" });
		expect(cleared.task).toMatchObject({ overview: null, userOverview: "mine" });
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated", "taskUpdated"]);
	});
});
