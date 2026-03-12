import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

let mockFileStore: Record<string, string> = {};
let mockUnlinked: string[] = [];

vi.mock("node:fs", () => ({
	unlinkSync: vi.fn((path: string) => {
		mockUnlinked.push(path);
		delete mockFileStore[path];
	}),
}));

beforeEach(() => {
	mockFileStore = {};
	mockUnlinked = [];
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

import { saveHibernateState, loadHibernateState, clearHibernateState } from "../data";

const HIBERNATE_FILE = "/tmp/dev3-test/hibernate-state.json";

describe("hibernate state persistence", () => {
	describe("saveHibernateState", () => {
		it("writes task IDs to the hibernate file", async () => {
			await saveHibernateState(["task-1", "task-2"]);

			expect(mockFileStore[HIBERNATE_FILE]).toBeDefined();
			const data = JSON.parse(mockFileStore[HIBERNATE_FILE]);
			expect(data.taskIds).toEqual(["task-1", "task-2"]);
		});

		it("handles empty array", async () => {
			await saveHibernateState([]);

			const data = JSON.parse(mockFileStore[HIBERNATE_FILE]);
			expect(data.taskIds).toEqual([]);
		});
	});

	describe("loadHibernateState", () => {
		it("returns task IDs from file", async () => {
			mockFileStore[HIBERNATE_FILE] = JSON.stringify({ taskIds: ["a", "b", "c"] });

			const result = await loadHibernateState();
			expect(result).toEqual(["a", "b", "c"]);
		});

		it("returns empty array when file does not exist", async () => {
			const result = await loadHibernateState();
			expect(result).toEqual([]);
		});

		it("returns empty array when file has invalid JSON", async () => {
			mockFileStore[HIBERNATE_FILE] = "not json";

			const result = await loadHibernateState();
			expect(result).toEqual([]);
		});

		it("returns empty array when taskIds is not an array", async () => {
			mockFileStore[HIBERNATE_FILE] = JSON.stringify({ taskIds: "wrong" });

			const result = await loadHibernateState();
			expect(result).toEqual([]);
		});

		it("returns empty array when taskIds is missing", async () => {
			mockFileStore[HIBERNATE_FILE] = JSON.stringify({ other: true });

			const result = await loadHibernateState();
			expect(result).toEqual([]);
		});
	});

	describe("clearHibernateState", () => {
		it("deletes the hibernate file", async () => {
			mockFileStore[HIBERNATE_FILE] = JSON.stringify({ taskIds: ["x"] });

			await clearHibernateState();
			expect(mockUnlinked).toContain(HIBERNATE_FILE);
		});

		it("does nothing when file does not exist", async () => {
			await clearHibernateState();
			expect(mockUnlinked).toHaveLength(0);
		});
	});

	describe("round-trip", () => {
		it("save → load → clear cycle works", async () => {
			const ids = ["task-aaa", "task-bbb"];

			await saveHibernateState(ids);
			const loaded = await loadHibernateState();
			expect(loaded).toEqual(ids);

			await clearHibernateState();
			const after = await loadHibernateState();
			expect(after).toEqual([]);
		});
	});
});
