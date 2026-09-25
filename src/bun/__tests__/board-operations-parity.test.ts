import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliRequest, Task } from "../../shared/types";
import { createBoard, makeTask, type Board, type RecordedPush } from "./board-operations-harness";

// GUI (RPC handler) and CLI (socket handler) doors driven side by side against one
// real temp board. Only the native platform and the unrelated barrel the CLI door
// imports are stubbed — data.ts, the file lock and the production push port
// (`getPushMessage` → every client + peer broadcast) are real.

vi.mock("electrobun/bun", () => ({ Utils: {}, PATHS: {}, Updater: {}, BrowserWindow: class {}, default: {} }));
vi.mock("bun:ffi", () => ({ dlopen: () => ({ symbols: {} }), FFIType: {}, ptr: () => 0, CString: class {} }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: () => null,
	getPushMessageLocal: () => null,
	clearMergeNotification: vi.fn(),
}));
vi.mock("../rpc-handlers/tmux-pty", () => ({
	getDevServerStatus: vi.fn(), runDevServer: vi.fn(), stopDevServer: vi.fn(), restartDevServer: vi.fn(),
}));

const originalHome = process.env.HOME;
let board: Board | null = null;

afterEach(() => {
	board?.cleanup();
	board = null;
	process.env.HOME = originalHome;
});

/** Everything the production push port receives, via the same hook index.ts installs. */
async function recordProductionPushes(): Promise<RecordedPush[]> {
	const pushes: RecordedPush[] = [];
	const { setPushMessage } = await import("../rpc-handlers/shared-pure");
	setPushMessage((name, payload) => { pushes.push({ name, payload }); });
	return pushes;
}

async function doors() {
	const { notesLabelsHandlers: gui } = await import("../rpc-handlers/notes-labels");
	const { handleRequest } = await import("../cli-socket-server");
	const cli = async (method: string, params: Record<string, unknown>) => {
		const req: CliRequest = { id: "req-1", method, params };
		return handleRequest(req);
	};
	return { gui, cli };
}

describe("board operations — GUI and CLI doors agree on notes", () => {
	it("both doors persist a note and push taskUpdated; the actor decides the source", async () => {
		board = await createBoard({ tasks: [makeTask(), makeTask({ id: "task-2", seq: 2 })] });
		const pushes = await recordProductionPushes();
		const { gui, cli } = await doors();

		const viaGui = await gui.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "hello" });
		const viaCli = await cli("note.add", { taskId: "task-2", projectId: "proj-1", content: "hello" });

		expect(viaCli.ok).toBe(true);
		const cliTask = viaCli.data as Task;
		const strip = (t: Task) => (t.notes ?? []).map(({ content }) => ({ content }));
		expect(strip(viaGui)).toEqual(strip(cliTask));
		expect(viaGui.notes?.[0].source).toBe("user");
		expect(cliTask.notes?.[0].source).toBe("ai");
		expect(pushes.filter((p) => p.name === "taskUpdated").map((p) => (p.payload.task as Task).id)).toEqual(["task-1", "task-2"]);
	});

	it("an explicit source is a note attribute: it overrides the door's default source only", async () => {
		board = await createBoard();
		await recordProductionPushes();
		const { gui, cli } = await doors();

		const viaGui = await gui.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "a", source: "ai" });
		const viaCli = await cli("note.add", { taskId: "task-1", projectId: "proj-1", content: "b", source: "user" });

		expect(viaGui.notes?.map((n) => n.source)).toEqual(["ai"]);
		expect((viaCli.data as Task).notes?.map((n) => n.source)).toEqual(["ai", "user"]);
	});

	it("GUI note edits and deletes now reach other clients (they used to push nothing)", async () => {
		board = await createBoard();
		const pushes = await recordProductionPushes();
		const { gui } = await doors();

		const added = await gui.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "v1" });
		const noteId = added.notes![0].id;
		await gui.updateTaskNote({ taskId: "task-1", projectId: "proj-1", noteId, content: "v2" });
		await gui.deleteTaskNote({ taskId: "task-1", projectId: "proj-1", noteId });

		expect(pushes.map((p) => p.name)).toEqual(["taskUpdated", "taskUpdated", "taskUpdated"]);
		expect((pushes[1].payload.task as Task).notes?.[0].content).toBe("v2");
		expect((pushes[2].payload.task as Task).notes).toEqual([]);
	});

	it("CLI note delete resolves a prefix and keeps its not-found error", async () => {
		board = await createBoard();
		await recordProductionPushes();
		const { gui, cli } = await doors();
		const added = await gui.addTaskNote({ taskId: "task-1", projectId: "proj-1", content: "x" });
		const noteId = added.notes![0].id;

		const missing = await cli("note.delete", { taskId: "task-1", projectId: "proj-1", noteId: "zzzzzzzz" });
		const byPrefix = await cli("note.delete", { taskId: "task-1", projectId: "proj-1", noteId: noteId.slice(0, 8) });

		expect(missing).toMatchObject({ ok: false, error: "Note not found: zzzzzzzz" });
		expect(byPrefix.ok).toBe(true);
		expect((byPrefix.data as Task).notes).toEqual([]);
	});
});

const LABELS = [
	{ id: "lbl-aaaa-1111", name: "a", color: "#ef4444" },
	{ id: "lbl-bbbb-2222", name: "b", color: "#14b8a6" },
];

describe("board operations — GUI and CLI doors agree on labels", () => {
	it("an unknown label id is refused by both doors and nothing is written", async () => {
		board = await createBoard({ labels: LABELS });
		const pushes = await recordProductionPushes();
		const { gui, cli } = await doors();
		const inode = board.tasksInode();

		await expect(gui.setTaskLabels({ taskId: "task-1", projectId: "proj-1", labelIds: ["ghost"] })).rejects.toThrow("Label not found: ghost");
		const viaCli = await cli("task.setLabels", { taskId: "task-1", projectId: "proj-1", labelIds: ["ghost"] });

		expect(viaCli).toMatchObject({ ok: false, error: 'Label not found: ghost. Run "dev3 label list" to see valid label IDs.' });
		expect(board.tasksInode()).toBe(inode);
		expect(pushes).toEqual([]);
	});

	it("both doors write the same labels and both push taskUpdated (the GUI used to push nothing)", async () => {
		board = await createBoard({ labels: LABELS, tasks: [makeTask(), makeTask({ id: "task-2", seq: 2 })] });
		const pushes = await recordProductionPushes();
		const { gui, cli } = await doors();

		const viaGui = await gui.setTaskLabels({ taskId: "task-1", projectId: "proj-1", labelIds: ["lbl-aaaa-1111"] });
		const viaCli = await cli("task.setLabels", { taskId: "task-2", projectId: "proj-1", labelIds: ["lbl-aaaa"] });

		expect(viaGui.labelIds).toEqual(["lbl-aaaa-1111"]);
		expect((viaCli.data as Task).labelIds).toEqual(["lbl-aaaa-1111"]);
		expect(pushes.map((p) => p.name)).toEqual(["taskUpdated", "taskUpdated"]);
	});

	it("GUI label create and delete now push projectUpdated like the CLI", async () => {
		board = await createBoard({ labels: LABELS, tasks: [makeTask({ labelIds: ["lbl-aaaa-1111"] })] });
		const pushes = await recordProductionPushes();
		const { gui, cli } = await doors();
		const data = await import("../data");

		const created = await gui.createLabel({ projectId: "proj-1", name: "c" });
		await gui.deleteLabel({ projectId: "proj-1", labelId: "lbl-aaaa-1111" });
		const viaCli = await cli("label.delete", { projectId: "proj-1", labelId: created.id.slice(0, 8) });

		expect(viaCli).toMatchObject({ ok: true, data: { deleted: created.id } });
		expect(pushes.map((p) => p.name)).toEqual(["projectUpdated", "projectUpdated", "projectUpdated"]);
		expect((await data.getTask(board.project, "task-1")).labelIds).toEqual([]);
		expect((await data.getProject("proj-1")).labels?.map((l) => l.id)).toEqual(["lbl-bbbb-2222"]);
	});
});

describe("board operations — GUI and CLI doors agree on task metadata", () => {
	it("a user-edited title survives an agent's CLI rename; the GUI rename sets the guard", async () => {
		board = await createBoard();
		await recordProductionPushes();
		const { cli } = await doors();
		const { taskLifecycleHandlers } = await import("../rpc-handlers/task-lifecycle");

		const renamed = await taskLifecycleHandlers.renameTask({ taskId: "task-1", projectId: "proj-1", customTitle: "Mine" });
		const agent = await cli("task.update", { taskId: "task-1", projectId: "proj-1", title: "Agent's" });

		expect(renamed.titleEditedByUser).toBe(true);
		expect(agent.data).toMatchObject({ titlePreserved: true, task: { customTitle: "Mine" } });
	});

	it("clearing a title recomputes the auto title on all three doors", async () => {
		const stale = { customTitle: "Custom", title: "stale", description: "Real brief" };
		board = await createBoard({
			tasks: [
				makeTask({ ...stale }),
				makeTask({ id: "task-2", seq: 2, ...stale }),
				makeTask({ id: "task-3", seq: 3, status: "todo", ...stale }),
			],
		});
		await recordProductionPushes();
		const { cli } = await doors();
		const { taskLifecycleHandlers } = await import("../rpc-handlers/task-lifecycle");

		const viaRename = await taskLifecycleHandlers.renameTask({ taskId: "task-1", projectId: "proj-1", customTitle: null });
		const viaCli = await cli("task.update", { taskId: "task-2", projectId: "proj-1", title: "" });
		const viaEdit = await taskLifecycleHandlers.editTask({ taskId: "task-3", projectId: "proj-1", customTitle: "" });

		for (const task of [viaRename, (viaCli.data as { task: Task }).task, viaEdit]) {
			expect(task).toMatchObject({ customTitle: null, title: "Real brief" });
		}
	});

	it("--type, --title and --description land in one taskUpdated", async () => {
		board = await createBoard();
		const pushes = await recordProductionPushes();
		const { cli } = await doors();

		const resp = await cli("task.update", { taskId: "task-1", projectId: "proj-1", taskType: "coordinator", title: "Lead", description: "own text" });

		expect(resp.ok).toBe(true);
		const taskPushes = pushes.filter((p) => p.name === "taskUpdated");
		expect(taskPushes).toHaveLength(1);
		const pushed = taskPushes[0].payload.task as Task;
		expect(pushed).toMatchObject({ taskType: "coordinator", customTitle: "Lead" });
		expect(pushed.description.endsWith("own text")).toBe(true);
		expect(pushed.description.length).toBeGreaterThan("own text".length);
		expect(resp.data).toMatchObject({ roleDelivery: "no-session", titlePreserved: false });
	});

	it("a same-value --title is a quiet no-op, not 'Nothing to update'", async () => {
		board = await createBoard({ tasks: [makeTask({ customTitle: "Same" })] });
		const pushes = await recordProductionPushes();
		const { cli } = await doors();
		const inode = board.tasksInode();

		const resp = await cli("task.update", { taskId: "task-1", projectId: "proj-1", title: "Same" });
		const nothing = await cli("task.update", { taskId: "task-1", projectId: "proj-1" });

		expect(resp).toMatchObject({ ok: true, data: { titlePreserved: false, task: { customTitle: "Same" } } });
		expect(nothing).toMatchObject({ ok: false });
		expect(nothing.error).toContain("Nothing to update");
		expect(board.tasksInode()).toBe(inode);
		expect(pushes).toEqual([]);
	});

	it("manual completion: the CLI (agent) toasts, the GUI (user) stays silent", async () => {
		board = await createBoard({ tasks: [makeTask(), makeTask({ id: "task-2", seq: 2 })] });
		const pushes = await recordProductionPushes();
		const { cli } = await doors();
		const { taskLifecycleHandlers } = await import("../rpc-handlers/task-lifecycle");

		await cli("task.update", { taskId: "task-1", projectId: "proj-1", manualCompletion: true });
		await taskLifecycleHandlers.setTaskManualCompletion({ taskId: "task-2", projectId: "proj-1", manualCompletion: true });

		expect(pushes.map((p) => [p.name, (p.payload.task as Task | undefined)?.id ?? p.payload.taskId])).toEqual([
			["taskUpdated", "task-1"],
			["manualCompletionChanged", "task-1"],
			["taskUpdated", "task-2"],
		]);
	});

	it("editTask refuses an introduced unknown label and writes nothing", async () => {
		board = await createBoard({ labels: LABELS, tasks: [makeTask({ status: "todo" })] });
		const pushes = await recordProductionPushes();
		const { taskLifecycleHandlers } = await import("../rpc-handlers/task-lifecycle");
		const inode = board.tasksInode();

		await expect(taskLifecycleHandlers.editTask({ taskId: "task-1", projectId: "proj-1", labelIds: ["ghost"], description: "x" }))
			.rejects.toThrow("Label not found: ghost");
		expect(board.tasksInode()).toBe(inode);
		expect(pushes).toEqual([]);
	});
});

describe("projects — an empty patch skips the save (F4)", () => {
	it("marking the conversation-import offer twice writes projects.json once", async () => {
		board = await createBoard();
		await recordProductionPushes();
		const { conversationImportHandlers } = await import("../rpc-handlers/conversation-import-handlers");

		const first = await conversationImportHandlers.markConversationImportOffered({ projectId: "proj-1" });
		const inode = board.projectsInode();
		const second = await conversationImportHandlers.markConversationImportOffered({ projectId: "proj-1" });

		expect(second.project.conversationImportOfferedAt).toBe(first.project.conversationImportOfferedAt);
		expect(board.projectsInode()).toBe(inode);
	});
});
