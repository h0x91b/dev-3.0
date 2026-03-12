import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("detectContext with sandbox HOME mismatch", () => {
	const REAL_HOME = process.env.HOME || "/tmp";
	const SANDBOX_HOME = "/tmp";

	afterEach(() => {
		// Restore real HOME
		process.env.HOME = REAL_HOME;
		vi.resetModules();
	});

	it("detects context when HOME=/tmp but cwd is under real user home", async () => {
		// Simulate Codex sandbox: HOME=/tmp, but cwd is the real worktree path
		process.env.HOME = SANDBOX_HOME;
		vi.resetModules();

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_WORKTREE);

		// Should still detect via the /.dev3.0/worktrees/ marker fallback
		expect(ctx).not.toBeNull();
		expect(ctx!.projectId).toBe(TEST_PROJECT_ID);
		expect(ctx!.taskId).toBe(TEST_TASK_ID);
	});

	it("diagnostics show realDev3Home when HOME differs from cwd", async () => {
		process.env.HOME = SANDBOX_HOME;
		vi.resetModules();

		const { detectContextDiagnostics } = await import("../context");
		const diag = detectContextDiagnostics(TEST_WORKTREE);

		expect(diag).toContain(`HOME: ${SANDBOX_HOME}`);
		expect(diag).toContain("realDev3Home=");
		expect(diag).toContain(`${REAL_HOME}/.dev3.0`);
	});
});

describe("detectFromWorktreePath — realDev3Home extraction", () => {
	// These tests verify pure path parsing logic — no filesystem access needed.
	// Each test simulates a different HOME + cwd combination.

	const REAL_HOME = process.env.HOME || "/tmp";

	afterEach(() => {
		process.env.HOME = REAL_HOME;
		vi.resetModules();
	});

	// ---- macOS standard ----

	it("macOS: HOME matches cwd — uses HOME-based path", async () => {
		process.env.HOME = "/Users/alice";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project/abcd1234/worktree");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("my-project");
		expect(result!.taskShortId).toBe("abcd1234");
		expect(result!.realDev3Home).toBe("/Users/alice/.dev3.0");
	});

	it("macOS: HOME=/tmp, cwd under /Users/alice — sandbox fallback", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project/abcd1234/worktree");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("my-project");
		expect(result!.taskShortId).toBe("abcd1234");
		expect(result!.realDev3Home).toBe("/Users/alice/.dev3.0");
	});

	it("macOS: nested cwd inside worktree — walks up to find marker", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project/abcd1234/worktree/src/lib/utils");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("my-project");
		expect(result!.taskShortId).toBe("abcd1234");
		expect(result!.realDev3Home).toBe("/Users/alice/.dev3.0");
	});

	// ---- Linux standard (/home/user) ----

	it("Linux: HOME=/home/dev, cwd matches — standard detection", async () => {
		process.env.HOME = "/home/dev";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/home/dev/.dev3.0/worktrees/Users-dev-projects-myapp/ff001122/worktree");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("Users-dev-projects-myapp");
		expect(result!.taskShortId).toBe("ff001122");
		expect(result!.realDev3Home).toBe("/home/dev/.dev3.0");
	});

	it("Linux: HOME=/tmp, cwd under /home/dev — sandbox fallback", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/home/dev/.dev3.0/worktrees/Users-dev-projects-myapp/ff001122/worktree");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("Users-dev-projects-myapp");
		expect(result!.taskShortId).toBe("ff001122");
		expect(result!.realDev3Home).toBe("/home/dev/.dev3.0");
	});

	// ---- NixOS / non-standard home ----

	it("NixOS: HOME=/home/nixuser/.local/share, cwd under that path", async () => {
		process.env.HOME = "/home/nixuser/.local/share";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/home/nixuser/.local/share/.dev3.0/worktrees/my-nix-proj/aabb0011/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/home/nixuser/.local/share/.dev3.0");
	});

	it("NixOS: HOME=/tmp, cwd under deep non-standard path — sandbox fallback", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/home/nixuser/.local/share/.dev3.0/worktrees/my-nix-proj/aabb0011/worktree");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("my-nix-proj");
		expect(result!.realDev3Home).toBe("/home/nixuser/.local/share/.dev3.0");
	});

	// ---- Root user ----

	it("root: HOME=/root — standard detection", async () => {
		process.env.HOME = "/root";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/root/.dev3.0/worktrees/some-project/deadbeef/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/root/.dev3.0");
	});

	it("root: HOME=/tmp sandbox, cwd under /root", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/root/.dev3.0/worktrees/some-project/deadbeef/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/root/.dev3.0");
	});

	// ---- Docker / custom home ----

	it("Docker: HOME=/app — custom container home", async () => {
		process.env.HOME = "/app";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/app/.dev3.0/worktrees/container-proj/11223344/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/app/.dev3.0");
	});

	it("Docker: HOME=/tmp sandbox, cwd under /app", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/app/.dev3.0/worktrees/container-proj/11223344/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/app/.dev3.0");
	});

	// ---- WSL ----

	it("WSL: HOME=/home/wsluser — standard Linux-style", async () => {
		process.env.HOME = "/home/wsluser";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/home/wsluser/.dev3.0/worktrees/win-proj-slug/cafe0000/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/home/wsluser/.dev3.0");
	});

	it("WSL: HOME mismatch — cwd under /mnt/c/Users path", async () => {
		process.env.HOME = "/home/wsluser";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		// User might store worktrees on the Windows drive
		const result = detectFromWorktreePath("/mnt/c/Users/WinUser/.dev3.0/worktrees/cross-os-proj/babe1234/worktree");
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("cross-os-proj");
		expect(result!.realDev3Home).toBe("/mnt/c/Users/WinUser/.dev3.0");
	});

	// ---- Sandbox with different non-/tmp HOMEs ----

	it("sandbox HOME=/var/sandbox, cwd under /Users/bob", async () => {
		process.env.HOME = "/var/sandbox";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/Users/bob/.dev3.0/worktrees/bob-project/12345678/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/Users/bob/.dev3.0");
	});

	it("sandbox HOME=/run/user/1000, cwd under /home/carol", async () => {
		process.env.HOME = "/run/user/1000";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath("/home/carol/.dev3.0/worktrees/carol-proj/abcdef01/worktree");
		expect(result).not.toBeNull();
		expect(result!.realDev3Home).toBe("/home/carol/.dev3.0");
	});

	// ---- Negative cases ----

	it("returns null for paths without /.dev3.0/worktrees/ marker", async () => {
		process.env.HOME = "/Users/alice";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		expect(detectFromWorktreePath("/Users/alice/projects/myapp")).toBeNull();
		expect(detectFromWorktreePath("/tmp/random")).toBeNull();
		expect(detectFromWorktreePath("/")).toBeNull();
	});

	it("returns null when path has marker but wrong structure (no worktree dir)", async () => {
		process.env.HOME = "/Users/alice";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		// Only slug, no taskId/worktree
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project")).toBeNull();
		// slug + taskId but no /worktree
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project/abcd1234")).toBeNull();
	});

	it("returns null for /.dev3.0/ without /worktrees/", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		expect(detectFromWorktreePath("/Users/alice/.dev3.0/sockets/1234.sock")).toBeNull();
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/data/my-project/tasks.json")).toBeNull();
	});

	// ---- Slugs with complex characters ----

	it("handles slugs with many dashes (typical path-derived slugs)", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath(
			"/Users/arsenyp/.dev3.0/worktrees/Users-arsenyp-Desktop-src-shared-dev-3.0/1c173543/worktree",
		);
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("Users-arsenyp-Desktop-src-shared-dev-3.0");
		expect(result!.taskShortId).toBe("1c173543");
		expect(result!.realDev3Home).toBe("/Users/arsenyp/.dev3.0");
	});

	it("handles slug with dots and numbers", async () => {
		process.env.HOME = "/tmp";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		const result = detectFromWorktreePath(
			"/home/user/.dev3.0/worktrees/home-user-my.project.v2/a1b2c3d4/worktree",
		);
		expect(result).not.toBeNull();
		expect(result!.projectSlug).toBe("home-user-my.project.v2");
		expect(result!.taskShortId).toBe("a1b2c3d4");
		expect(result!.realDev3Home).toBe("/home/user/.dev3.0");
	});
});
