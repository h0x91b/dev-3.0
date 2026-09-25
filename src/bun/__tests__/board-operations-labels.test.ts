import { afterEach, describe, expect, it } from "vitest";
import type { Label } from "../../shared/types";
import { createBoard, makeTask, recordingPorts, type Board } from "./board-operations-harness";

// Labels through the shared operation, on a real temp board: real data.ts, real
// file locks, a recording push port. No data or socket mocks.

const originalHome = process.env.HOME;
let board: Board | null = null;

afterEach(() => {
	board?.cleanup();
	board = null;
	process.env.HOME = originalHome;
});

const LABELS: Label[] = [
	{ id: "lbl-a", name: "a", color: "#ef4444" },
	{ id: "lbl-b", name: "b", color: "#14b8a6" },
];

async function ops() {
	return { labels: await import("../board-operations/labels"), data: await import("../data") };
}

describe("board operations — task labels", () => {
	it("replace/add/remove apply, dedupe, and push one taskUpdated each", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels, data } = await ops();
		const ports = recordingPorts();

		const set = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "replace", labelIds: ["lbl-a", "lbl-a"] });
		const add = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "add", labelIds: ["lbl-b", "lbl-a"] });
		const remove = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "remove", labelIds: ["lbl-a"] });

		expect([set, add, remove].map((r) => r.verdict)).toEqual(["applied", "applied", "applied"]);
		expect(set.task.labelIds).toEqual(["lbl-a"]);
		expect(add.task.labelIds).toEqual(["lbl-a", "lbl-b"]);
		expect((await data.getTask(board.project, "task-1")).labelIds).toEqual(["lbl-b"]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["taskUpdated", "taskUpdated", "taskUpdated"]);
	});

	it("refuses an introduced unknown id without writing anything", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels } = await ops();
		const ports = recordingPorts();
		const inode = board.tasksInode();

		await expect(labels.changeTaskLabels(ports, board.project, "task-1", { mode: "replace", labelIds: ["lbl-a", "ghost"] }))
			.rejects.toThrow("Label not found: ghost");
		await expect(labels.changeTaskLabels(ports, board.project, "task-1", { mode: "add", labelIds: ["ghost"] }))
			.rejects.toBeInstanceOf(labels.UnknownLabelError);

		expect(board.tasksInode()).toBe(inode);
		expect(ports.pushes).toEqual([]);
	});

	it("keeps a dangling id already on the task editable (its label was deleted elsewhere)", async () => {
		board = await createBoard({ labels: LABELS, tasks: [makeTask({ labelIds: ["gone", "lbl-a"] })] });
		const { labels } = await ops();
		const ports = recordingPorts();

		// The GUI sends the whole set minus the chip it removed, dangling id included.
		const result = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "replace", labelIds: ["gone"] });

		expect(result.verdict).toBe("applied");
		expect(result.task.labelIds).toEqual(["gone"]);
	});

	it("the same sequence is a no-op; the same set in another order is a change (chips render in labelIds order)", async () => {
		board = await createBoard({ labels: LABELS, tasks: [makeTask({ labelIds: ["lbl-a", "lbl-b"] })] });
		const { labels } = await ops();
		const ports = recordingPorts();
		const inode = board.tasksInode();

		const same = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "replace", labelIds: ["lbl-a", "lbl-b"] });
		const addExisting = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "add", labelIds: ["lbl-b"] });
		expect([same.verdict, addExisting.verdict]).toEqual(["noop", "noop"]);
		expect(board.tasksInode()).toBe(inode);
		expect(ports.pushes).toEqual([]);

		const reordered = await labels.changeTaskLabels(ports, board.project, "task-1", { mode: "replace", labelIds: ["lbl-b", "lbl-a"] });
		expect(reordered.verdict).toBe("applied");
		expect(board.tasksInode()).not.toBe(inode);
	});
});

describe("board operations — project labels", () => {
	it("create picks an unused colour, trims the name, and pushes projectUpdated", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels, data } = await ops();
		const ports = recordingPorts();

		const { result: label, verdict } = await labels.createLabel(ports, "proj-1", { name: "  urgent  " });

		expect(verdict).toBe("applied");
		expect(label.name).toBe("urgent");
		expect(LABELS.map((l) => l.color)).not.toContain(label.color);
		expect((await data.getProject("proj-1")).labels?.map((l) => l.name)).toEqual(["a", "b", "urgent"]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["projectUpdated"]);
	});

	it("create and rename refuse an empty name", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels } = await ops();
		const ports = recordingPorts();

		await expect(labels.createLabel(ports, "proj-1", { name: "   " })).rejects.toThrow("name is required");
		await expect(labels.updateLabel(ports, "proj-1", "lbl-a", { name: "" })).rejects.toThrow("name must not be empty");
		expect(ports.pushes).toEqual([]);
	});

	it("update applies a change, is a no-op on the same values, and rejects an unknown id", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels } = await ops();
		const ports = recordingPorts();

		const renamed = await labels.updateLabel(ports, "proj-1", "lbl-a", { name: "alpha" });
		const inode = board.projectsInode();
		const same = await labels.updateLabel(ports, "proj-1", "lbl-a", { name: "alpha", color: "#ef4444" });

		expect([renamed.verdict, same.verdict]).toEqual(["applied", "noop"]);
		expect(board.projectsInode()).toBe(inode);
		expect(ports.pushes.map((p) => p.name)).toEqual(["projectUpdated"]);
		await expect(labels.updateLabel(ports, "proj-1", "nope", { name: "x" })).rejects.toThrow("Label not found: nope");
	});

	it("delete strips the id from every task and pushes a single projectUpdated", async () => {
		board = await createBoard({
			labels: LABELS,
			tasks: [makeTask({ labelIds: ["lbl-a", "lbl-b"] }), makeTask({ id: "task-2", seq: 2, labelIds: ["lbl-a"] }), makeTask({ id: "task-3", seq: 3 })],
		});
		const { labels, data } = await ops();
		const ports = recordingPorts();

		const { verdict, result } = await labels.deleteLabel(ports, "proj-1", "lbl-a");

		expect(verdict).toBe("applied");
		expect(result.removedFromTasks).toBe(2);
		expect((await data.getProject("proj-1")).labels?.map((l) => l.id)).toEqual(["lbl-b"]);
		expect((await data.loadTasks(board.project)).map((t) => t.labelIds ?? [])).toEqual([["lbl-b"], [], []]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["projectUpdated"]);
	});

	it("deleting a label that no longer exists anywhere is a no-op", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels } = await ops();
		const ports = recordingPorts();
		const inodes = [board.projectsInode(), board.tasksInode()];

		const { verdict } = await labels.deleteLabel(ports, "proj-1", "never-existed");

		expect(verdict).toBe("noop");
		expect([board.projectsInode(), board.tasksInode()]).toEqual(inodes);
		expect(ports.pushes).toEqual([]);
	});

	it("reorder applies once and is a no-op when the order already matches", async () => {
		board = await createBoard({ labels: LABELS });
		const { labels } = await ops();
		const ports = recordingPorts();

		const first = await labels.reorderLabels(ports, "proj-1", ["lbl-b", "lbl-a"]);
		const again = await labels.reorderLabels(ports, "proj-1", ["lbl-b", "lbl-a"]);

		expect([first.verdict, again.verdict]).toEqual(["applied", "noop"]);
		expect(first.project.labels?.map((l) => l.id)).toEqual(["lbl-b", "lbl-a"]);
		expect(ports.pushes.map((p) => p.name)).toEqual(["projectUpdated"]);
	});
});
