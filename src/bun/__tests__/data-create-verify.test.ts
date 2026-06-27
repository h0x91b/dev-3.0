import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Project, Task } from "../../shared/types";

// Mock node:fs/promises so we can simulate a *silent write drop*: the payload
// write "succeeds" (no throw) but the new task never actually lands on disk.
// This is the failure mode the vents describe — `task create` reports success
// (id + seq consumed) yet the task is never queryable. The real-world triggers
// are FDA/sandbox losing fs access mid-write or another instance clobbering the
// file; here we reproduce the observable symptom deterministically by writing an
// empty array instead of the requested payload. Only the main tasks.json payload
// write is intercepted; backups and every other fs op use the real impl.
let dropTasksWrite = false;
vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	// Matches the live tasks.json AND its `.tmp-<pid>` sibling (atomicWriteFile),
	// but NOT the dated backup files under tasks-backups/.
	const isTasksPayloadWrite = (p: string): boolean => !p.includes(".bak") && p.includes("tasks.json");
	return {
		...actual,
		writeFile: vi.fn(async (path: any, data: any, opts?: any) => {
			const p = String(path);
			if (dropTasksWrite && isTasksPayloadWrite(p)) {
				return actual.writeFile(p, "[]", opts);
			}
			return actual.writeFile(path, data, opts);
		}),
	};
});

const tempHome = mkdtempSync(join(tmpdir(), "dev3-create-verify-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;
const tasksDir = join(dev3Home, "data", "tmp-existing-project");
const tasksFile = join(tasksDir, "tasks.json");

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "Existing Project",
		path: "/tmp/existing-project",
		setupScript: "",
		setupScriptLaunchMode: "parallel",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-04-15T00:00:00.000Z",
		labels: [],
		customColumns: [],
		...overrides,
	};
}

describe("addTask verifies persistence before returning", () => {
	beforeEach(() => {
		dropTasksWrite = false;
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([makeProject()], null, 2));
	});

	afterEach(() => {
		dropTasksWrite = false;
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("throws (instead of returning a ghost task) when the write is silently dropped", async () => {
		const data = await import("../data");

		dropTasksWrite = true;
		await expect(data.addTask(makeProject(), "Ghost task", "todo")).rejects.toThrow(/persist/i);
		dropTasksWrite = false;

		// The task must genuinely NOT be on disk — confirming the throw reflects a
		// real persistence failure, not a false alarm.
		const onDisk = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		expect(onDisk.find((t) => t.description === "Ghost task")).toBeUndefined();
	});

	it("returns a task that is immediately readable from disk on a healthy write", async () => {
		const data = await import("../data");

		const task = await data.addTask(makeProject(), "Real task", "todo");

		const onDisk = JSON.parse(readFileSync(tasksFile, "utf8")) as Task[];
		expect(onDisk.find((t) => t.id === task.id)).toBeDefined();
		expect(task.description).toBe("Real task");
	});
});
