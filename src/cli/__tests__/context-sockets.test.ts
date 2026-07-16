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
const TASK_ID = "aabbccdd-1111-4222-8333-444444444444";
const TASK_OWNER_FILE = `${SOCKETS_DIR}/task-owners/${TASK_ID}.json`;

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
					{ id: TASK_ID },
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

	// A "guest" instance (a dev3 app launched from inside a task context — e.g.
	// the dev-channel build a devScript boots inside the dev-server tmux session)
	// writes a meta sidecar with hostTaskId. Its socket is the newest by mtime,
	// but routing control commands to it is what killed stop/restart: the guest
	// reaps its own process tree mid-request (issues #910/#920).
	it("deprioritizes guest sockets (meta hostTaskId) even when they are newest", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("67566.sock") ? 200 : 100,
		}));
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "aabbccdd-1111-2222-3333-444444444444", startedAt: "2026-07-13T00:00:00Z" });
			}
			return baseRead(path, ...rest);
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx).not.toBeNull();
		expect(ctx!.socketPath).toBe(`${SOCKETS_DIR}/44818.sock`);
	});

	it("still returns a guest socket when it is the only live one", async () => {
		mockReaddirSync.mockReturnValue(["67566.sock"]);
		mockStatSync.mockReturnValue({ mtimeMs: 200 });
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "aabbccdd-1111-2222-3333-444444444444", startedAt: "2026-07-13T00:00:00Z" });
			}
			return baseRead(path, ...rest);
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx).not.toBeNull();
		expect(ctx!.socketPath).toBe(`${SOCKETS_DIR}/67566.sock`);
	});

	it("prefers the logical task owner guest over an unrelated primary", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("44818.sock") ? 300 : 100,
		}));
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === TASK_OWNER_FILE) {
				return JSON.stringify({ taskId: TASK_ID, ownerKey: "remote:18856", claimedAt: 500 });
			}
			if (path === `${SOCKETS_DIR}/44818.meta.json`) {
				return JSON.stringify({ pid: 44818, hostTaskId: null, startedAt: "", ownerKey: "process:44818" });
			}
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "other-task", startedAt: "", ownerKey: "remote:18856" });
			}
			return baseRead(path, ...rest);
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx?.socketPath).toBe(`${SOCKETS_DIR}/67566.sock`);
	});

	it("never lets a self-hosted task owner override the primary safety route", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockReturnValue({ mtimeMs: 100 });
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === TASK_OWNER_FILE) {
				return JSON.stringify({ taskId: TASK_ID, ownerKey: "remote:18856", claimedAt: 500 });
			}
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: TASK_ID, startedAt: "", ownerKey: "remote:18856" });
			}
			return baseRead(path, ...rest);
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx?.socketPath).toBe(`${SOCKETS_DIR}/44818.sock`);
	});

	it("falls back when the claimed owner PID is dead", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockReturnValue({ mtimeMs: 100 });
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === TASK_OWNER_FILE) {
				return JSON.stringify({ taskId: TASK_ID, ownerKey: "remote:18856", claimedAt: 500 });
			}
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "other-task", startedAt: "", ownerKey: "remote:18856" });
			}
			return baseRead(path, ...rest);
		});
		killSpy.mockImplementation((pid: number) => {
			if (pid === 67566) {
				const error = new Error("gone") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			}
			return true;
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx?.socketPath).toBe(`${SOCKETS_DIR}/44818.sock`);
	});

	it("tries an EPERM-only task owner before an unrelated confirmed-live primary", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockReturnValue({ mtimeMs: 100 });
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === TASK_OWNER_FILE) {
				return JSON.stringify({ taskId: TASK_ID, ownerKey: "remote:18856", claimedAt: 500 });
			}
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "other-task", startedAt: "", ownerKey: "remote:18856" });
			}
			return baseRead(path, ...rest);
		});
		killSpy.mockImplementation((pid: number) => {
			if (pid === 67566) {
				const error = new Error("blocked") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return true;
		});

		const { resolveSocketPathForTask } = await import("../context");
		const socketPath = resolveSocketPathForTask(TASK_ID, { cwd: TEST_CWD });

		expect(socketPath).toBe(`${SOCKETS_DIR}/67566.sock`);
		expect(killSpy).toHaveBeenCalledTimes(1);
	});

	it("a restarted headless socket inherits the stable owner key without a new task claim", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock", "70000.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("70000.sock") ? 300 : 100,
		}));
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === TASK_OWNER_FILE) {
				return JSON.stringify({ taskId: TASK_ID, ownerKey: "remote:18856", claimedAt: 500 });
			}
			if (path === `${SOCKETS_DIR}/67566.meta.json` || path === `${SOCKETS_DIR}/70000.meta.json`) {
				const pid = String(path).includes("70000") ? 70000 : 67566;
				return JSON.stringify({ pid, hostTaskId: "other-task", startedAt: "", ownerKey: "remote:18856" });
			}
			return baseRead(path, ...rest);
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx?.socketPath).toBe(`${SOCKETS_DIR}/70000.sock`);
	});

	it("ignores malformed or sibling-prefix owner claims", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("67566.sock") ? 200 : 100,
		}));
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === TASK_OWNER_FILE) {
				return JSON.stringify({
					taskId: "aabbccdd-9999-4999-8999-999999999999",
					ownerKey: "remote:18856",
					claimedAt: 500,
				});
			}
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "other-task", startedAt: "", ownerKey: "remote:18856" });
			}
			return baseRead(path, ...rest);
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx?.socketPath).toBe(`${SOCKETS_DIR}/44818.sock`);
	});

	// Sandbox flavor of #910: process.kill(pid, 0) is EPERM-blocked, so even a
	// DEAD guest's leftover socket stays a candidate. The primary must still win.
	it("prefers a primary candidate over a guest candidate when signals are blocked", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("67566.sock") ? 200 : 100,
		}));
		const baseRead = mockReadFileSync.getMockImplementation()!;
		mockReadFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
			if (path === `${SOCKETS_DIR}/67566.meta.json`) {
				return JSON.stringify({ pid: 67566, hostTaskId: "aabbccdd-1111-2222-3333-444444444444", startedAt: "2026-07-13T00:00:00Z" });
			}
			return baseRead(path, ...rest);
		});
		killSpy.mockImplementation((_pid: number) => {
			const error = new Error("blocked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});

		const { detectContext } = await import("../context");
		const ctx = detectContext(TEST_CWD);

		expect(ctx).not.toBeNull();
		expect(ctx!.socketPath).toBe(`${SOCKETS_DIR}/44818.sock`);
	});

	// Failover discovery for devServer.* commands: the socket that just died
	// mid-request must be excludable, or the sandbox candidate fallback keeps
	// returning the same dead socket forever.
	it("discoverSocketExcluding skips the excluded socket path", async () => {
		mockReaddirSync.mockReturnValue(["44818.sock", "67566.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).endsWith("67566.sock") ? 200 : 100,
		}));

		const { discoverSocketExcluding } = await import("../context");
		const found = discoverSocketExcluding([`${SOCKETS_DIR}/67566.sock`]);

		expect(found).toBe(`${SOCKETS_DIR}/44818.sock`);
	});

	it("resolveSocketPathWithRetry returns a socket on the first successful probe", async () => {
		mockReaddirSync.mockReturnValue(["999.sock"]);
		mockStatSync.mockReturnValue({ mtimeMs: 100 });

		const { resolveSocketPathWithRetry } = await import("../context");
		const result = await resolveSocketPathWithRetry(TEST_CWD, { attempts: 3, retryDelayMs: 5 });

		expect(result).toBe(`${SOCKETS_DIR}/999.sock`);
	});

	it("resolveSocketPathWithRetry gives up (null) after attempts when no socket appears", async () => {
		mockExistsSync.mockImplementation(() => false);
		mockReaddirSync.mockReturnValue([]);

		const { resolveSocketPathWithRetry } = await import("../context");
		const start = Date.now();
		const result = await resolveSocketPathWithRetry(TEST_CWD, { attempts: 3, retryDelayMs: 5 });

		expect(result).toBeNull();
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("socketDiagnostics distinguishes live from stale sockets", async () => {
		mockReaddirSync.mockReturnValue(["123.sock", "456.sock"]);
		killSpy.mockImplementation((pid: number) => {
			if (pid === 456) {
				const error = new Error("gone") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			}
			return true;
		});

		const { socketDiagnostics } = await import("../context");
		const out = socketDiagnostics(TEST_CWD);

		expect(out).toContain(`HOME: ${TEST_HOME}`);
		expect(out).toContain("socket 123.sock: pid=123 → process alive");
		expect(out).toContain("socket 456.sock: pid=456 → process dead (stale socket)");
	});

	it("socketDiagnostics flags a missing sockets dir (likely wrong HOME)", async () => {
		mockExistsSync.mockImplementation(() => false);

		const { socketDiagnostics } = await import("../context");
		const out = socketDiagnostics(TEST_CWD);

		expect(out).toContain("sockets dir status: NOT FOUND");
	});
});
