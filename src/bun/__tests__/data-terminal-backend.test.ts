import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-terminal-backend`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	_resetDataCaches();
});

import {
	_resetDataCaches,
	addTask,
	newTaskTerminalBackend,
	loadTasks,
	readTaskTerminalBackend,
	setTaskTerminalBackend,
	updateTask,
} from "../data";

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

function tasksFilePath(): string {
	return `${TEST_HOME}/data/tmp-test-project/tasks.json`;
}

/** Raw on-disk shape written by a build that predates `terminalBackend`. */
function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "A",
		seq: 1,
		projectId: "proj-1",
		title: "Old task",
		description: "d",
		status: "todo",
		priority: "P3",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		labelIds: [],
		...overrides,
	};
}

function seedTasks(tasks: Array<Record<string, unknown>>): void {
	mkdirSync(dirname(tasksFilePath()), { recursive: true });
	writeFileSync(tasksFilePath(), JSON.stringify(tasks, null, 2));
}

function readSavedTasks(): Array<Record<string, unknown>> {
	return JSON.parse(readFileSync(tasksFilePath(), "utf8"));
}

/** Fresh process / app reload: nothing may be served from an in-memory cache. */
async function reloadTasks(): Promise<Task[]> {
	_resetDataCaches();
	return loadTasks(testProject);
}

// ============================================================
// Legacy records — absence means effective tmux, forever
// ============================================================

describe("legacy records without terminalBackend", () => {
	it("decodes to effective tmux while reporting the field as absent", async () => {
		seedTasks([legacyRecord()]);
		const [task] = await loadTasks(testProject);

		const decoded = readTaskTerminalBackend(task);
		expect(decoded).toEqual({ ok: true, backend: "tmux", present: false });
	});

	it("is not backfilled by a pure read", async () => {
		seedTasks([legacyRecord()]);
		await loadTasks(testProject);
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");
	});

	it("is not backfilled by an unrelated write", async () => {
		seedTasks([legacyRecord()]);
		await updateTask(testProject, "A", { status: "in-progress" });

		const saved = readSavedTasks()[0];
		expect(saved.status).toBe("in-progress");
		expect(saved).not.toHaveProperty("terminalBackend");
	});

	it("is not stamped onto tasks created on POSIX", async () => {
		const created = await addTask(testProject, "Fresh task");
		expect(created).not.toHaveProperty("terminalBackend");
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");
		expect(readTaskTerminalBackend(created).ok && readTaskTerminalBackend(created)).toMatchObject({
			backend: "tmux",
			present: false,
		});
	});

	it("keeps unrelated and unknown-future sibling fields intact across a write", async () => {
		seedTasks([legacyRecord({ terminalBackendCapabilities: ["images"], someFutureField: 7 })]);
		await updateTask(testProject, "A", { title: "Renamed" });

		const saved = readSavedTasks()[0];
		expect(saved.terminalBackendCapabilities).toEqual(["images"]);
		expect(saved.someFutureField).toBe(7);
		expect(saved).not.toHaveProperty("terminalBackend");
	});
});

// ============================================================
// New tasks on Windows — stamped at creation, never by the resolver
// ============================================================

describe("newTaskTerminalBackend", () => {
	it("marks win32 native and leaves every POSIX platform unmarked", () => {
		expect(newTaskTerminalBackend("win32")).toBe("native");
		expect(newTaskTerminalBackend("darwin")).toBeNull();
		expect(newTaskTerminalBackend("linux")).toBeNull();
	});

	it("stamps native on POSIX only when the machine-local preference opts in", () => {
		expect(newTaskTerminalBackend("darwin", "native")).toBe("native");
		expect(newTaskTerminalBackend("linux", "native")).toBe("native");
	});

	// An explicit tmux preference must stay byte-identical to the legacy write —
	// an unmarked record is what older builds can still read.
	it("leaves POSIX records unmarked for a tmux preference and for no preference", () => {
		expect(newTaskTerminalBackend("darwin", "tmux")).toBeNull();
		expect(newTaskTerminalBackend("linux", "tmux")).toBeNull();
		expect(newTaskTerminalBackend("darwin", null)).toBeNull();
		expect(newTaskTerminalBackend("darwin", undefined)).toBeNull();
	});

	// Windows has no tmux runtime at all, so the preference cannot select it.
	it("keeps win32 native regardless of the preference", () => {
		expect(newTaskTerminalBackend("win32", "tmux")).toBe("native");
		expect(newTaskTerminalBackend("win32", null)).toBe("native");
	});
});

// ============================================================
// The machine-local new-task preference, through the creation seam
// ============================================================

describe("the new-task terminal backend preference", () => {
	function writeSettings(value: unknown): void {
		mkdirSync(TEST_HOME, { recursive: true });
		writeFileSync(
			`${TEST_HOME}/settings.json`,
			JSON.stringify({ defaultAgentId: "builtin-claude", newTaskTerminalBackend: value }),
			"utf-8",
		);
	}

	it("stamps native on every creation path once opted in", async () => {
		writeSettings("native");
		const plain = await addTask(testProject, "Fresh task");
		const scratch = await addTask(testProject, "Scratch — 01:08", "todo", { scratch: true });
		const variant = await addTask(testProject, "Variant", "todo", { groupId: "g", autoVariantIndex: true });
		for (const task of [plain, scratch, variant]) {
			expect(task.terminalBackend).toBe("native");
		}
		expect(readSavedTasks().every((task) => task.terminalBackend === "native")).toBe(true);
	});

	it("leaves new tasks unmarked when the preference is absent, tmux, or garbage", async () => {
		for (const stored of [undefined, "tmux", "nonsense", 7]) {
			rmSync(`${TEST_HOME}/data`, { recursive: true, force: true });
			_resetDataCaches();
			writeSettings(stored);
			const created = await addTask(testProject, "Fresh task");
			expect(created, `preference ${JSON.stringify(stored)}`).not.toHaveProperty("terminalBackend");
		}
	});

	it("never rewrites tasks that already exist when the preference flips", async () => {
		writeSettings("tmux");
		const before = await addTask(testProject, "Existing");
		writeSettings("native");
		await addTask(testProject, "Later");

		const saved = readSavedTasks();
		expect(saved.find((task) => task.id === before.id)).not.toHaveProperty("terminalBackend");
		expect(saved.find((task) => task.title === "Later")?.terminalBackend).toBe("native");
	});
});

describe("task creation on Windows", () => {
	const realPlatform = process.platform;
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "win32", writable: true });
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform, writable: true });
	});

	// Windows has no tmux, so an unmarked task there could never launch. The
	// marker is written at creation instead of teaching the resolver a platform.
	it("stamps a new task with an explicit native identity", async () => {
		const created = await addTask(testProject, "Fresh task");
		expect(created.terminalBackend).toBe("native");
		expect(readSavedTasks()[0].terminalBackend).toBe("native");
		expect(readTaskTerminalBackend(created)).toMatchObject({ ok: true, backend: "native", present: true });
	});

	it("stamps a Scratch task the same way", async () => {
		const created = await addTask(testProject, "Scratch — 01:08", "todo", { scratch: true });
		expect(created.scratch).toBe(true);
		expect(created.terminalBackend).toBe("native");
	});

	it("leaves an existing unmarked task alone — no backfill, still tmux", async () => {
		seedTasks([legacyRecord()]);
		const [legacy] = await loadTasks(testProject);
		expect(legacy).not.toHaveProperty("terminalBackend");
		expect(readTaskTerminalBackend(legacy)).toMatchObject({ ok: true, backend: "tmux", present: false });

		await addTask(testProject, "Fresh task");
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");
	});

	it("keeps an explicit tmux identity readable instead of reinterpreting it", async () => {
		const created = await addTask(testProject, "Fresh task");
		await setTaskTerminalBackend(testProject, created.id, "tmux");
		const [saved] = await loadTasks(testProject);
		expect(readTaskTerminalBackend(saved)).toMatchObject({ ok: true, backend: "tmux", present: true });
	});
});

// ============================================================
// Explicit identities — persistence and round-trip
// ============================================================

describe("setTaskTerminalBackend", () => {
	it.each(["tmux", "native"] as const)("persists an explicit %s across a reload", async (backend) => {
		seedTasks([legacyRecord()]);

		const updated = await setTaskTerminalBackend(testProject, "A", backend);
		expect(updated.terminalBackend).toBe(backend);
		expect(readSavedTasks()[0].terminalBackend).toBe(backend);

		const [reloaded] = await reloadTasks();
		expect(readTaskTerminalBackend(reloaded)).toEqual({ ok: true, backend, present: true });
	});

	it("survives an unrelated task update", async () => {
		seedTasks([legacyRecord()]);
		await setTaskTerminalBackend(testProject, "A", "native");
		await updateTask(testProject, "A", { status: "review-by-user" });

		const [reloaded] = await reloadTasks();
		expect(reloaded.status).toBe("review-by-user");
		expect(readTaskTerminalBackend(reloaded)).toEqual({ ok: true, backend: "native", present: true });
	});

	it("only touches the targeted task", async () => {
		seedTasks([legacyRecord(), legacyRecord({ id: "B", seq: 2 })]);
		await setTaskTerminalBackend(testProject, "A", "native");

		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "A")!.terminalBackend).toBe("native");
		expect(saved.find((t) => t.id === "B")).not.toHaveProperty("terminalBackend");
	});

	it("does not rewrite the file when the value already matches", async () => {
		seedTasks([legacyRecord()]);
		await setTaskTerminalBackend(testProject, "A", "native");
		const before = readFileSync(tasksFilePath(), "utf8");

		await setTaskTerminalBackend(testProject, "A", "native");
		expect(readFileSync(tasksFilePath(), "utf8")).toBe(before);
	});

	it("rejects an unsupported identity instead of writing it", async () => {
		seedTasks([legacyRecord()]);
		await expect(
			setTaskTerminalBackend(testProject, "A", "wezterm" as never),
		).rejects.toThrow(/Unsupported terminal backend identity/);
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");
	});

	it("throws for an unknown task id", async () => {
		seedTasks([legacyRecord()]);
		await expect(setTaskTerminalBackend(testProject, "missing", "native")).rejects.toThrow(/Task not found/);
	});
});

// ============================================================
// Invalid stored values — fail honestly, never select native
// ============================================================

describe("invalid persisted values", () => {
	it("reports unknown-value for an identity this build cannot decode", async () => {
		seedTasks([legacyRecord({ terminalBackend: "wezterm" })]);
		const [task] = await loadTasks(testProject);

		expect(readTaskTerminalBackend(task)).toEqual({ ok: false, code: "unknown-value", received: "wezterm" });
	});

	it.each([1, null, true, {}, ["native"]])("reports invalid-type for %o", async (value) => {
		seedTasks([legacyRecord({ terminalBackend: value })]);
		const [task] = await loadTasks(testProject);

		const decoded = readTaskTerminalBackend(task);
		expect(decoded.ok).toBe(false);
		expect(decoded).toMatchObject({ code: "invalid-type" });
	});

	it("never falls back to tmux or promotes to native on failure", async () => {
		seedTasks([legacyRecord({ terminalBackend: "WEZTERM" })]);
		const [task] = await loadTasks(testProject);

		expect(readTaskTerminalBackend(task)).not.toHaveProperty("backend");
	});

	it("leaves the bad value on disk untouched (no silent repair)", async () => {
		seedTasks([legacyRecord({ terminalBackend: "wezterm" })]);
		await loadTasks(testProject);
		await updateTask(testProject, "A", { title: "Renamed" });

		expect(readSavedTasks()[0].terminalBackend).toBe("wezterm");
	});
});

// ============================================================
// Cache paths
// ============================================================

describe("cache paths", () => {
	it("serves the same identity from the cached read as from disk", async () => {
		seedTasks([legacyRecord({ terminalBackend: "native" })]);

		const [cold] = await loadTasks(testProject);
		const [warm] = await loadTasks(testProject); // second read hits the tasks cache
		expect(readTaskTerminalBackend(warm)).toEqual(readTaskTerminalBackend(cold));
	});

	it("does not backfill through a cached read of a legacy record", async () => {
		seedTasks([legacyRecord()]);
		await loadTasks(testProject);
		const [warm] = await loadTasks(testProject);

		expect(warm).not.toHaveProperty("terminalBackend");
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");
	});

	it("reflects a freshly written identity without an explicit cache reset", async () => {
		seedTasks([legacyRecord()]);
		await loadTasks(testProject); // warm the cache with the legacy shape
		await setTaskTerminalBackend(testProject, "A", "native");

		const [task] = await loadTasks(testProject);
		expect(readTaskTerminalBackend(task)).toEqual({ ok: true, backend: "native", present: true });
	});
});

// ============================================================
// old → new → old compatibility
// ============================================================

describe("old/new/old compatibility", () => {
	/** An older build rewrites the file: it spreads unknown fields through untouched. */
	function simulateOldVersionWrite(mutate: (task: Record<string, unknown>) => void): void {
		const tasks = readSavedTasks();
		for (const task of tasks) mutate(task);
		writeFileSync(tasksFilePath(), JSON.stringify(tasks, null, 2));
	}

	it("keeps the identity when an older build edits the same record", async () => {
		seedTasks([legacyRecord()]);
		await setTaskTerminalBackend(testProject, "A", "native");

		simulateOldVersionWrite((t) => {
			t.title = "Edited by an old build";
			t.updatedAt = "2026-01-01T00:00:00Z";
		});

		const [reloaded] = await reloadTasks();
		expect(reloaded.title).toBe("Edited by an old build");
		expect(readTaskTerminalBackend(reloaded)).toEqual({ ok: true, backend: "native", present: true });
	});

	it("stays legacy when an older build never adds the field", async () => {
		seedTasks([legacyRecord()]);
		await updateTask(testProject, "A", { status: "in-progress" });
		simulateOldVersionWrite((t) => {
			t.title = "Old build again";
		});

		const [reloaded] = await reloadTasks();
		expect(reloaded).not.toHaveProperty("terminalBackend");
		expect(readTaskTerminalBackend(reloaded)).toEqual({ ok: true, backend: "tmux", present: false });
	});

	it("an older build dropping the field degrades back to effective tmux, not native", async () => {
		seedTasks([legacyRecord()]);
		await setTaskTerminalBackend(testProject, "A", "native");
		simulateOldVersionWrite((t) => {
			delete t.terminalBackend; // a hypothetical old build that rebuilt the record
		});

		const [reloaded] = await reloadTasks();
		expect(readTaskTerminalBackend(reloaded)).toEqual({ ok: true, backend: "tmux", present: false });
	});
});
