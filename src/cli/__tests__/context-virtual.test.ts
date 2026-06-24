import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

import { detectContext, expandShortId, expandShortProjectId, readProjectDirect, readTaskDirect } from "../context";

const HOME = process.env.HOME || "/tmp";
const DEV3_HOME = `${HOME}/.dev3.0`;
const OPS_DIR = `${DEV3_HOME}/ops`;
const DATA_DIR = `${DEV3_HOME}/data`;
const VIRTUAL_FILE = `${DEV3_HOME}/virtual-projects.json`;

const READABLE_SLUG = "test-ops-board";
const SHORT_ID = "deadbeef";
const PROJECT_ID = "vproj-test-123";
const TASK_ID = "deadbeef-1111-2222-3333-444444444444";

const SYNTH_PATH = `${OPS_DIR}/${READABLE_SLUG}`;
const MUNGED_SLUG = SYNTH_PATH.replace(/^\//, "").replaceAll("/", "-");
const TASK_DATA_DIR = `${DATA_DIR}/${MUNGED_SLUG}`;
const WORK_DIR = `${OPS_DIR}/${READABLE_SLUG}/${SHORT_ID}/work`;

let originalVirtualContent: string | null = null;

beforeEach(() => {
	// These tests may run inside a real dev3 agent pane where DEV3_TASK_ID is set;
	// clear it so path-based detection is deterministic (the env fallback has its
	// own describe block that sets it explicitly).
	delete process.env.DEV3_TASK_ID;
	originalVirtualContent = existsSync(VIRTUAL_FILE) ? readFileSync(VIRTUAL_FILE, "utf-8") : null;

	mkdirSync(WORK_DIR, { recursive: true });
	mkdirSync(TASK_DATA_DIR, { recursive: true });
	writeFileSync(`${TASK_DATA_DIR}/tasks.json`, JSON.stringify([{ id: TASK_ID }]));

	const existing = originalVirtualContent ? JSON.parse(originalVirtualContent) : [];
	if (!existing.find((p: { id: string }) => p.id === PROJECT_ID)) {
		existing.push({ id: PROJECT_ID, name: "Test Ops", path: SYNTH_PATH, kind: "virtual" });
	}
	writeFileSync(VIRTUAL_FILE, JSON.stringify(existing));
});

afterEach(() => {
	const opsParent = `${OPS_DIR}/${READABLE_SLUG}`;
	if (existsSync(opsParent)) rmSync(opsParent, { recursive: true });
	if (existsSync(TASK_DATA_DIR)) rmSync(TASK_DATA_DIR, { recursive: true });
	if (originalVirtualContent !== null) writeFileSync(VIRTUAL_FILE, originalVirtualContent);
	else if (existsSync(VIRTUAL_FILE)) rmSync(VIRTUAL_FILE);
});

describe("detectContext — virtual (Operations) tasks", () => {
	it("resolves projectId + taskId from a virtual work dir", () => {
		const ctx = detectContext(WORK_DIR);
		expect(ctx).not.toBeNull();
		expect(ctx?.projectId).toBe(PROJECT_ID);
		expect(ctx?.taskId).toBe(TASK_ID);
		expect(ctx?.worktreePath).toBe(WORK_DIR);
	});

	it("resolves from a nested subdir of the work dir", () => {
		const ctx = detectContext(`${WORK_DIR}/src/components`);
		expect(ctx?.projectId).toBe(PROJECT_ID);
		expect(ctx?.taskId).toBe(TASK_ID);
	});

	it("returns null for an ops path that is not a /work dir", () => {
		const ctx = detectContext(`${OPS_DIR}/${READABLE_SLUG}/${SHORT_ID}/logs`);
		expect(ctx).toBeNull();
	});

	it("returns null when no virtual project matches the readable slug", () => {
		const ctx = detectContext(`${OPS_DIR}/no-such-board/${SHORT_ID}/work`);
		expect(ctx).toBeNull();
	});
});

describe("detectContext — DEV3_TASK_ID env fallback (fixed-folder ops / Quick shell)", () => {
	// Fixed-folder operations (user-picked opsWorkDir) and the Quick shell (runs in
	// $HOME) work OUTSIDE ~/.dev3.0/ops/, so path detection can't see them. The app
	// injects DEV3_TASK_ID into every task pane; the CLI must fall back to it, or
	// the agent status hooks silently no-op.
	afterEach(() => {
		delete process.env.DEV3_TASK_ID;
	});

	it("resolves projectId + taskId from DEV3_TASK_ID when cwd is outside the ops tree", () => {
		process.env.DEV3_TASK_ID = TASK_ID;
		const ctx = detectContext("/tmp/some-fixed-folder-outside-dev3");
		expect(ctx).not.toBeNull();
		expect(ctx?.projectId).toBe(PROJECT_ID);
		expect(ctx?.taskId).toBe(TASK_ID);
	});

	it("returns null for an unrelated cwd when DEV3_TASK_ID is unset", () => {
		delete process.env.DEV3_TASK_ID;
		expect(detectContext("/tmp/some-fixed-folder-outside-dev3")).toBeNull();
	});

	it("path-based detection wins over env (cwd inside the work dir)", () => {
		// Env points elsewhere; the real work-dir path must take precedence.
		process.env.DEV3_TASK_ID = "ffffffff-0000-0000-0000-000000000000";
		const ctx = detectContext(WORK_DIR);
		expect(ctx?.taskId).toBe(TASK_ID);
	});
});

describe("offline ID resolution — virtual (Operations) projects", () => {
	// These run without a socket and previously read only projects.json, going
	// blind to virtual boards (which live in virtual-projects.json).
	it("readProjectDirect resolves a virtual project by id", () => {
		const project = readProjectDirect(PROJECT_ID);
		expect(project?.id).toBe(PROJECT_ID);
		expect(project?.name).toBe("Test Ops");
		expect(project?.path).toBe(SYNTH_PATH);
	});

	it("readTaskDirect resolves a virtual project's task", () => {
		const task = readTaskDirect(PROJECT_ID, TASK_ID);
		expect(task?.id).toBe(TASK_ID);
	});

	it("expandShortId expands a short task id belonging to a virtual project", () => {
		expect(expandShortId(SHORT_ID, null)).toBe(TASK_ID);
	});

	it("expandShortProjectId expands a short virtual project id", () => {
		expect(expandShortProjectId("vproj-test", null)).toBe(PROJECT_ID);
	});
});
