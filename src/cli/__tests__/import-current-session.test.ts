/**
 * `dev3 import` resolves its project from the working directory, so the
 * boundary rule is the whole safety story: a conversation belongs to the project
 * that owns the directory it ran in, and to no other.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolveDev3Home } from "../../shared/dev3-home";
import { projectOwningCwd } from "../context";

const PROJECTS_FILE = `${resolveDev3Home()}/projects.json`;

function seedProjects(projects: Array<Record<string, unknown>>): void {
	mkdirSync(resolveDev3Home(), { recursive: true });
	writeFileSync(PROJECTS_FILE, JSON.stringify(projects));
}

beforeEach(() => {
	rmSync(PROJECTS_FILE, { force: true });
});

afterEach(() => {
	rmSync(PROJECTS_FILE, { force: true });
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

	it("ignores virtual projects, which have no repository to import into", () => {
		seedProjects([{ id: "ops", name: "Operations", path: "/code/app", kind: "virtual" }]);
		expect(projectOwningCwd("/code/app")).toBeNull();
	});

	it("tolerates a trailing slash on either side", () => {
		seedProjects([{ id: "p1", name: "App", path: "/code/app/" }]);
		expect(projectOwningCwd("/code/app/")?.id).toBe("p1");
	});

	it("returns null when no project is registered", () => {
		seedProjects([]);
		expect(projectOwningCwd("/code/app")).toBeNull();
	});
});
