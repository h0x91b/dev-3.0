import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock("node:fs", () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
	statSync: (...args: unknown[]) => mockStatSync(...args),
}));

const REAL_HOME = process.env.HOME || "/tmp";
const TEST_HOME = "/tmp/dev3-cli-socket-test";
const TEST_CWD = `${TEST_HOME}/.dev3.0/worktrees/test-project/aabbccdd/worktree`;
const PROJECTS_FILE = `${TEST_HOME}/.dev3.0/projects.json`;
const TASKS_FILE = `${TEST_HOME}/.dev3.0/data/test-project/tasks.json`;
const SOCKETS_DIR = `${TEST_HOME}/.dev3.0/sockets`;

describe("detectContext socket selection", () => {
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env.HOME = TEST_HOME;
		vi.resetModules();
		mockExistsSync.mockReset();
		mockReadFileSync.mockReset();
		mockReaddirSync.mockReset();
		mockStatSync.mockReset();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		mockExistsSync.mockImplementation((path: unknown) => (
			path === PROJECTS_FILE ||
			path === TASKS_FILE ||
			path === SOCKETS_DIR ||
			path === TEST_CWD
		));
		mockReadFileSync.mockImplementation((path: unknown) => {
			if (path === PROJECTS_FILE) {
				return JSON.stringify([
					{ id: "proj-1", path: "/test/project" },
				]);
			}
			if (path === TASKS_FILE) {
				return JSON.stringify([
					{ id: "aabbccdd-1111-2222-3333-444444444444" },
				]);
			}
			throw new Error(`Unexpected readFileSync path: ${String(path)}`);
		});
	});

	afterEach(() => {
		process.env.HOME = REAL_HOME;
		killSpy.mockRestore();
	});

	it("prefers the newest live socket when multiple app instances are running", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("67566.sock") ? 200 : 100,
		}));

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx).not.toBeNull();
		expect(ctx!.socketPath).toBe(`${SOCKETS_DIR}/67566.sock`);
		expect(killSpy).toHaveBeenCalledWith(67566, 0);
		expect(killSpy).not.toHaveBeenCalledWith(44818, 0);
	});

	it("falls back to the newest EPERM candidate when signals are blocked", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("67566.sock") ? 200 : 100,
		}));
		killSpy.mockImplementation((_pid: number) => {
			const error = new Error("blocked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx).not.toBeNull();
		expect(ctx!.socketPath).toBe(`${SOCKETS_DIR}/67566.sock`);
		expect(killSpy).toHaveBeenCalledWith(67566, 0);
		expect(killSpy).toHaveBeenCalledWith(44818, 0);
	});
});
