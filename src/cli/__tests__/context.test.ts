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
	// These tests may run inside a real dev3 agent pane where DEV3_TASK_ID is set;
	// clear it so detectContext's env fallback doesn't resolve the real task when a
	// test passes a non-worktree path expecting null.
	delete process.env.DEV3_TASK_ID;
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
	it("detects context from a worktree path or a nested dir, and null outside a worktree", async () => {
		const { detectContext } = await import("../context");
		expect(detectContext("/tmp/random-dir")).toBeNull();
		expect(detectContext(TEST_WORKTREE)).toMatchObject({ projectId: TEST_PROJECT_ID, taskId: TEST_TASK_ID });
		const nestedDir = `${TEST_WORKTREE}/src/components`;
		mkdirSync(nestedDir, { recursive: true });

		const ctx = detectContext(nestedDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.projectId).toBe(TEST_PROJECT_ID);
		expect(ctx!.taskId).toBe(TEST_TASK_ID);
	});
});

describe("in-project storage root", () => {
	const REPO = `${HOME}/.dev3.0/cli-context-inproject-repo`;
	const SHORT = "ccddeeff";
	const TASK_ID = `${SHORT}-1111-2222-3333-444444444444`;
	const TASK_DIR = `${REPO}/.dev3/worktrees/${SHORT}`;
	const IN_PROJECT_ID = "proj-inproject-1";

	beforeEach(() => {
		mkdirSync(`${TASK_DIR}/worktree`, { recursive: true });
		mkdirSync(`${REPO}/.dev3/data`, { recursive: true });
		writeFileSync(`${REPO}/.dev3/data/tasks.json`, JSON.stringify([{ id: TASK_ID, taskDirLocation: "project" }]));
		const { readFileSync } = require("node:fs");
		const projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
		projects.push({ id: IN_PROJECT_ID, name: "In Project", path: REPO, storageRoot: "project" });
		writeFileSync(PROJECTS_FILE, JSON.stringify(projects));
	});

	afterEach(() => {
		rmSync(REPO, { recursive: true, force: true });
	});

	it("detects the task from an in-project worktree path and reads the project's tasks.json", async () => {
		const { detectContext } = await import("../context");
		const nested = `${TASK_DIR}/worktree/src`;
		mkdirSync(nested, { recursive: true });
		const ctx = detectContext(nested);
		expect(ctx).toMatchObject({ projectId: IN_PROJECT_ID, taskId: TASK_ID, worktreePath: `${TASK_DIR}/worktree` });
	});

	it("does not treat a task logs dir as a worktree", async () => {
		const { detectFromWorktreePath } = await import("../context");
		expect(detectFromWorktreePath(`${TASK_DIR}/logs`)).toBeNull();
		expect(detectFromWorktreePath(`${TASK_DIR}/worktree`)).toMatchObject({ inProjectTaskDir: TASK_DIR, taskShortId: SHORT });
	});

	it("matches a project registered through a symlinked folder", async () => {
		const { readFileSync, symlinkSync, unlinkSync } = require("node:fs");
		const link = `${HOME}/.dev3.0/cli-context-inproject-link`;
		// Bun's rmSync refuses a symlink to a directory on macOS; unlink removes only the link.
		const removeLink = () => { try { unlinkSync(link); } catch {} };
		removeLink();
		symlinkSync(REPO, link);
		try {
			const projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8"));
			for (const p of projects) if (p.id === IN_PROJECT_ID) p.path = link;
			writeFileSync(PROJECTS_FILE, JSON.stringify(projects));
			const { detectContext } = await import("../context");
			expect(detectContext(`${TASK_DIR}/worktree`)).toMatchObject({ projectId: IN_PROJECT_ID, taskId: TASK_ID });
		} finally {
			removeLink();
		}
	});

	it("finds projects.json through the account home when a sandbox rewrote HOME", async () => {
		const { inProjectDev3Home } = await import("../context");
		const realHome = `${HOME}/.dev3.0/..`;
		expect(inProjectDev3Home("/nonexistent-sandbox/.dev3.0", () => realHome)).toBe(`${realHome}/.dev3.0`);
		expect(inProjectDev3Home("/nonexistent-sandbox/.dev3.0", () => "/nonexistent-account")).toBe("/nonexistent-sandbox/.dev3.0");
	});

	it("diagnostics name both tasks.json roots", async () => {
		const { detectContextDiagnostics } = await import("../context");
		const diag = detectContextDiagnostics(`${TASK_DIR}/worktree`);
		expect(diag).toContain("tasks.json (home,");
		expect(diag).toContain(`tasks.json (in-project, ${REPO}/.dev3/data/tasks.json): exists`);
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

	const positives: Array<[label: string, home: string, cwd: string, slug: string, short: string, dev3Home: string]> = [
		["macOS: HOME matches cwd", "/Users/alice", "/Users/alice/.dev3.0/worktrees/my-project/abcd1234/worktree", "my-project", "abcd1234", "/Users/alice/.dev3.0"],
		["macOS: nested cwd, HOME=/tmp sandbox", "/tmp", "/Users/alice/.dev3.0/worktrees/my-project/abcd1234/worktree/src/lib/utils", "my-project", "abcd1234", "/Users/alice/.dev3.0"],
		["Linux: HOME=/tmp, cwd under /home/dev", "/tmp", "/home/dev/.dev3.0/worktrees/Users-dev-projects-myapp/ff001122/worktree", "Users-dev-projects-myapp", "ff001122", "/home/dev/.dev3.0"],
		["NixOS: deep non-standard home", "/home/nixuser/.local/share", "/home/nixuser/.local/share/.dev3.0/worktrees/my-nix-proj/aabb0011/worktree", "my-nix-proj", "aabb0011", "/home/nixuser/.local/share/.dev3.0"],
		["WSL: worktrees on /mnt/c", "/home/wsluser", "/mnt/c/Users/WinUser/.dev3.0/worktrees/cross-os-proj/babe1234/worktree", "cross-os-proj", "babe1234", "/mnt/c/Users/WinUser/.dev3.0"],
		["sandbox HOME=/run/user/1000", "/run/user/1000", "/home/carol/.dev3.0/worktrees/carol-proj/abcdef01/worktree", "carol-proj", "abcdef01", "/home/carol/.dev3.0"],
		["slug with many dashes", "/tmp", "/Users/arsenyp/.dev3.0/worktrees/Users-arsenyp-Desktop-src-shared-dev-3.0/1c173543/worktree", "Users-arsenyp-Desktop-src-shared-dev-3.0", "1c173543", "/Users/arsenyp/.dev3.0"],
		["slug with dots and numbers", "/tmp", "/home/user/.dev3.0/worktrees/home-user-my.project.v2/a1b2c3d4/worktree", "home-user-my.project.v2", "a1b2c3d4", "/home/user/.dev3.0"],
	];

	it("extracts slug, short id and the real dev3 home whether or not HOME matches the cwd", async () => {
		for (const [label, home, cwd, slug, short, dev3Home] of positives) {
			process.env.HOME = home;
			vi.resetModules();
			const { detectFromWorktreePath } = await import("../context");
			expect(detectFromWorktreePath(cwd), label).toMatchObject({ projectSlug: slug, taskShortId: short, realDev3Home: dev3Home });
		}
	});

	it("returns null without the marker, with a truncated structure, or for other .dev3.0 dirs", async () => {
		process.env.HOME = "/Users/alice";
		vi.resetModules();
		const { detectFromWorktreePath } = await import("../context");

		expect(detectFromWorktreePath("/Users/alice/projects/myapp")).toBeNull();
		expect(detectFromWorktreePath("/tmp/random")).toBeNull();
		expect(detectFromWorktreePath("/")).toBeNull();
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project")).toBeNull();
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/worktrees/my-project/abcd1234")).toBeNull();
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/sockets/1234.sock")).toBeNull();
		expect(detectFromWorktreePath("/Users/alice/.dev3.0/data/my-project/tasks.json")).toBeNull();
	});
});

describe("expandShortProjectId", () => {
	it("expands a short project ID prefix to the full project ID", async () => {
		const { expandShortProjectId } = await import("../context");
		// TEST_PROJECT_ID is "proj-test-123" — a short prefix must resolve to it.
		expect(expandShortProjectId("proj-tes", null)).toBe(TEST_PROJECT_ID);
	});

	it("returns a full-length ID, an unmatched one, or a too-short prefix unchanged", async () => {
		const { expandShortProjectId } = await import("../context");
		expect(expandShortProjectId("zzzzzzzz", null)).toBe("zzzzzzzz");
		expect(expandShortProjectId("pro", null)).toBe("pro");
		const fullId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		expect(expandShortProjectId(fullId, null)).toBe(fullId);
	});

	it("prefers the context project when its ID matches the prefix", async () => {
		const { expandShortProjectId } = await import("../context");
		const ctx = { projectId: "ctx-proj-999", taskId: TEST_TASK_ID, socketPath: "" };
		expect(expandShortProjectId("ctx-pro", ctx)).toBe("ctx-proj-999");
	});
});

describe("expandShortId — prefix guards", () => {
	it("resolves an unambiguous >=8-char task prefix to its full id", async () => {
		const { expandShortId } = await import("../context");
		expect(expandShortId(TEST_SHORT_ID, null)).toBe(TEST_TASK_ID);
	});

	it("leaves a too-short prefix unchanged (below the min length, server rejects it)", async () => {
		const { expandShortId } = await import("../context");
		// A 3-char prefix must NOT be resolved to whatever task happens to match
		// first — that is exactly the silent-misresolution bug this guard closes.
		expect(expandShortId("aab", null)).toBe("aab");
		// Context is authoritative — an in-worktree short prefix means "this task".
		const ctx = { projectId: TEST_PROJECT_ID, taskId: TEST_TASK_ID, socketPath: "" };
		expect(expandShortId("aab", ctx)).toBe(TEST_TASK_ID);
	});

	it("throws on an ambiguous prefix matching more than one task", async () => {
		// Two tasks in the test project share the same 8-char prefix.
		writeFileSync(
			`${TEST_TASK_DATA_DIR}/tasks.json`,
			JSON.stringify([
				{ id: "dupe1234-1111-2222-3333-444444444444" },
				{ id: "dupe1234-5555-6666-7777-888888888888" },
			]),
		);
		const { expandShortId } = await import("../context");
		expect(() => expandShortId("dupe1234", null)).toThrow(/Ambiguous task prefix/);
	});

	it("passes a stable seq:<N> reference through verbatim (resolved server-side)", async () => {
		const { expandShortId } = await import("../context");
		expect(expandShortId("seq:1066", null)).toBe("seq:1066");
		// Even with a context task set, a seq ref is never rewritten.
		const ctx = { projectId: TEST_PROJECT_ID, taskId: TEST_TASK_ID, socketPath: "" };
		expect(expandShortId("seq:5", ctx)).toBe("seq:5");
		expect(expandShortId("seq:a1c9fe4e/5", ctx)).toBe("seq:a1c9fe4e/5");
		expect(expandShortId("<seq:a1c9fe4e/5>", ctx)).toBe("seq:a1c9fe4e/5");
	});
});

describe("resolveProjectId", () => {
	it("expands a short --project flag value", async () => {
		const { resolveProjectId } = await import("../context");
		expect(resolveProjectId("proj-tes", null)).toBe(TEST_PROJECT_ID);
		const ctx = { projectId: TEST_PROJECT_ID, taskId: TEST_TASK_ID, socketPath: "" };
		expect(resolveProjectId(undefined, ctx), "context fallback").toBe(TEST_PROJECT_ID);
		expect(resolveProjectId(undefined, null, `${HOME}/nowhere-near-a-project`)).toBeUndefined();
	});

	it("falls back to the project whose checkout contains the cwd, with no task context at all", async () => {
		// A plain `git clone` is a legitimate place to run a project-scoped command
		// from; before this, every one of them answered "could not detect project".
		const { resolveProjectId } = await import("../context");
		const checkout = `${HOME}/checkouts/scoped-project`;
		mkdirSync(`${checkout}/src/deep`, { recursive: true });
		writeFileSync(PROJECTS_FILE, JSON.stringify([{ id: "proj-checkout-1", name: "Checkout", path: checkout }]));

		expect(resolveProjectId(undefined, null, checkout)).toBe("proj-checkout-1");
		expect(resolveProjectId(undefined, null, `${checkout}/src/deep`)).toBe("proj-checkout-1");
		// A sibling directory that merely shares the prefix is NOT that project.
		expect(resolveProjectId(undefined, null, `${checkout}-scratch`)).toBeUndefined();
	});

	it("keeps an explicit --project ahead of the checkout the cwd belongs to", async () => {
		const { resolveProjectId } = await import("../context");
		const checkout = `${HOME}/checkouts/scoped-project`;
		mkdirSync(checkout, { recursive: true });
		writeFileSync(PROJECTS_FILE, JSON.stringify([
			{ id: "proj-checkout-1", name: "Checkout", path: checkout },
			{ id: "proj-elsewhere-2", name: "Elsewhere", path: `${HOME}/checkouts/other` },
		]));

		expect(resolveProjectId("proj-elsewhere-2", null, checkout)).toBe("proj-elsewhere-2");
	});
});
