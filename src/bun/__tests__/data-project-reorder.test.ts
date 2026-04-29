import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Project } from "../../shared/types";

const tempHome = mkdtempSync(join(tmpdir(), "dev3-project-reorder-"));
const dev3Home = join(tempHome, ".dev3.0");
const originalHome = process.env.HOME;

function makeProject(id: string, overrides?: Partial<Project>): Project {
	return {
		id,
		name: id,
		path: `/tmp/${id}`,
		setupScript: "",
		setupScriptLaunchMode: "parallel",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-04-29T00:00:00.000Z",
		labels: [],
		customColumns: [],
		...overrides,
	};
}

describe("project reordering", () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.HOME = tempHome;
		rmSync(tempHome, { recursive: true, force: true });
		mkdirSync(dev3Home, { recursive: true });
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("persists active projects in the requested order", async () => {
		const projectsFile = join(dev3Home, "projects.json");
		writeFileSync(projectsFile, JSON.stringify([
			makeProject("p1"),
			makeProject("p2"),
			makeProject("p3"),
		], null, 2));

		const data = await import("../data");
		const reordered = await data.reorderProjects(["p3", "p1", "p2"]);

		expect(reordered.map((project) => project.id)).toEqual(["p3", "p1", "p2"]);
		expect((await data.loadProjects()).map((project) => project.id)).toEqual(["p3", "p1", "p2"]);
		expect(JSON.parse(readFileSync(projectsFile, "utf8")).map((project: Project) => project.id)).toEqual(["p3", "p1", "p2"]);
	});

	it("ignores unknown and duplicate ids while appending omitted active projects", async () => {
		writeFileSync(join(dev3Home, "projects.json"), JSON.stringify([
			makeProject("p1"),
			makeProject("p2"),
			makeProject("p3"),
			makeProject("deleted", { deleted: true }),
		], null, 2));

		const data = await import("../data");
		const reordered = await data.reorderProjects(["missing", "p2", "p2"]);

		expect(reordered.map((project) => project.id)).toEqual(["p2", "p1", "p3"]);
		const saved = JSON.parse(readFileSync(join(dev3Home, "projects.json"), "utf8")) as Project[];
		expect(saved.map((project) => project.id)).toEqual(["p2", "p1", "p3", "deleted"]);
	});
});
