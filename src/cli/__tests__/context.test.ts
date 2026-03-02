import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const HOME = process.env.HOME || "/tmp";
const WORKTREES_DIR = `${HOME}/.dev3.0/worktrees`;
const DATA_DIR = `${HOME}/.dev3.0/data`;
const PROJECTS_FILE = `${HOME}/.dev3.0/projects.json`;

// We need a unique slug to avoid interfering with real data
const TEST_SLUG = "test-cli-context-project";
const TEST_SHORT_ID = "aabbccdd";
const TEST_PROJECT_ID = "proj-test-123";
const TEST_TASK_ID = "aabbccdd-1111-2222-3333-444444444444";

const TEST_WORKTREE = `${WORKTREES_DIR}/${TEST_SLUG}/${TEST_SHORT_ID}/worktree`;
const TEST_TASK_DATA_DIR = `${DATA_DIR}/${TEST_SLUG}`;

let originalProjectsContent: string | null = null;

beforeEach(() => {
	// Save original projects.json if it exists
	if (existsSync(PROJECTS_FILE)) {
		const { readFileSync } = require("node:fs");
		originalProjectsContent = readFileSync(PROJECTS_FILE, "utf-8");
	}

	// Create test worktree directory
	mkdirSync(TEST_WORKTREE, { recursive: true });

	// Create test task data
	mkdirSync(TEST_TASK_DATA_DIR, { recursive: true });
	writeFileSync(
		`${TEST_TASK_DATA_DIR}/tasks.json`,
		JSON.stringify([{ id: TEST_TASK_ID }]),
	);

	// Write projects.json with our test project appended
	const existingProjects = originalProjectsContent ? JSON.parse(originalProjectsContent) : [];
	const testProject = {
		id: TEST_PROJECT_ID,
		name: "Test Project",
		path: `/${TEST_SLUG.replaceAll("-", "/")}`,
	};
	// Only add if not already present
	if (!existingProjects.find((p: { id: string }) => p.id === TEST_PROJECT_ID)) {
		existingProjects.push(testProject);
	}
	writeFileSync(PROJECTS_FILE, JSON.stringify(existingProjects));
});

afterEach(() => {
	// Clean up test worktree dir
	const testWorktreeParent = `${WORKTREES_DIR}/${TEST_SLUG}`;
	if (existsSync(testWorktreeParent)) {
		rmSync(testWorktreeParent, { recursive: true });
	}

	// Clean up test task data
	if (existsSync(TEST_TASK_DATA_DIR)) {
		rmSync(TEST_TASK_DATA_DIR, { recursive: true });
	}

	// Restore original projects.json
	if (originalProjectsContent !== null) {
		writeFileSync(PROJECTS_FILE, originalProjectsContent);
	} else if (existsSync(PROJECTS_FILE)) {
		rmSync(PROJECTS_FILE);
	}
});

describe("detectContext", () => {
	it("returns null when not in a worktree path", async () => {
		const { detectContext } = await import("../context");
		expect(detectContext("/tmp/random-dir")).toBeNull();
	});

	it("detects context from worktree path", async () => {
		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_WORKTREE);
		expect(ctx).not.toBeNull();
		expect(ctx!.projectId).toBe(TEST_PROJECT_ID);
		expect(ctx!.taskId).toBe(TEST_TASK_ID);
	});

	it("detects context from nested directory inside worktree", async () => {
		const { detectContext } = await import("../context");
		const nestedDir = `${TEST_WORKTREE}/src/components`;
		mkdirSync(nestedDir, { recursive: true });

		const ctx = detectContext(nestedDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.projectId).toBe(TEST_PROJECT_ID);
		expect(ctx!.taskId).toBe(TEST_TASK_ID);
	});
});
