import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

const tasks = new Map<string, Task>();
vi.mock("../data", () => ({
	getProject: vi.fn(async (id: string) => ({ id, path: "/home/me/notes" })),
	getTask: vi.fn(async (_project: Project, id: string) => {
		const task = tasks.get(id);
		if (!task) throw new Error("not found");
		return task;
	}),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { claimFileForTask, fileLeaseKey } = await import("../file-leases");

const folder = mkdtempSync(join(tmpdir(), "dev3-leases-"));
const project = { id: "p1", path: folder } as Project;
let n = 0;

function liveTask(overrides: Partial<Task> = {}): Task {
	n += 1;
	const task = { id: `task-${n}`, seq: n, title: `Task ${n}`, status: "in-progress", projectId: "p1", worktreePath: folder, ...overrides } as Task;
	tasks.set(task.id, task);
	return task;
}

beforeEach(() => tasks.clear());
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("claimFileForTask in a shared folder", () => {
	it("refuses a second live task and names the holder", async () => {
		const file = join(folder, "refuse.md");
		const a = liveTask({ title: "Draft auth ADR" });
		const b = liveTask();

		expect(await claimFileForTask(project, a, file, 0)).toBeNull();
		const conflict = await claimFileForTask(project, b, file, 60_000);

		expect(conflict).toMatchObject({ holderTaskId: a.id, holderSeq: a.seq, holderTitle: "Draft auth ADR", fileName: "refuse.md", minutesLeft: 9 });
	});

	it("hands the file over when the holder's run has ended", async () => {
		const file = join(folder, "ended.md");
		const a = liveTask();
		const b = liveTask();
		await claimFileForTask(project, a, file, 0);
		tasks.set(a.id, { ...a, status: "completed" });

		expect(await claimFileForTask(project, b, file, 1_000)).toBeNull();
		// b holds it now.
		expect(await claimFileForTask(project, liveTask(), file, 2_000)).toMatchObject({ holderTaskId: b.id });
	});

	it("claims nothing for a task in its own worktree", async () => {
		const owned = { ...liveTask(), worktreePath: null } as Task;
		const file = join(folder, "owned.md");
		expect(await claimFileForTask(project, owned, file, 0)).toBeNull();
		expect(await claimFileForTask(project, liveTask(), file, 1)).toBeNull();
	});
});

describe("fileLeaseKey", () => {
	it("sees one file through a symlinked folder, and a file that does not exist yet", () => {
		const real = join(folder, "real");
		mkdirSync(real);
		writeFileSync(join(real, "a.md"), "x");
		symlinkSync(real, join(folder, "link"));
		expect(fileLeaseKey(join(folder, "link", "a.md"))).toBe(fileLeaseKey(join(real, "a.md")));
		expect(fileLeaseKey(join(folder, "link", "new.md"))).toBe(fileLeaseKey(join(real, "new.md")));
	});

	it("folds case where the filesystem ignores it", () => {
		expect(fileLeaseKey("/nowhere/A.md", "darwin")).toBe("/nowhere/a.md");
		expect(fileLeaseKey("/nowhere/A.md", "linux")).toBe("/nowhere/A.md");
	});
});
