import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Task } from "../../shared/types";
import { BOARD_COPY_FORMAT_VERSION, BOARD_COPY_TASK_FIELDS } from "../../shared/board-copy";

const home = vi.hoisted(() => ({ current: "" }));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock("../paths", () => ({
	get DEV3_HOME() {
		return home.current;
	},
}));
vi.mock("../cow-clone", () => ({ detectClonePaths: () => Promise.resolve([]) }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

let tempHome: string;
let projectDir: string;
let pushes: Array<{ name: string; payload: any }>;

type Data = typeof import("../data");
type BoardCopy = typeof import("../board-copy");

async function load(): Promise<{ data: Data; copy: BoardCopy }> {
	const data = await import("../data");
	const copy = await import("../board-copy");
	const { setPushMessage } = await import("../rpc-handlers/shared-pure");
	setPushMessage((name, payload) => pushes.push({ name, payload }));
	return { data, copy };
}

/** A fresh dev3 home, as on a new machine or after the data folder was wiped. */
function freshHome(): void {
	tempHome = mkdtempSync(join(tmpdir(), "dev3-board-copy-home-"));
	home.current = join(tempHome, ".dev3.0");
	mkdirSync(home.current, { recursive: true });
	vi.resetModules();
}

function makeTask(project: Project, overrides: Partial<Task>): Task {
	return {
		id: crypto.randomUUID(),
		seq: 1,
		projectId: project.id,
		title: "Task",
		description: "Task",
		status: "todo",
		priority: "P3",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		relations: [],
		agentId: null,
		configId: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		labelIds: [],
		notes: [],
		customTitle: null,
		titleEditedByUser: false,
		customColumnId: null,
		overview: null,
		userOverview: null,
		history: [],
		...overrides,
	};
}

async function enabledProject(data: Data, extra: Partial<Project> = {}): Promise<Project> {
	const project = await data.addProject(projectDir, "Board Copy Project");
	return data.updateProject(project.id, { boardCopy: true, ...extra });
}

const boardDir = () => join(projectDir, ".dev3", "board");
const listDir = (sub: string) => (existsSync(join(boardDir(), sub)) ? readdirSync(join(boardDir(), sub)).sort() : []);
const readJson = (rel: string) => JSON.parse(readFileSync(join(boardDir(), rel), "utf8"));

beforeEach(() => {
	freshHome();
	projectDir = mkdtempSync(join(tmpdir(), "dev3-board-copy-project-"));
	pushes = [];
});

afterEach(async () => {
	const copy = await import("../board-copy");
	copy.stopBoardCopy();
	vi.useRealTimers();
	for (const dir of [join(projectDir, ".dev3", "board"), join(projectDir, ".dev3", "board", "tasks")]) {
		try {
			chmodSync(dir, 0o755);
		} catch {
			// not created by this test
		}
	}
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(tempHome, { recursive: true, force: true });
});

describe("board copy export", () => {
	it("writes nothing while the copy is off", async () => {
		const { data, copy } = await load();
		const project = await data.addProject(projectDir, "Off");
		await data.saveTasks(project, [makeTask(project, { seq: 1, title: "Hello" })]);
		await copy.runBoardCopy(project.id);
		expect(existsSync(join(projectDir, ".dev3"))).toBe(false);
	});

	it("writes the documented layout", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data, {
			labels: [{ id: "lab-1", name: "bug", color: "#ef4444" }],
			customColumns: [{ id: "col-1", name: "Blocked", color: "#f97316", llmInstruction: "" }],
		});
		const groupId = "group-1";
		await data.saveTasks(project, [
			makeTask(project, { seq: 1, title: "Fix the auth race!", notes: [{ id: "n1", content: "Reproduced it.", source: "ai", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }] }),
			makeTask(project, { seq: 2, title: "Variant", groupId, variantIndex: 1 }),
			makeTask(project, { seq: 2, title: "Variant", groupId, variantIndex: 2 }),
		]);
		await copy.runBoardCopy(project.id);

		expect(readFileSync(join(boardDir(), ".gitignore"), "utf8")).toBe("*\n");
		expect(readFileSync(join(boardDir(), "README.md"), "utf8")).toContain("Copy written by dev3. Edits here are overwritten.");
		expect(listDir("tasks")).toEqual(["1-fix-the-auth-race.json", "2-v1-variant.json", "2-v2-variant.json"]);
		expect(listDir("notes")).toEqual(["1.md"]);
		expect(readFileSync(join(boardDir(), "notes", "1.md"), "utf8")).toContain("Reproduced it.");
		const manifest = readJson("board.json");
		expect(manifest).toMatchObject({
			format: "dev3-board-copy",
			version: BOARD_COPY_FORMAT_VERSION,
			projectName: "Board Copy Project",
			labels: [{ id: "lab-1", name: "bug" }],
			customColumns: [{ id: "col-1", name: "Blocked" }],
			taskCount: 3,
		});
		expect(typeof manifest.exportedAt).toBe("string");
		expect(readJson("tasks/1-fix-the-auth-race.json").title).toBe("Fix the auth race!");
	});

	it("never copies secrets, accounts, session ids or machine-local handles", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data, { env: { API_TOKEN: "SECRET-ENV-VALUE" } });
		await data.saveTasks(project, [
			makeTask(project, {
				seq: 1,
				status: "in-progress",
				worktreePath: "/secret/worktree/path",
				tmuxSocket: "SECRET-SOCKET",
				accountId: "SECRET-ACCOUNT",
				importedSessionId: "SECRET-IMPORTED-SESSION",
				sessionState: { claudeSessionId: "SECRET-SESSION-ID" } as unknown as Task["sessionState"],
				keepAlive: { enabled: true } as Task["keepAlive"],
			}),
		]);
		await copy.runBoardCopy(project.id);

		const everything = ["board.json", ...listDir("tasks").map((f) => `tasks/${f}`)]
			.map((rel) => readFileSync(join(boardDir(), rel), "utf8"))
			.join("\n");
		for (const secret of ["SECRET-ENV-VALUE", "API_TOKEN", "/secret/worktree/path", "SECRET-SOCKET", "SECRET-ACCOUNT", "SECRET-IMPORTED-SESSION", "SECRET-SESSION-ID"]) {
			expect(everything).not.toContain(secret);
		}
		const task = readJson(`tasks/${listDir("tasks")[0]}`);
		for (const key of Object.keys(task)) expect(BOARD_COPY_TASK_FIELDS as readonly string[]).toContain(key);
		expect(task).not.toHaveProperty("keepAlive");
	});

	it("writes only changed files, and removes deleted and renamed tasks", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data);
		const a = makeTask(project, { seq: 1, title: "Alpha", notes: [{ id: "n", content: "x", source: "user", createdAt: "t", updatedAt: "t" }] });
		const b = makeTask(project, { seq: 2, title: "Beta" });
		await data.saveTasks(project, [a, b]);
		const first = await copy.exportBoardCopy(await data.getProject(project.id));
		expect(first.written).toBe(6); // README, .gitignore, 2 tasks, 1 notes, board.json

		const again = await copy.exportBoardCopy(await data.getProject(project.id));
		expect(again).toMatchObject({ written: 0, removed: 0 });

		await data.saveTasks(project, [{ ...b, title: "Beta renamed" }]);
		const third = await copy.exportBoardCopy(await data.getProject(project.id));
		expect(listDir("tasks")).toEqual(["2-beta-renamed.json"]);
		expect(listDir("notes")).toEqual([]);
		expect(third).toMatchObject({ written: 2, removed: 3 });
		expect(readJson("board.json").taskFiles).toEqual(["2-beta-renamed.json"]);
		expect(readdirSync(boardDir(), { recursive: true }).some((f) => String(f).includes(".tmp-"))).toBe(false);
	});

	it("copies agent messages only when that option is on", async () => {
		const { data, copy } = await load();
		const { appendAgentMessageLog } = await import("../agent-message-log");
		const project = await enabledProject(data);
		const task = makeTask(project, { seq: 4, title: "Receiver" });
		await data.saveTasks(project, [task]);
		appendAgentMessageLog(project, {
			at: new Date().toISOString(), fromTaskId: null, fromSeq: 7, toTaskId: task.id, toSeq: 4, toProjectId: project.id,
			kind: "immediate", status: "delivered", body: "Please rebase", bodyKind: "text", subject: "Rebase",
		} as never);
		await copy.runBoardCopy(project.id);
		expect(listDir("messages")).toEqual([]);

		await data.updateProject(project.id, { boardCopyMessages: true });
		await copy.runBoardCopy(project.id);
		expect(listDir("messages")).toEqual(["4.md"]);
		expect(readFileSync(join(boardDir(), "messages", "4.md"), "utf8")).toContain("Please rebase");
	});

	it("folds a burst of 20 changes in 2 s into one write after the quiet period", async () => {
		vi.useFakeTimers();
		const { data, copy } = await load();
		const project = await enabledProject(data);
		await data.saveTasks(project, [makeTask(project, { seq: 1, title: "Burst" })]);
		const start = Date.now();
		for (let i = 0; i < 20; i++) {
			copy.scheduleBoardCopy(project.id, start + i * 100);
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(existsSync(boardDir())).toBe(false);
		await vi.advanceTimersByTimeAsync(copy.BOARD_COPY_DEBOUNCE_MS);
		vi.useRealTimers();
		await vi.waitFor(() => expect(existsSync(join(boardDir(), "board.json"))).toBe(true));
		const exportedAt = readJson("board.json").exportedAt;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(readJson("board.json").exportedAt).toBe(exportedAt);
	});

	it("writes at most BOARD_COPY_MAX_WAIT_MS after the first change on a board that never goes quiet", async () => {
		vi.useFakeTimers();
		const { data, copy } = await load();
		const project = await enabledProject(data);
		const t0 = Date.now();
		for (let elapsed = 0; elapsed < copy.BOARD_COPY_MAX_WAIT_MS - 1_000; elapsed += 1_000) {
			copy.scheduleBoardCopy(project.id, t0 + elapsed);
			await vi.advanceTimersByTimeAsync(1_000);
		}
		expect(existsSync(join(boardDir(), "board.json"))).toBe(false);
		copy.scheduleBoardCopy(project.id, t0 + copy.BOARD_COPY_MAX_WAIT_MS - 500);
		await vi.advanceTimersByTimeAsync(600);
		vi.useRealTimers();
		await vi.waitFor(() => expect(existsSync(join(boardDir(), "board.json"))).toBe(true));
	});

	it("follows board saves once started", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data);
		vi.useFakeTimers();
		copy.startBoardCopy();
		await data.saveTasks(project, [makeTask(project, { seq: 1, title: "Followed" })]);
		await vi.advanceTimersByTimeAsync(copy.BOARD_COPY_DEBOUNCE_MS + 10);
		vi.useRealTimers();
		await vi.waitFor(() => expect(listDir("tasks")).toEqual(["1-followed.json"]));
	});
});

describe("board copy failures never reach the board", () => {
	it("a read-only copy folder gives one warning and the board keeps working", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data);
		await data.saveTasks(project, [makeTask(project, { seq: 1, title: "One" })]);
		await copy.runBoardCopy(project.id);
		chmodSync(join(boardDir(), "tasks"), 0o555);
		chmodSync(boardDir(), 0o555);

		await data.saveTasks(project, [makeTask(project, { seq: 1, title: "One" }), makeTask(project, { seq: 2, title: "Two" })]);
		await expect(copy.runBoardCopy(project.id)).resolves.toBeUndefined();
		await copy.runBoardCopy(project.id);
		const warnings = pushes.filter((p) => p.name === "boardCopyFailed");
		expect(warnings).toHaveLength(1);
		expect(warnings[0].payload).toMatchObject({ projectId: project.id, reason: "not-writable" });
		expect((await data.loadTasks(project)).length).toBe(2);

		chmodSync(boardDir(), 0o755);
		chmodSync(join(boardDir(), "tasks"), 0o755);
		await copy.runBoardCopy(project.id);
		expect(listDir("tasks")).toEqual(["1-one.json", "2-two.json"]);
		// A new streak after a success warns again.
		chmodSync(boardDir(), 0o555);
		chmodSync(join(boardDir(), "tasks"), 0o555);
		await data.saveTasks(project, [makeTask(project, { seq: 3, title: "Three" })]);
		await copy.runBoardCopy(project.id);
		expect(pushes.filter((p) => p.name === "boardCopyFailed")).toHaveLength(2);
	});

	it("a missing (or renamed) project folder is reported and never recreated", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data);
		rmSync(projectDir, { recursive: true, force: true });
		await copy.runBoardCopy(project.id);
		expect(existsSync(projectDir)).toBe(false);
		expect(pushes.find((p) => p.name === "boardCopyFailed")?.payload.reason).toBe("missing-folder");
	});

	it("a full disk is classified and survives", async () => {
		const { copy } = await load();
		expect(copy.classifyBoardCopyError(Object.assign(new Error("full"), { code: "ENOSPC" }))).toBe("disk-full");
		expect(copy.classifyBoardCopyError(Object.assign(new Error("ro"), { code: "EROFS" }))).toBe("not-writable");
		expect(copy.classifyBoardCopyError(new Error("odd"))).toBe("other");
	});

	it("a disk-full write leaves the board intact", async () => {
		vi.doMock("../atomic-write", async (importOriginal) => {
			const real = await importOriginal<typeof import("../atomic-write")>();
			return {
				...real,
				atomicWriteFile: async (file: string, content: string) => {
					if (file.includes(`${join(".dev3", "board")}`)) {
						throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
					}
					return real.atomicWriteFile(file, content);
				},
			};
		});
		try {
			const { data, copy } = await load();
			const project = await enabledProject(data);
			await data.saveTasks(project, [makeTask(project, { seq: 1, title: "Kept" })]);
			await copy.runBoardCopy(project.id);
			expect(pushes.find((p) => p.name === "boardCopyFailed")?.payload.reason).toBe("disk-full");
			expect((await data.loadTasks(project)).map((t) => t.title)).toEqual(["Kept"]);
		} finally {
			vi.doUnmock("../atomic-write");
		}
	});
});

describe("board copy restore", () => {
	async function seedAndExport(): Promise<{ project: Project; tasks: Task[] }> {
		const { data, copy } = await load();
		const project = await enabledProject(data, {
			labels: [{ id: "lab-1", name: "bug", color: "#ef4444" }],
			customColumns: [{ id: "col-1", name: "Blocked", color: "#f97316", llmInstruction: "" }],
		});
		const done = makeTask(project, { seq: 1, title: "Done", status: "completed", branchName: "feat/done", prNumber: 12, labelIds: ["lab-1"] });
		const running = makeTask(project, { seq: 2, title: "Running", status: "in-progress", branchName: "feat/run", worktreePath: "/wt/run", customColumnId: "col-1" });
		const todo = makeTask(project, {
			seq: 3, title: "Later", relations: [{ type: "blocked-by", taskId: done.id }],
			notes: [{ id: "n1", content: "Remember this", source: "user", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }],
		});
		await data.saveTasks(project, [done, running, todo]);
		await copy.runBoardCopy(project.id);
		return { project, tasks: [done, running, todo] };
	}

	it("round trip: a wiped dev3 home re-adds the folder and restores every task", async () => {
		const { tasks } = await seedAndExport();
		freshHome();
		const { data, copy } = await load();
		const readded = await data.addProject(projectDir, "Board Copy Project");
		const offer = await copy.boardCopyOfferForNewProject(readded);
		expect(offer).toMatchObject({ status: "ok", taskCount: 3 });

		const result = await copy.restoreBoardCopy(readded.id);
		expect(result).toEqual({ ok: true, restored: 3, missing: 0 });

		const restored = await data.loadTasks(readded);
		const byId = new Map(restored.map((t) => [t.id, t]));
		for (const original of tasks) {
			const back = byId.get(original.id)!;
			expect(back).toBeDefined();
			expect(back.projectId).toBe(readded.id);
			expect(back.worktreePath).toBeNull();
			for (const field of ["seq", "title", "description", "labelIds", "notes", "relations", "createdAt", "prNumber"] as const) {
				expect(back[field]).toEqual(original[field]);
			}
		}
		const running = byId.get(tasks[1].id)!;
		expect(running).toMatchObject({ status: "todo", branchName: null, customColumnId: null });
		expect(running.movements?.[running.movements.length - 1]).toMatchObject({ from: "in-progress", to: "todo" });
		expect(byId.get(tasks[0].id)).toMatchObject({ status: "completed", branchName: "feat/done" });

		const project = await data.getProject(readded.id);
		expect(project.boardCopy).toBe(true);
		expect(project.labels).toEqual([{ id: "lab-1", name: "bug", color: "#ef4444" }]);
		expect(project.customColumns?.map((c) => c.id)).toEqual(["col-1"]);
	});

	it("never overwrites a board that has tasks", async () => {
		const { project } = await seedAndExport();
		const { data, copy } = await load();
		expect(await copy.boardCopyOfferForNewProject(project)).toBeNull();
		expect(await copy.restoreBoardCopy(project.id)).toEqual({ ok: false, reason: "board-not-empty" });
		expect((await data.loadTasks(project)).length).toBe(3);
	});

	it("refuses a copy in another format version, and never overwrites it", async () => {
		await seedAndExport();
		const manifestPath = join(boardDir(), "board.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: 99 }));
		freshHome();
		const { data, copy } = await load();
		const readded = await data.updateProject((await data.addProject(projectDir, "P")).id, { boardCopy: true });
		expect(await copy.boardCopyOfferForNewProject(readded)).toEqual({ status: "unsupported-version", version: "99" });
		expect(await copy.restoreBoardCopy(readded.id)).toEqual({ ok: false, reason: "unsupported-version", version: "99" });
		await copy.runBoardCopy(readded.id);
		expect(JSON.parse(readFileSync(manifestPath, "utf8")).version).toBe(99);
		expect(pushes.find((p) => p.name === "boardCopyFailed")?.payload.reason).toBe("unsupported-copy");
	});

	it("keeps the copy when an empty board would replace it after a wipe", async () => {
		await seedAndExport();
		freshHome();
		const { data, copy } = await load();
		const readded = await data.updateProject((await data.addProject(projectDir, "P")).id, { boardCopy: true });
		await copy.runBoardCopy(readded.id);
		expect(listDir("tasks")).toHaveLength(3);
		expect(pushes.find((p) => p.name === "boardCopyFailed")?.payload.reason).toBe("kept-copy");
		// The copy is still there to restore.
		expect(await copy.restoreBoardCopy(readded.id)).toMatchObject({ ok: true, restored: 3 });
	});

	it("remaps every id when the old board is still registered (renamed folder)", async () => {
		const { tasks } = await seedAndExport();
		const { data, copy } = await load();
		const movedDir = `${projectDir}-moved`;
		mkdirSync(movedDir);
		const { cpSync } = await import("node:fs");
		cpSync(join(projectDir, ".dev3"), join(movedDir, ".dev3"), { recursive: true });
		try {
			const moved = await data.addProject(movedDir, "Moved");
			expect(await copy.restoreBoardCopy(moved.id)).toMatchObject({ ok: true, restored: 3 });
			const restored = await data.loadTasks(moved);
			const originalIds = new Set(tasks.map((t) => t.id));
			expect(restored.some((t) => originalIds.has(t.id))).toBe(false);
			const later = restored.find((t) => t.seq === 3)!;
			const done = restored.find((t) => t.seq === 1)!;
			expect(later.relations).toEqual([{ type: "blocked-by", taskId: done.id }]);
		} finally {
			rmSync(movedDir, { recursive: true, force: true });
		}
	});

	it("restores only allowlisted fields from a hand-edited task file", async () => {
		await seedAndExport();
		const name = listDir("tasks").find((file) => file.startsWith("3-"))!;
		const crafted = { ...readJson(`tasks/${name}`), scheduledLaunch: { at: "2020-01-01T00:00:00.000Z", targetStatus: "in-progress", variants: [] }, accountId: "acc-1" };
		writeFileSync(join(boardDir(), "tasks", name), JSON.stringify(crafted));
		freshHome();
		const { data, copy } = await load();
		const readded = await data.addProject(projectDir, "P");
		expect(await copy.restoreBoardCopy(readded.id)).toMatchObject({ ok: true, restored: 3 });
		const later = (await data.loadTasks(readded)).find((t) => t.seq === 3)!;
		expect(later.scheduledLaunch).toBeUndefined();
		expect(later.accountId).toBeUndefined();
	});

	it("counts a task file that is not a task as missing", async () => {
		await seedAndExport();
		writeFileSync(join(boardDir(), "tasks", listDir("tasks")[0]), JSON.stringify([{ id: "x" }]));
		freshHome();
		const { data, copy } = await load();
		const readded = await data.addProject(projectDir, "P");
		expect(await copy.restoreBoardCopy(readded.id)).toEqual({ ok: true, restored: 2, missing: 1 });
	});

	it("skips a task file listed in board.json that is missing", async () => {
		await seedAndExport();
		rmSync(join(boardDir(), "tasks", listDir("tasks")[0]));
		freshHome();
		const { data, copy } = await load();
		const readded = await data.addProject(projectDir, "P");
		expect(await copy.restoreBoardCopy(readded.id)).toEqual({ ok: true, restored: 2, missing: 1 });
	});

	it("offers nothing for a copy of an empty board", async () => {
		const { data, copy } = await load();
		const project = await enabledProject(data);
		await copy.runBoardCopy(project.id);
		expect(existsSync(join(boardDir(), "board.json"))).toBe(true);
		freshHome();
		const again = await load();
		const readded = await again.data.addProject(projectDir, "P");
		expect(await again.copy.boardCopyOfferForNewProject(readded)).toBeNull();
	});

	it("offers nothing for a folder without a copy", async () => {
		const { data, copy } = await load();
		const project = await data.addProject(projectDir, "Plain");
		expect(await copy.boardCopyOfferForNewProject(project)).toBeNull();
		expect(await copy.restoreBoardCopy(project.id)).toEqual({ ok: false, reason: "no-copy" });
	});
});
