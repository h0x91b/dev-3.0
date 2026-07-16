import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Project } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-projects`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { addProject, loadProjects, updateProject } from "../data";

const PROJECTS_FILE = `${TEST_HOME}/projects.json`;

describe("addProject — duplicate prevention", () => {
	it("returns existing project when adding same path twice", async () => {
		const first = await addProject("/tmp/my-repo", "My Repo");
		const second = await addProject("/tmp/my-repo", "My Repo Again");

		expect(second.id).toBe(first.id);

		const all = await loadProjects();
		expect(all).toHaveLength(1);
	});

	it("normalizes trailing slashes when checking for duplicates", async () => {
		const first = await addProject("/tmp/my-repo", "Repo");
		const second = await addProject("/tmp/my-repo/", "Repo Slash");

		expect(second.id).toBe(first.id);

		const all = await loadProjects();
		expect(all).toHaveLength(1);
	});

	it("reactivates a soft-deleted project with the same path", async () => {
		const existing: Project[] = [
			{
				id: "deleted-proj",
				name: "Old Name",
				path: "/tmp/deleted-repo",
				setupScript: "",
				devScript: "",
				cleanupScript: "",
				defaultBaseBranch: "main",
				createdAt: "2025-01-01T00:00:00Z",
				labels: [],
				deleted: true,
			},
		];
		writeFileSync(PROJECTS_FILE, JSON.stringify(existing));

		const result = await addProject("/tmp/deleted-repo", "New Name");

		expect(result.id).toBe("deleted-proj");
		expect(result.name).toBe("New Name");
		expect(result.deleted).toBeUndefined();

		const all = await loadProjects();
		expect(all).toHaveLength(1);
		expect(all[0].deleted).toBeUndefined();
	});

	it("creates distinct projects for different paths", async () => {
		const first = await addProject("/tmp/repo-a", "Repo A");
		const second = await addProject("/tmp/repo-b", "Repo B");

		expect(first.id).not.toBe(second.id);

		const all = await loadProjects();
		expect(all).toHaveLength(2);
	});
});

describe("updateProject", () => {
	it("persists autoReviewEnabled updates", async () => {
		const project = await addProject("/tmp/review-repo", "Review Repo");

		const updated = await updateProject(project.id, { autoReviewEnabled: true });

		expect(updated.autoReviewEnabled).toBe(true);

		const all = await loadProjects();
		expect(all[0].autoReviewEnabled).toBe(true);
	});
});

describe("loadProjects migration reads", () => {
	it("normalizes legacy cleanupScript in memory without writing during read", async () => {
		writeFileSync(PROJECTS_FILE, JSON.stringify([
			{
				id: "legacy-proj",
				name: "Legacy",
				path: "/tmp/legacy",
				setupScript: "",
				devScript: "",
				cleanupScript: "say old-default",
				defaultBaseBranch: "main",
				createdAt: "2025-01-01T00:00:00Z",
				labels: [],
			},
		]));

		const loaded = await loadProjects();

		expect(loaded[0].cleanupScript).toBe("");
		const saved = JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
		expect(saved[0].cleanupScript).toBe("say old-default");
	});
});
