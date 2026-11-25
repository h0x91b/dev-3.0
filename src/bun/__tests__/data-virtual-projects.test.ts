import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const DEV3_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-virtual-projects`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME,
	OPS_DIR: `${DEV3_HOME}/ops`,
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

const VIRTUAL_FILE = `${DEV3_HOME}/virtual-projects.json`;

beforeEach(async () => {
	rmSync(DEV3_HOME, { recursive: true, force: true });
	mkdirSync(DEV3_HOME, { recursive: true });
	const { _resetDataCaches } = await import("../data");
	_resetDataCaches();
});

import {
	addProject,
	addVirtualProject,
	ensureBuiltinOperationsBoard,
	getProject,
	loadProjects,
	loadVirtualProjects,
	removeProject,
	updateProject,
	updateProjectWith,
} from "../data";

describe("addVirtualProject", () => {
	it("creates a virtual project under ops/ with a readable slug", async () => {
		const project = await addVirtualProject("Operations");
		expect(project.kind).toBe("virtual");
		expect(project.path).toBe(`${DEV3_HOME}/ops/operations`);
		expect(project.defaultBaseBranch).toBe("");
		// Stored in the SEPARATE file, not projects.json.
		expect(existsSync(VIRTUAL_FILE)).toBe(true);
		expect(existsSync(`${DEV3_HOME}/projects.json`)).toBe(false);
		// The slug is derived from the board name.
		expect((await addVirtualProject("Mail triage")).path).toBe(`${DEV3_HOME}/ops/mail-triage`);
	});

	it("allocates a non-colliding slug for a second board with the same name", async () => {
		const a = await addVirtualProject("Operations");
		const b = await addVirtualProject("Operations");
		expect(a.path).toBe(`${DEV3_HOME}/ops/operations`);
		expect(b.path).toBe(`${DEV3_HOME}/ops/operations-2`);
		expect(a.id).not.toBe(b.id);
	});

	it("never reuses a slug while its data/ dir survives", async () => {
		// Simulate a deleted-then-recreated board: the munged data dir survives.
		const opsPath = `${DEV3_HOME}/ops/operations`;
		const survivingDataDir = `${DEV3_HOME}/data/${opsPath.replace(/^\//, "").replaceAll("/", "-")}`;
		mkdirSync(survivingDataDir, { recursive: true });
		const project = await addVirtualProject("Operations");
		expect(project.path).toBe(`${DEV3_HOME}/ops/operations-2`);
	});

	it("does not collide with a git project's data-dir slug", async () => {
		// A git project whose munged path equals the ops data-dir name would collide.
		writeFileSync(`${DEV3_HOME}/projects.json`, JSON.stringify([
			{ id: "g1", name: "g", path: `${DEV3_HOME}/ops/operations`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z", labels: [] },
		]));
		const project = await addVirtualProject("Operations");
		expect(project.path).toBe(`${DEV3_HOME}/ops/operations-2`);
	});
});

describe("loadVirtualProjects", () => {
	it("returns only non-deleted virtual projects, which never appear in loadProjects", async () => {
		const a = await addVirtualProject("Operations");
		await addVirtualProject("Experiments");
		await removeProject(a.id);
		const active = await loadVirtualProjects();
		expect(active.map((p) => p.name)).toEqual(["Experiments"]);
		// Virtual boards never appear in the git list.
		expect(await loadProjects()).toHaveLength(0);
	});
});

describe("ensureBuiltinOperationsBoard", () => {
	it("creates the built-in board once and is idempotent", async () => {
		const first = await ensureBuiltinOperationsBoard("Operations");
		const second = await ensureBuiltinOperationsBoard("Operations");
		expect(first.id).toBe(second.id);
		expect(first.builtin).toBe(true);
		const all = await loadVirtualProjects();
		expect(all.filter((p) => p.builtin)).toHaveLength(1);
	});

	it("refuses to delete the built-in Operations board (would dead-end ⌘0 + orphan tasks)", async () => {
		const board = await ensureBuiltinOperationsBoard("Operations");
		await removeProject(board.id);
		const all = await loadVirtualProjects();
		expect(all.find((p) => p.id === board.id)).toBeTruthy();
		expect(all.filter((p) => p.builtin)).toHaveLength(1);

		// A NON-builtin virtual board is still soft-deleted.
		const other = await addVirtualProject("Experiments");
		expect(other.builtin).toBeFalsy();
		await removeProject(other.id);
		expect((await loadVirtualProjects()).find((p) => p.id === other.id)).toBeFalsy();
	});
});

describe("getProject / updateProject / removeProject routing", () => {
	it("getProject resolves and updateProject routes virtual ids to the virtual file", async () => {
		const project = await addVirtualProject("Operations");
		const found = await getProject(project.id);
		expect(found.id).toBe(project.id);
		expect(found.kind).toBe("virtual");
		const updated = await updateProject(project.id, { peerReviewEnabled: false });
		expect(updated.peerReviewEnabled).toBe(false);
		const reloaded = await loadVirtualProjects();
		expect(reloaded[0].peerReviewEnabled).toBe(false);
		// projects.json must not be created by a virtual update.
		expect(existsSync(`${DEV3_HOME}/projects.json`)).toBe(false);
	});

	it("updateProjectWith routes virtual ids to the virtual file (labels/columns no longer throw)", async () => {
		const project = await addVirtualProject("Operations");
		// Before the fix this threw "Project not found" — it only searched projects.json.
		// Use a real ProjectUpdates field (labels are what the notes/labels callers
		// actually mutate on the Operations board).
		const label = { id: "l1", name: "urgent", color: "#ff0000" };
		const { project: updated, result } = await updateProjectWith(project.id, () => ({
			updates: { labels: [label] },
			result: "ok" as const,
		}));
		expect(result).toBe("ok");
		expect(updated.labels).toEqual([label]);
		const reloaded = await loadVirtualProjects();
		expect(reloaded[0].labels).toEqual([label]);
		expect(existsSync(`${DEV3_HOME}/projects.json`)).toBe(false);
	});

	it("git project ids still route to projects.json via updateProject and updateProjectWith", async () => {
		const git = await addProject("/tmp/some-repo", "Repo");
		const updated = await updateProject(git.id, { autoReviewEnabled: true });
		expect(updated.autoReviewEnabled).toBe(true);
		expect(existsSync(`${DEV3_HOME}/projects.json`)).toBe(true);
		const { result } = await updateProjectWith(git.id, () => ({ updates: { peerReviewEnabled: false }, result: 42 }));
		expect(result).toBe(42);
		expect((await getProject(git.id)).peerReviewEnabled).toBe(false);
	});
});
