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
	it("decodes to effective tmux and is never backfilled by a cold read, a cached read, or an unrelated write", async () => {
		seedTasks([legacyRecord()]);
		const [task] = await loadTasks(testProject);
		expect(readTaskTerminalBackend(task)).toEqual({ ok: true, backend: "tmux", present: false });
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");

		const [warm] = await loadTasks(testProject); // second read hits the tasks cache
		expect(warm).not.toHaveProperty("terminalBackend");

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
	// An explicit tmux preference must stay byte-identical to the legacy write —
	// an unmarked record is what older builds can still read. Windows has no tmux
	// runtime, so the preference cannot select it there.
	it("marks win32 always native and POSIX native only on an opt-in preference", () => {
		expect(newTaskTerminalBackend("win32")).toBe("native");
		expect(newTaskTerminalBackend("win32", "tmux")).toBe("native");
		expect(newTaskTerminalBackend("win32", null)).toBe("native");
		expect(newTaskTerminalBackend("darwin", "native")).toBe("native");
		expect(newTaskTerminalBackend("linux", "native")).toBe("native");
		for (const pref of [undefined, null, "tmux"] as const) {
			expect(newTaskTerminalBackend("darwin", pref), String(pref)).toBeNull();
			expect(newTaskTerminalBackend("linux", pref), String(pref)).toBeNull();
		}
	});

});

// ============================================================
// The machine-local new-task preference, through the creation seam
// ============================================================

describe("the new-task terminal backend preference", () => {
	/**
	 * Seed the SIDECAR, not settings.json — the preference deliberately lives
	 * outside the whitelisted settings file (see terminal-backend-preference.ts).
	 */
	function writePreference(value: unknown): void {
		mkdirSync(TEST_HOME, { recursive: true });
		writeFileSync(
			`${TEST_HOME}/terminal-backend.json`,
			JSON.stringify({ version: 1, newTaskBackend: value }),
			"utf-8",
		);
	}

	it("stamps native on every creation path once opted in", async () => {
		writePreference("native");
		const plain = await addTask(testProject, "Fresh task");
		const scratch = await addTask(testProject, "Scratch — 01:08", "todo", { scratch: true });
		const variant = await addTask(testProject, "Variant", "todo", { groupId: "g", autoVariantIndex: true });
		for (const task of [plain, scratch, variant]) {
			expect(task.terminalBackend).toBe("native");
		}
		expect(readSavedTasks().every((task) => task.terminalBackend === "native")).toBe(true);
	});

	it("leaves new tasks unmarked with no sidecar, a tmux preference, or a garbage one", async () => {
		const cases: Array<[label: string, seed: () => void]> = [
			["no sidecar file", () => rmSync(`${TEST_HOME}/terminal-backend.json`, { force: true })],
			["tmux", () => writePreference("tmux")],
			["unknown identity", () => writePreference("screen")],
			["wrong type", () => writePreference(7)],
			["missing value", () => writePreference(undefined)],
			["future schema version", () => {
				mkdirSync(TEST_HOME, { recursive: true });
				writeFileSync(
					`${TEST_HOME}/terminal-backend.json`,
					JSON.stringify({ version: 99, newTaskBackend: "native" }),
					"utf-8",
				);
			}],
			["corrupt json", () => {
				mkdirSync(TEST_HOME, { recursive: true });
				writeFileSync(`${TEST_HOME}/terminal-backend.json`, "{not json", "utf-8");
			}],
		];
		for (const [label, seed] of cases) {
			rmSync(`${TEST_HOME}/data`, { recursive: true, force: true });
			_resetDataCaches();
			seed();
			const created = await addTask(testProject, "Fresh task");
			expect(created, `preference: ${label}`).not.toHaveProperty("terminalBackend");
		}
	});

	it("never rewrites tasks that already exist when the preference flips", async () => {
		writePreference("tmux");
		const before = await addTask(testProject, "Existing");
		writePreference("native");
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
	it("stamps new tasks, Scratch included, with an explicit native identity", async () => {
		const created = await addTask(testProject, "Fresh task");
		expect(created.terminalBackend).toBe("native");
		expect(readSavedTasks()[0].terminalBackend).toBe("native");
		expect(readTaskTerminalBackend(created)).toMatchObject({ ok: true, backend: "native", present: true });
		const scratch = await addTask(testProject, "Scratch — 01:08", "todo", { scratch: true });
		expect(scratch.scratch).toBe(true);
		expect(scratch.terminalBackend).toBe("native");
	});

	it("leaves an existing unmarked task alone and keeps an explicit tmux identity readable", async () => {
		seedTasks([legacyRecord()]);
		const [legacy] = await loadTasks(testProject);
		expect(legacy).not.toHaveProperty("terminalBackend");
		expect(readTaskTerminalBackend(legacy)).toMatchObject({ ok: true, backend: "tmux", present: false });

		const created = await addTask(testProject, "Fresh task");
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");

		// An explicit tmux identity stays readable instead of being reinterpreted.
		await setTaskTerminalBackend(testProject, created.id, "tmux");
		const saved = (await loadTasks(testProject)).find((t) => t.id === created.id)!;
		expect(readTaskTerminalBackend(saved)).toMatchObject({ ok: true, backend: "tmux", present: true });
	});
});

// ============================================================
// Explicit identities — persistence and round-trip
// ============================================================

describe("setTaskTerminalBackend", () => {
	it("persists an explicit identity on the targeted task only, across a reload and an unrelated update", async () => {
		seedTasks([legacyRecord(), legacyRecord({ id: "B", seq: 2 })]);

		const updated = await setTaskTerminalBackend(testProject, "A", "native");
		expect(updated.terminalBackend).toBe("native");
		const saved = readSavedTasks();
		expect(saved.find((t) => t.id === "A")!.terminalBackend).toBe("native");
		expect(saved.find((t) => t.id === "B")).not.toHaveProperty("terminalBackend");

		await updateTask(testProject, "A", { status: "review-by-user" });
		const [reloaded] = await reloadTasks();
		expect(reloaded.status).toBe("review-by-user");
		expect(readTaskTerminalBackend(reloaded)).toEqual({ ok: true, backend: "native", present: true });

		await setTaskTerminalBackend(testProject, "A", "tmux");
		const [back] = await reloadTasks();
		expect(readTaskTerminalBackend(back)).toEqual({ ok: true, backend: "tmux", present: true });
	});

	it("does not rewrite the file when the value already matches", async () => {
		seedTasks([legacyRecord()]);
		await setTaskTerminalBackend(testProject, "A", "native");
		const before = readFileSync(tasksFilePath(), "utf8");

		await setTaskTerminalBackend(testProject, "A", "native");
		expect(readFileSync(tasksFilePath(), "utf8")).toBe(before);
	});

	it("rejects an unsupported identity and an unknown task id without writing", async () => {
		seedTasks([legacyRecord()]);
		await expect(
			setTaskTerminalBackend(testProject, "A", "wezterm" as never),
		).rejects.toThrow(/Unsupported terminal backend identity/);
		expect(readSavedTasks()[0]).not.toHaveProperty("terminalBackend");
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

		// Never falls back to tmux or promotes to native on failure.
		expect(readTaskTerminalBackend(task)).not.toHaveProperty("backend");

		// The bad value stays on disk untouched (no silent repair).
		await updateTask(testProject, "A", { title: "Renamed" });
		expect(readSavedTasks()[0].terminalBackend).toBe("wezterm");
	});

	it("reports invalid-type for non-string values", async () => {
		for (const value of [1, null, ["native"]]) {
			_resetDataCaches();
			seedTasks([legacyRecord({ terminalBackend: value })]);
			const [task] = await loadTasks(testProject);
			expect(readTaskTerminalBackend(task), JSON.stringify(value)).toMatchObject({ ok: false, code: "invalid-type" });
		}
	});

});

// ============================================================
// Cache paths
// ============================================================

describe("cache paths", () => {
	it("serves the same identity cached as from disk, and reflects a fresh write", async () => {
		seedTasks([legacyRecord({ terminalBackend: "native" })]);

		const [cold] = await loadTasks(testProject);
		const [warm] = await loadTasks(testProject); // second read hits the tasks cache
		expect(readTaskTerminalBackend(warm)).toEqual(readTaskTerminalBackend(cold));

		// A freshly written identity shows without an explicit cache reset.
		await setTaskTerminalBackend(testProject, "A", "tmux");

		const [task] = await loadTasks(testProject);
		expect(readTaskTerminalBackend(task)).toEqual({ ok: true, backend: "tmux", present: true });
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

		// An older build dropping the field degrades back to effective tmux, not native.
		simulateOldVersionWrite((t) => {
			delete t.terminalBackend; // a hypothetical old build that rebuilt the record
		});
		const [dropped] = await reloadTasks();
		expect(readTaskTerminalBackend(dropped)).toEqual({ ok: true, backend: "tmux", present: false });
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


});
