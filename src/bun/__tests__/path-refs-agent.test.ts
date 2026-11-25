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

import { absolutizeSenderPaths, qualifyWriterPaths, withAbsolutePaths, withoutAbsolutePaths } from "../path-refs-agent";

let root: string;
let readerRoot: string;
beforeAll(() => {
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
});

describe("absolutizeSenderPaths", () => {
	it("makes a sender's existing relative path absolute for the receiver", async () => {
		const out = await absolutizeSenderPaths("see todo/x.md:2 and todo/none.md", "a1c9fe4e-0000-4000-8000-000000000001", "other-project");
		expect(out).toBe(`see ${join(root, "todo", "x.md")}:2 and todo/none.md`);
	});

	it("gives the sender's absolute path even for a file both boards hold", async () => {
		const out = await absolutizeSenderPaths("I changed README.md", "a1c9fe4e-0000-4000-8000-000000000001", "b2d0aa11-0000-4000-8000-000000000002");
		expect(out).toBe(`I changed ${join(root, "README.md")}`);
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
