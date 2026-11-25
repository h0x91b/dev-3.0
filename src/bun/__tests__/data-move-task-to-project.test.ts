import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Label, Project, ScheduledLaunch, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-move-task-to-project`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

// Both files run their critical section immediately (no real locking in tests).
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { moveTaskToProject, loadTasks } from "../data";
import { projectSlug } from "../git";

const bugSrc: Label = { id: "s-bug", name: "Bug", color: "#ef4444" };
const onlySrc: Label = { id: "s-only", name: "SourceOnly", color: "#14b8a6" };
const bugTgt: Label = { id: "t-bug", name: "Bug", color: "#84cc16" };

const source: Project = {
	id: "proj-src",
	name: "Source",
	path: "/tmp/proj-source",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
	labels: [bugSrc, onlySrc],
	customColumns: [],
};

const target: Project = {
	id: "proj-tgt",
	name: "Target",
	path: "/tmp/proj-target",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "develop",
	createdAt: "2025-01-01T00:00:00Z",
	labels: [bugTgt],
	customColumns: [],
};

function tasksFilePath(project: Project): string {
	return `${TEST_HOME}/data/${projectSlug(project.path)}/tasks.json`;
}

function seed(project: Project, tasks: unknown[]): void {
	const file = tasksFilePath(project);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(tasks));
}

function makeTask(overrides: Partial<Task> & { id: string }): Record<string, unknown> {
	return {
		seq: 1,
		projectId: "proj-src",
		title: "Fix the thing",
		description: "Fix the thing in detail",
		status: "todo",
		priority: "P3",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-02-02T00:00:00Z",
		updatedAt: "2025-02-02T00:00:00Z",
		labelIds: [],
		...overrides,
	};
}

const scheduledLaunch: ScheduledLaunch = {
	at: "2025-03-03T00:00:00Z",
	targetStatus: "in-progress",
	variants: [{ agentId: "builtin-claude", configId: "claude-default" }],
};

describe("moveTaskToProject", () => {
	it("moves a To Do task: same id, fresh seq, re-derived base branch, and cleared project-scoped fields", async () => {
		seed(source, [
			makeTask({
				id: "task-move",
				seq: 7,
				overview: "agent overview",
				userOverview: "user overview",
				automationId: "auto-1",
				customColumnId: "col-x",
				opsWorkDir: "/some/dir",
				attachedRepo: "/some/repo",
				opsWorktree: true,
				scheduledLaunch,
				labelIds: [bugSrc.id, onlySrc.id],
			}),
		]);
		seed(target, [makeTask({ id: "existing", projectId: "proj-tgt", seq: 4 })]);

		const moved = await moveTaskToProject(source, target, "task-move");

		expect(moved.id).toBe("task-move");
		expect(moved.projectId).toBe("proj-tgt");
		expect(moved.seq).toBe(5); // nextSeq over target (max 4 → 5)
		expect(moved.baseBranch).toBe("develop");
		expect(moved.createdAt).toBe("2025-02-02T00:00:00Z"); // creation time preserved
		expect(moved.overview).toBe("agent overview");
		expect(moved.userOverview).toBe("user overview");
		expect(moved.automationId).toBe("auto-1");
		expect(moved.customColumnId).toBeNull();
		expect(moved.opsWorkDir).toBeNull();
		expect(moved.attachedRepo).toBeNull();
		expect(moved.opsWorktree).toBeUndefined();
		expect(moved.scheduledLaunch).toBeNull();

		const targetTasks = await loadTasks(target);
		expect(targetTasks.map((t) => t.id).sort()).toEqual(["existing", "task-move"]);
	});

	it("keeps bare refs in the moved text pointing at the source board", async () => {
		seed(source, [
			makeTask({
				id: "task-refs",
				title: "Follow up seq:3",
				description: "Split from <seq:3>; see <pr:12> and seq:proj-tgt/9",
				customTitle: "Custom seq:3",
				overview: "Waiting on seq:3",
				userOverview: "User: <seq:4>",
				notes: [{ id: "n1", content: "Blocked by seq:5", source: "ai", createdAt: "", updatedAt: "" }],
			}),
		]);
		seed(target, []);

		const moved = await moveTaskToProject(source, target, "task-refs");

		expect(moved.title).toBe("Follow up seq:proj-src/3");
		expect(moved.description).toBe("Split from <seq:proj-src/3>; see <pr:proj-src/12> and seq:proj-tgt/9");
		expect(moved.customTitle).toBe("Custom seq:proj-src/3");
		expect(moved.overview).toBe("Waiting on seq:proj-src/3");
		expect(moved.userOverview).toBe("User: <seq:proj-src/4>");
		expect(moved.notes?.map((n) => n.content)).toEqual(["Blocked by seq:proj-src/5"]);
		expect((await loadTasks(target))[0]!.description).toBe(moved.description);
	});

	it("turns a relative path only the source project holds into its path: token", async () => {
		const srcRoot = `${TEST_HOME}/repo-src`;
		const tgtRoot = `${TEST_HOME}/repo-tgt`;
		for (const file of [`${srcRoot}/todo/brief.md`, `${srcRoot}/README.md`, `${tgtRoot}/README.md`]) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "x");
		}
		const src = { ...source, path: srcRoot };
		const tgt = { ...target, path: tgtRoot };
		seed(src, [
			makeTask({
				id: "task-paths",
				title: "Read todo/brief.md",
				description: "Brief: todo/brief.md:3, see README.md and missing.md\n```\ncat todo/brief.md\n```",
				overview: "Drafting todo/brief.md",
				notes: [{ id: "n1", content: "Updated todo/brief.md", source: "ai", createdAt: "", updatedAt: "" }],
			}),
		]);
		seed(tgt, []);

		const moved = await moveTaskToProject(src, tgt, "task-paths");

		expect(moved.title).toBe("Read todo/brief.md");
		expect(moved.description).toBe("Brief: path:proj-src/todo/brief.md:3, see README.md and missing.md\n```\ncat todo/brief.md\n```");
		expect(moved.overview).toBe("Drafting path:proj-src/todo/brief.md");
		expect(moved.notes?.[0]?.content).toBe("Updated path:proj-src/todo/brief.md");
	});

	it("keeps plain paths when the source is a virtual board", async () => {
		const ops: Project = { ...source, kind: "virtual", path: "" } as Project;
		seed(ops, [makeTask({ id: "task-ops", description: "Brief: todo/brief.md" })]);
		seed(target, []);

		const moved = await moveTaskToProject(ops, target, "task-ops");

		expect(moved.description).toBe("Brief: todo/brief.md");
	});

	it("renames the moved task's refs to itself to its new seq, and leaves history and a qualified ref alone", async () => {
		const history = [{ at: "2025-02-02T00:00:00Z", title: "Self seq:7", overview: null }];
		seed(source, [makeTask({ id: "task-self", seq: 7, description: "This is <seq:7>, split from seq:3; also seq:7 --project proj-tgt", history } as never)]);
		seed(target, [makeTask({ id: "existing", projectId: "proj-tgt", seq: 4 })]);

		const moved = await moveTaskToProject(source, target, "task-self");

		expect(moved.seq).toBe(5);
		expect(moved.description).toBe("This is <seq:5>, split from seq:proj-src/3; also seq:7 --project proj-tgt");
		expect((moved as unknown as { history: unknown }).history).toEqual(history);
	});

	it("removes the task from the source project", async () => {
		seed(source, [makeTask({ id: "a", seq: 1 }), makeTask({ id: "task-move", seq: 2 })]);
		seed(target, []);

		await moveTaskToProject(source, target, "task-move");

		const sourceTasks = await loadTasks(source);
		expect(sourceTasks.map((t) => t.id)).toEqual(["a"]);
		expect(sourceTasks.some((t) => t.id === "task-move")).toBe(false);
	});

	it("remaps a label that exists by name in the target and drops one that does not", async () => {
		seed(source, [makeTask({ id: "task-move", labelIds: [bugSrc.id, onlySrc.id] })]);
		seed(target, []);

		const moved = await moveTaskToProject(source, target, "task-move");

		// "Bug" exists in the target (different id); "SourceOnly" has no twin → dropped.
		expect(moved.labelIds).toEqual([bugTgt.id]);
	});

	it("clears scheduledLaunch on move", async () => {
		seed(source, [makeTask({ id: "task-move", scheduledLaunch })]);
		seed(target, []);

		const moved = await moveTaskToProject(source, target, "task-move");

		expect(moved.scheduledLaunch ?? null).toBeNull();
		const persisted = (await loadTasks(target)).find((t) => t.id === "task-move")!;
		expect(persisted.scheduledLaunch ?? null).toBeNull();
	});

	it("rejects a task that is not in To Do", async () => {
		seed(source, [makeTask({ id: "task-move", status: "in-progress" })]);
		seed(target, []);

		await expect(moveTaskToProject(source, target, "task-move")).rejects.toThrow(/Only To Do tasks/);
		// Source untouched, target still empty.
		expect((await loadTasks(source)).some((t) => t.id === "task-move")).toBe(true);
		expect(await loadTasks(target)).toHaveLength(0);
	});

	it("rejects a move to the same project", async () => {
		seed(source, [makeTask({ id: "task-move" })]);
		await expect(moveTaskToProject(source, source, "task-move")).rejects.toThrow(/already in/);
	});

	it("rejects a move to a deleted project", async () => {
		seed(source, [makeTask({ id: "task-move" })]);
		seed(target, []);
		await expect(moveTaskToProject(source, { ...target, deleted: true }, "task-move")).rejects.toThrow(/deleted/);
	});

	it("supports a cross-kind move (git → virtual Operations board)", async () => {
		const virtualTarget: Project = { ...target, id: "proj-virt", name: "Operations", path: `${TEST_HOME}/ops/operations`, kind: "virtual", defaultBaseBranch: "" };
		seed(source, [makeTask({ id: "task-move" })]);
		seed(virtualTarget, []);

		const moved = await moveTaskToProject(source, virtualTarget, "task-move");

		expect(moved.projectId).toBe("proj-virt");
		expect((await loadTasks(virtualTarget)).some((t) => t.id === "task-move")).toBe(true);
		expect((await loadTasks(source)).some((t) => t.id === "task-move")).toBe(false);
	});

	it("leaves the target column's own tasks untouched — in-column position is derived, not stored", async () => {
		seed(source, [makeTask({ id: "task-move" })]);
		seed(target, [
			makeTask({ id: "t1", projectId: "proj-tgt", seq: 1, columnOrder: 0 }),
			makeTask({ id: "t2", projectId: "proj-tgt", seq: 2, columnOrder: 1 }),
		]);

		await moveTaskToProject(source, target, "task-move");

		const persisted = await loadTasks(target);
		expect(persisted.find((t) => t.id === "t1")!.columnOrder).toBe(0);
		expect(persisted.find((t) => t.id === "t2")!.columnOrder).toBe(1);
	});
});
