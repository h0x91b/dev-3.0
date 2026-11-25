import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projects = vi.hoisted(() => [] as Array<{ id: string; name: string; path: string }>);
vi.mock("../data", () => ({
	loadProjects: async () => projects,
	getProject: async (id: string) => {
		const project = projects.find((p) => p.id === id);
		if (!project) throw new Error("no project");
		return project;
	},
}));

import { absolutizeSenderPaths, withAbsolutePaths } from "../path-refs-agent";

let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-path-refs-agent-"));
	mkdirSync(join(root, "todo"));
	writeFileSync(join(root, "todo", "x.md"), "x\n");
	projects.push({ id: "a1c9fe4e-0000-4000-8000-000000000001", name: "Sender", path: root });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("absolutizeSenderPaths", () => {
	it("makes a sender's existing relative path absolute for the receiver", async () => {
		const out = await absolutizeSenderPaths("see todo/x.md:2 and todo/none.md", "a1c9fe4e-0000-4000-8000-000000000001", "other-project");
		expect(out).toBe(`see ${join(root, "todo", "x.md")}:2 and todo/none.md`);
	});

	it("keeps paths as written on the sender's own board", async () => {
		const id = "a1c9fe4e-0000-4000-8000-000000000001";
		expect(await absolutizeSenderPaths("see todo/x.md", id, id)).toBe("see todo/x.md");
	});
});

describe("withAbsolutePaths", () => {
	it("annotates a token with the host path it names", async () => {
		expect(await withAbsolutePaths("brief path:a1c9fe4e/todo/x.md")).toBe(`brief path:a1c9fe4e/todo/x.md (${join(root, "todo", "x.md")})`);
	});
});
