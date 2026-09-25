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
