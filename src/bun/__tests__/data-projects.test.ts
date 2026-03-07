import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test",
}));

vi.mock("../cow-clone", () => ({
	detectClonePaths: vi.fn(() => Promise.resolve([])),
}));

let mockFileStore: Record<string, string> = {};

beforeEach(() => {
	mockFileStore = {};
	(globalThis as any).Bun = {
		file: (path: string) => ({
			exists: async () => path in mockFileStore,
			json: async () => JSON.parse(mockFileStore[path]),
		}),
		write: async (path: string, content: string) => {
			mockFileStore[path] = content;
		},
		spawn: (_cmd: string[]) => ({ exited: Promise.resolve(0) }),
	};
});

import { addProject, loadProjects } from "../data";

const PROJECTS_FILE = "/tmp/dev3-test/projects.json";

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
		mockFileStore[PROJECTS_FILE] = JSON.stringify(existing);

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
