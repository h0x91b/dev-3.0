import { afterEach, describe, expect, it } from "vitest";
import type { TaskNote } from "../../shared/types";
import { createBoard, makeTask, recordingPorts, type Board } from "./board-operations-harness";

// Task notes through the shared operation, on a real temp board: real data.ts,
// real file lock, a recording push port. No data or socket mocks.

const originalHome = process.env.HOME;
let board: Board | null = null;

afterEach(() => {
	board?.cleanup();
	board = null;
	process.env.HOME = originalHome;
});

const note = (id: string, content: string): TaskNote => ({
	id, content, source: "user", createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z",
});

describe("board operations — notes", () => {
	it("addNote persists, takes its source from the actor, and pushes once", async () => {
		board = await createBoard();
		const notes = await import("../board-operations/task-notes");
		const { USER_ACTOR, AGENT_ACTOR } = await import("../board-operations/types");
		const data = await import("../data");
		const ports = recordingPorts();

		const byUser = await notes.addNote(ports, board.project, "task-1", "from the GUI", USER_ACTOR);
		const byAgent = await notes.addNote(ports, board.project, "task-1", "from an agent", AGENT_ACTOR);

		expect(byUser.verdict).toBe("applied");
		expect(byUser.note.source).toBe("user");
		expect(byAgent.note.source).toBe("ai");
		const stored = (await data.getTask(board.project, "task-1")).notes ?? [];
		expect(stored.map((n) => [n.content, n.source])).toEqual([["from the GUI", "user"], ["from an agent", "ai"]]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated", "taskUpdated"]);
		expect(ports.pushes[1].payload).toMatchObject({ projectId: "proj-1", task: { id: "task-1" } });
	});

	it("concurrent adds on one task keep both notes", async () => {
		board = await createBoard();
		const notes = await import("../board-operations/task-notes");
		const { AGENT_ACTOR } = await import("../board-operations/types");
		const data = await import("../data");
		const ports = recordingPorts();

		await Promise.all([
			notes.addNote(ports, board.project, "task-1", "a", AGENT_ACTOR),
			notes.addNote(ports, board.project, "task-1", "b", AGENT_ACTOR),
		]);

		const stored = (await data.getTask(board.project, "task-1")).notes ?? [];
		expect(stored.map((n) => n.content).sort()).toEqual(["a", "b"]);
	});

	it("updateNote and deleteNote apply and push", async () => {
		board = await createBoard({ tasks: [makeTask({ notes: [note("n1", "old"), note("n2", "keep")] })] });
		const notes = await import("../board-operations/task-notes");
		const data = await import("../data");
		const ports = recordingPorts();

		const updated = await notes.updateNote(ports, board.project, "task-1", "n1", "new");
		const deleted = await notes.deleteNote(ports, board.project, "task-1", "n2");

		expect(updated.verdict).toBe("applied");
		expect(deleted.verdict).toBe("applied");
		const stored = (await data.getTask(board.project, "task-1")).notes ?? [];
		expect(stored.map((n) => [n.id, n.content])).toEqual([["n1", "new"]]);
		expect(stored[0].updatedAt).not.toBe("2026-09-25T00:00:00.000Z");
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated", "taskUpdated"]);
	});

	it("an unchanged edit or a missing note is a no-op: no write, no push", async () => {
		board = await createBoard({ tasks: [makeTask({ notes: [note("n1", "same")] })] });
		const notes = await import("../board-operations/task-notes");
		const ports = recordingPorts();
		const inode = board.tasksInode();

		const results = [
			await notes.updateNote(ports, board.project, "task-1", "n1", "same"),
			await notes.updateNote(ports, board.project, "task-1", "missing", "x"),
			await notes.deleteNote(ports, board.project, "task-1", "missing"),
		];

		expect(results.map((r) => r.verdict)).toEqual(["noop", "noop", "noop"]);
		expect(board.tasksInode()).toBe(inode);
		expect(ports.pushes).toEqual([]);
	});

	it("refuses an empty note", async () => {
		board = await createBoard();
		const notes = await import("../board-operations/task-notes");
		const { USER_ACTOR } = await import("../board-operations/types");
		const ports = recordingPorts();

		await expect(notes.addNote(ports, board.project, "task-1", "", USER_ACTOR)).rejects.toThrow("content is required");
		expect(ports.pushes).toEqual([]);
	});
});

describe("board operations — production push port", () => {
	it("resolves the push hook at call time, so a hook installed after import still receives pushes", async () => {
		board = await createBoard();
		const { boardPorts } = await import("../board-operations/runtime");
		const notes = await import("../board-operations/task-notes");
		const { AGENT_ACTOR } = await import("../board-operations/types");
		const { setPushMessage } = await import("../rpc-handlers/shared-pure");
		const received: string[] = [];
		setPushMessage((name) => { received.push(name); });

		await notes.addNote(boardPorts, board.project, "task-1", "late hook", AGENT_ACTOR);

		expect(received).toEqual(["taskUpdated"]);
	});
});
