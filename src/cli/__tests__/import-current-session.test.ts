/**
 * `dev3 import` resolves its project from the working directory, so the
 * boundary rule is the whole safety story: a conversation belongs to the project
 * that owns the directory it ran in, and to no other.
 *
 * Two properties are as load-bearing as the boundary itself and are asserted
 * here rather than assumed. The comparison happens on a NORMALISED path, because
 * `process.cwd()` is physical while a stored project path need not be; and the
 * record still comes back with its path UNTOUCHED, because that exact string is
 * what names the project's data directory on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDev3Home } from "../../shared/dev3-home";
import { projectSlug } from "../../shared/conversation-search-core";
import { projectPathCandidates } from "../../bun/conversation-import";
import { projectOwningCwd } from "../context";
import { resolveImportTarget } from "../commands/conversations";

const PROJECTS_FILE = `${resolveDev3Home()}/projects.json`;
const VIRTUAL_PROJECTS_FILE = `${resolveDev3Home()}/virtual-projects.json`;

function seedProjects(projects: Array<Record<string, unknown>>): void {
	mkdirSync(resolveDev3Home(), { recursive: true });
	writeFileSync(PROJECTS_FILE, JSON.stringify(projects));
}

/** Virtual boards live in their OWN file — seeding them anywhere else tests nothing. */
function seedVirtualProjects(projects: Array<Record<string, unknown>>): void {
	mkdirSync(resolveDev3Home(), { recursive: true });
	writeFileSync(VIRTUAL_PROJECTS_FILE, JSON.stringify(projects));
}

beforeEach(() => {
	rmSync(PROJECTS_FILE, { force: true });
	rmSync(VIRTUAL_PROJECTS_FILE, { force: true });
});

afterEach(() => {
	rmSync(PROJECTS_FILE, { force: true });
	rmSync(VIRTUAL_PROJECTS_FILE, { force: true });
});

describe("projectOwningCwd", () => {
	it("matches the project directory itself", () => {
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		expect(projectOwningCwd("/code/app")?.id).toBe("p1");
	});

	it("matches a subdirectory the agent was started from", () => {
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		expect(projectOwningCwd("/code/app/packages/api")?.id).toBe("p1");
	});

	it("refuses a sibling that merely shares a name prefix", () => {
		// The real near-miss: `…/app` must not claim `…/app-scratch`.
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		expect(projectOwningCwd("/code/app-scratch")).toBeNull();
	});

	it("refuses the parent of the project", () => {
		// Measured on a real board: the project is `…/playground/dev-3.0` while
		// conversations ran in `…/playground`. Those belong to no project.
		seedProjects([{ id: "p1", name: "App", path: "/code/playground/dev-3.0" }]);
		expect(projectOwningCwd("/code/playground")).toBeNull();
	});

	it("prefers the deepest project when two nest", () => {
		seedProjects([
			{ id: "outer", name: "Outer", path: "/code" },
			{ id: "inner", name: "Inner", path: "/code/app" },
		]);
		expect(projectOwningCwd("/code/app/src")?.id).toBe("inner");
	});

	it("still prefers the deepest project when the shallower one is reached by a long symlink", () => {
		// Depth has to compare like with like. Comparing the RESOLVED length of the
		// candidate against the STORED length of the incumbent lets a shallow
		// project whose stored path happens to be long swallow a deeper one.
		const root = mkdtempSync(join(tmpdir(), "d3-depth-"));
		const real = join(root, "real");
		const link = join(root, `l${"o".repeat(80)}ng-link`);
		mkdirSync(join(real, "app", "src"), { recursive: true });
		symlinkSync(real, link);
		try {
			seedProjects([
				{ id: "outer", name: "Outer", path: link },
				{ id: "inner", name: "Inner", path: join(real, "app") },
			]);
			expect(projectOwningCwd(join(real, "app", "src"))?.id).toBe("inner");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores virtual projects, which have no repository to import into", () => {
		seedVirtualProjects([{ id: "ops", name: "Operations", path: "/code/app", kind: "virtual" }]);
		expect(projectOwningCwd("/code/app")).toBeNull();
	});

	it("matches through a trailing slash without rewriting the stored path", () => {
		// The match is the easy half. The path that comes back is what names the
		// project's data directory, so tidying it would send every caller looking
		// for `data/code-app/` when the board wrote `data/code-app-/`.
		seedProjects([{ id: "p1", name: "App", path: "/code/app/" }]);
		const project = projectOwningCwd("/code/app/src");
		expect(project?.id).toBe("p1");
		expect(project?.path).toBe("/code/app/");
		expect(projectSlug(project!.path)).toBe(projectSlug("/code/app/"));
	});

	it("matches when the working directory is reached through a symlink", () => {
		// `process.cwd()` reports the physical path while the picker stored the
		// link, so without resolving both sides a symlinked checkout owns nothing.
		const root = mkdtempSync(join(tmpdir(), "d3-owns-"));
		const real = join(root, "real-repo");
		const link = join(root, "linked-repo");
		mkdirSync(join(real, "src"), { recursive: true });
		symlinkSync(real, link);
		try {
			seedProjects([{ id: "p1", name: "App", path: link }]);
			expect(projectOwningCwd(join(real, "src"))?.id).toBe("p1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when no project is registered", () => {
		seedProjects([]);
		expect(projectOwningCwd("/code/app")).toBeNull();
	});
});

describe("projectPathCandidates", () => {
	it("drops a trailing slash, which the encoder would turn into a trailing dash", () => {
		expect(projectPathCandidates("/code/app/").map((c) => c.path)).toEqual(["/code/app"]);
	});

	it("offers the physical path alongside the stored one for a symlinked checkout", () => {
		const root = mkdtempSync(join(tmpdir(), "d3-cmp-"));
		const real = join(root, "real-repo");
		const link = join(root, "linked-repo");
		mkdirSync(real, { recursive: true });
		symlinkSync(real, link);
		try {
			const paths = projectPathCandidates(link).map((c) => c.path);
			const realCandidates = projectPathCandidates(real);
			const physicalReal = realCandidates[realCandidates.length - 1].path;
			expect(paths[0]).toBe(link);
			expect(paths).toContain(physicalReal);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("offers exactly one spelling for a path that is not on this machine", () => {
		expect(projectPathCandidates("/code/app")).toEqual([{ path: "/code/app", encoded: "-code-app" }]);
	});
});

describe("resolveImportTarget", () => {
	let stderr = "";
	const previousSessionId = process.env.CLAUDE_CODE_SESSION_ID;

	beforeEach(() => {
		stderr = "";
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr += String(chunk);
			return true;
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`EXIT_${code ?? 0}`);
		}) as never);
		process.env.CLAUDE_CODE_SESSION_ID = "session-1";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
		else process.env.CLAUDE_CODE_SESSION_ID = previousSessionId;
	});

	it("answers with the session id and the owning project", () => {
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		const target = resolveImportTarget("/code/app/src");
		expect(target.sessionId).toBe("session-1");
		expect(target.project.id).toBe("p1");
	});

	it("refuses when there is no Claude Code session around it", () => {
		delete process.env.CLAUDE_CODE_SESSION_ID;
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		expect(() => resolveImportTarget("/code/app")).toThrow("EXIT_1");
		expect(stderr).toContain("CLAUDE_CODE_SESSION_ID");
	});

	it("exits 20 naming the directory when no project owns it", () => {
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		expect(() => resolveImportTarget("/somewhere/else")).toThrow("EXIT_20");
		expect(stderr).toContain("/somewhere/else");
		expect(stderr).toContain("Add project");
	});

	it("tells a dev3 worktree that its conversation is already the task", () => {
		// "Add this repository to dev3" is wrong advice in the one directory an
		// agent is most likely to be standing in.
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		const worktree = `${resolveDev3Home()}/worktrees/code-app/abcd1234/worktree`;
		expect(() => resolveImportTarget(worktree)).toThrow("EXIT_20");
		expect(stderr).toContain("already the task");
		expect(stderr).not.toContain("Add project");
	});

	it("tells a virtual board that it has no repository to import into", () => {
		seedProjects([{ id: "p1", name: "App", path: "/code/app" }]);
		expect(() => resolveImportTarget(`${resolveDev3Home()}/ops/notes/abcd1234`)).toThrow("EXIT_20");
		expect(stderr).toContain("no repository");
		expect(stderr).not.toContain("Add project");
	});
});
