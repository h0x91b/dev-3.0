import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

import { detectContext } from "../context";

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
