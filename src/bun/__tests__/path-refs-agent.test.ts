import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projects = vi.hoisted(() => [] as Array<{ id: string; name: string; path: string }>);
const tasks = vi.hoisted(() => new Map<string, { id: string; worktreePath: string | null }>());
vi.mock("../data", () => ({
	loadProjects: async () => projects,
	getTask: async (_project: unknown, id: string) => {
		const task = tasks.get(id);
		if (!task) throw new Error("no task");
		return task;
	},
	getProject: async (id: string) => {
		const project = projects.find((p) => p.id === id);
		if (!project) throw new Error("no project");
		return project;
	},
}));

import { absolutizeSenderPaths, qualifyWriterPaths, withAbsolutePaths, withoutAbsolutePaths } from "../path-refs-agent";

let root: string;
let readerRoot: string;
let worktree: string;
beforeAll(() => {
	worktree = mkdtempSync(join(tmpdir(), "dev3-path-refs-worktree-"));
	writeFileSync(join(worktree, "README.md"), "worktree\n");
	tasks.set("sender-task", { id: "sender-task", worktreePath: worktree });
	root = mkdtempSync(join(tmpdir(), "dev3-path-refs-agent-"));
	mkdirSync(join(root, "todo"));
	writeFileSync(join(root, "todo", "x.md"), "x\n");
	writeFileSync(join(root, "README.md"), "writer\n");
	readerRoot = mkdtempSync(join(tmpdir(), "dev3-path-refs-reader-"));
	writeFileSync(join(readerRoot, "README.md"), "reader\n");
	projects.push({ id: "a1c9fe4e-0000-4000-8000-000000000001", name: "Sender", path: root });
	projects.push({ id: "b2d0aa11-0000-4000-8000-000000000002", name: "Reader", path: readerRoot });
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(readerRoot, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

describe("absolutizeSenderPaths", () => {
	it("makes a sender's existing relative path absolute for the receiver", async () => {
		const out = await absolutizeSenderPaths("see todo/x.md:2, todo/x.md:3:7 and todo/none.md", { projectId: "a1c9fe4e-0000-4000-8000-000000000001" }, "other-project");
		expect(out).toBe(`see ${join(root, "todo", "x.md")}:2, ${join(root, "todo", "x.md")}:3:7 and todo/none.md`);
	});

	it("gives the sender's absolute path even for a file both boards hold", async () => {
		const out = await absolutizeSenderPaths("I changed README.md", { projectId: "a1c9fe4e-0000-4000-8000-000000000001" }, "b2d0aa11-0000-4000-8000-000000000002");
		expect(out).toBe(`I changed ${join(root, "README.md")}`);
	});

	it("keeps paths as written on the sender's own board", async () => {
		const id = "a1c9fe4e-0000-4000-8000-000000000001";
		expect(await absolutizeSenderPaths("see todo/x.md", { projectId: id }, id)).toBe("see todo/x.md");
	});

	it("prefers the sender task's worktree copy, and falls back to the project for a file only it holds", async () => {
		const sender = { projectId: "a1c9fe4e-0000-4000-8000-000000000001", taskId: "sender-task" };
		const out = await absolutizeSenderPaths("I changed README.md, see todo/x.md", sender, "other-project");
		expect(out).toBe(`I changed ${join(worktree, "README.md")}, see ${join(root, "todo", "x.md")}`);
	});
});

describe("withAbsolutePaths", () => {
	it("annotates a token with the host path it names", async () => {
		expect(await withAbsolutePaths("brief path:a1c9fe4e/todo/x.md")).toBe(`brief path:a1c9fe4e/todo/x.md (${join(root, "todo", "x.md")})`);
	});
});

describe("qualifyWriterPaths", () => {
	const writer = "a1c9fe4e-0000-4000-8000-000000000001";
	const reader = "b2d0aa11-0000-4000-8000-000000000002";

	it("leaves a path both boards hold as written, and converts one only the writer holds", async () => {
		expect(await qualifyWriterPaths("see README.md and todo/x.md", writer, reader)).toBe("see README.md and path:a1c9fe4e/todo/x.md");
	});

	it("round-trips: what dev3 prints for an agent is stored back as the bare token", async () => {
		const printed = await withAbsolutePaths("note: path:a1c9fe4e/todo/x.md (keep this)");
		expect(printed).not.toBe("note: path:a1c9fe4e/todo/x.md (keep this)");
		expect(await withoutAbsolutePaths(printed)).toBe("note: path:a1c9fe4e/todo/x.md (keep this)");
	});

	it("drops the absolute path an agent copied back from dev3's output", async () => {
		const copied = `brief path:a1c9fe4e/todo/x.md (${join(root, "todo", "x.md")})`;
		expect(await qualifyWriterPaths(copied, reader, reader)).toBe("brief path:a1c9fe4e/todo/x.md");
	});
});
