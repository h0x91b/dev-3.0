import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Automation, Project } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test-automations",
	OPS_DIR: "/tmp/dev3-test-automations/ops",
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync("/tmp/dev3-test-automations", { recursive: true, force: true });
	mkdirSync("/tmp/dev3-test-automations", { recursive: true });
});

import {
	AutomationValidationError,
	addAutomation,
	automationsFile,
	computeNextRunAt,
	deleteAutomation,
	getAutomation,
	loadAutomations,
	recordAutomationRuns,
	updateAutomation,
} from "../automations-data";

const project: Project = {
	id: "proj-1",
	name: "Test Project",
	path: "/tmp/test-repo",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-01-01T00:00:00Z",
};

const draft = {
	name: "Nightly sweep",
	prompt: "Run the nightly dependency sweep.",
	rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
	timezone: "UTC",
};

describe("addAutomation", () => {
	it("creates and persists an automation with a computed nextRunAt", async () => {
		const a = await addAutomation(project, draft);
		expect(a.name).toBe("Nightly sweep");
		expect(a.enabled).toBe(true);
		expect(a.catchUp).toBe("skip");
		expect(a.nextRunAt).not.toBeNull();
		expect(new Date(a.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

		const onDisk = JSON.parse(readFileSync(automationsFile(project), "utf8")) as Automation[];
		expect(onDisk).toHaveLength(1);
		expect(onDisk[0].id).toBe(a.id);
	});

	it("rejects an invalid rrule", async () => {
		await expect(addAutomation(project, { ...draft, rrule: "FREQ=YEARLY" })).rejects.toThrow(AutomationValidationError);
	});

	it("rejects an invalid timezone", async () => {
		await expect(addAutomation(project, { ...draft, timezone: "Mars/Olympus" })).rejects.toThrow(AutomationValidationError);
	});

	it("rejects empty name and prompt", async () => {
		await expect(addAutomation(project, { ...draft, name: "  " })).rejects.toThrow(AutomationValidationError);
		await expect(addAutomation(project, { ...draft, prompt: "" })).rejects.toThrow(AutomationValidationError);
	});
});

describe("updateAutomation", () => {
	it("recomputes nextRunAt when the schedule changes", async () => {
		const a = await addAutomation(project, draft);
		const updated = await updateAutomation(project, a.id, { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8" });
		expect(updated.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;BYHOUR=8");
		expect(updated.nextRunAt).not.toBe(a.nextRunAt);
		// Next Monday 08:00 UTC.
		expect(new Date(updated.nextRunAt!).getUTCDay()).toBe(1);
	});

	it("clears nextRunAt when disabled and restores it when re-enabled", async () => {
		const a = await addAutomation(project, draft);
		const disabled = await updateAutomation(project, a.id, { enabled: false });
		expect(disabled.nextRunAt).toBeNull();
		const enabled = await updateAutomation(project, a.id, { enabled: true });
		expect(enabled.nextRunAt).not.toBeNull();
	});

	it("keeps nextRunAt when only the prompt changes", async () => {
		const a = await addAutomation(project, draft);
		const updated = await updateAutomation(project, a.id, { prompt: "New prompt" });
		expect(updated.nextRunAt).toBe(a.nextRunAt);
		expect(updated.prompt).toBe("New prompt");
	});

	it("throws for a missing automation", async () => {
		await expect(updateAutomation(project, "nope", { name: "x" })).rejects.toThrow("Automation not found");
	});
});

describe("deleteAutomation / getAutomation", () => {
	it("deletes and errors on a second delete", async () => {
		const a = await addAutomation(project, draft);
		await deleteAutomation(project, a.id);
		expect(await loadAutomations(project)).toHaveLength(0);
		await expect(deleteAutomation(project, a.id)).rejects.toThrow("Automation not found");
	});

	it("getAutomation resolves by id prefix", async () => {
		const a = await addAutomation(project, draft);
		const found = await getAutomation(project, a.id.slice(0, 8));
		expect(found.id).toBe(a.id);
	});
});

describe("recordAutomationRuns", () => {
	it("prepends runs, caps history, and advances nextRunAt", async () => {
		const a = await addAutomation(project, draft);
		const mkRun = (i: number) => ({
			id: `run-${i}`,
			scheduledFor: new Date(Date.UTC(2026, 0, 1 + i, 9)).toISOString(),
			firedAt: new Date(Date.UTC(2026, 0, 1 + i, 9)).toISOString(),
			status: "created" as const,
			taskId: `task-${i}`,
		});
		for (let i = 0; i < 25; i++) {
			await recordAutomationRuns(project, a.id, [mkRun(i)]);
		}
		const updated = await recordAutomationRuns(project, a.id, [], { nextRunAt: "2026-12-31T09:00:00.000Z" });
		expect(updated.runs.length).toBe(20); // MAX_AUTOMATION_RUNS_KEPT
		expect(updated.runs[0].id).toBe("run-24"); // newest first
		expect(updated.nextRunAt).toBe("2026-12-31T09:00:00.000Z");
	});
});

describe("loadAutomations backfill", () => {
	it("backfills missing fields from an older file", async () => {
		const file = automationsFile(project);
		mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		writeFileSync(file, JSON.stringify([{
			id: "old-1",
			projectId: project.id,
			name: "Old",
			prompt: "p",
			rrule: "FREQ=DAILY",
			timezone: "UTC",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		}]));
		const [a] = await loadAutomations(project);
		expect(a.runs).toEqual([]);
		expect(a.catchUp).toBe("skip");
		expect(a.enabled).toBe(true);
		expect(a.nextRunAt).toBeNull();
		expect(a.agentId).toBeNull();
	});

	it("returns [] for a missing file", async () => {
		expect(await loadAutomations(project)).toEqual([]);
	});
});

describe("computeNextRunAt", () => {
	it("returns null when disabled", () => {
		expect(computeNextRunAt({ rrule: "FREQ=DAILY", timezone: "UTC", enabled: false, createdAt: "2026-01-01T00:00:00Z" })).toBeNull();
	});

	it("returns null for an unparseable rule instead of throwing", () => {
		expect(computeNextRunAt({ rrule: "garbage", timezone: "UTC", enabled: true, createdAt: "2026-01-01T00:00:00Z" })).toBeNull();
	});
});
