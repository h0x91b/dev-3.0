import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractInstanceFlag } from "../args";
import { formatInstanceSelector, parseInstanceSelector } from "../../shared/cli-instance";

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
const TEST_HOME = "/tmp/dev3-instance-targeting-test";
const DEV3 = `${TEST_HOME}/.dev3.0`;
const SOCKETS_DIR = `${DEV3}/sockets`;
const PROJECTS_FILE = `${DEV3}/projects.json`;
const TASKS_FILE = `${DEV3}/data/test-project/tasks.json`;

// Two tasks, each with a dev-server of its own, plus the installed app. This is
// the only configuration that can prove routing: with one task on the machine
// every selector and plain discovery answer the same socket.
const TASK_A = "aabbccdd-1111-2222-3333-444444444444";
const TASK_B = "bbccddee-1111-2222-3333-444444444444";
const WORKTREE_A = `${DEV3}/worktrees/test-project/aabbccdd/worktree`;

const PRIMARY_SOCK = `${SOCKETS_DIR}/100.sock`;
const GUEST_A_SOCK = `${SOCKETS_DIR}/200.sock`;
const GUEST_B_SOCK = `${SOCKETS_DIR}/300.sock`;

const HOSTS: Record<string, string | null> = {
	"100.meta.json": null,
	"200.meta.json": TASK_A,
	"300.meta.json": TASK_B,
};

describe("--instance selector parsing", () => {
	it("accepts every documented spelling", () => {
		expect(parseInstanceSelector("self")).toEqual({ kind: "self" });
		expect(parseInstanceSelector("primary")).toEqual({ kind: "primary" });
		expect(parseInstanceSelector("task:aabbccdd")).toEqual({ kind: "task", ref: "aabbccdd" });
		expect(parseInstanceSelector("seq:1513")).toEqual({ kind: "seq", seq: 1513 });
	});

	it("rejects anything else instead of guessing", () => {
		for (const bad of ["", "  ", "task:", "seq:", "seq:abc", "pid:71182", "1513", "Self"]) {
			expect(parseInstanceSelector(bad)).toBeNull();
		}
	});

	it("round-trips through formatInstanceSelector (the shim writes this back)", () => {
		for (const raw of ["self", "primary", "task:aabbccdd", "seq:1513"]) {
			expect(formatInstanceSelector(parseInstanceSelector(raw)!)).toBe(raw);
		}
	});
});

describe("extractInstanceFlag", () => {
	it("takes the flag out of argv so per-command flag validation never sees it", () => {
		expect(extractInstanceFlag(["task", "update", "--instance", "self", "--type", "coordinator"]))
			.toEqual({ rest: ["task", "update", "--type", "coordinator"], value: "self" });
	});

	it("accepts the --instance=value spelling", () => {
		expect(extractInstanceFlag(["task", "show", "--instance=task:aabbccdd"]))
			.toEqual({ rest: ["task", "show"], value: "task:aabbccdd" });
	});

	it("reports a missing value as empty rather than swallowing the next flag", () => {
		expect(extractInstanceFlag(["task", "show", "--instance", "--json"]))
			.toEqual({ rest: ["task", "show", "--json"], value: "" });
	});

	it("leaves an invocation without the flag untouched — the agent-hook path", () => {
		const argv = ["task", "move", "--status", "in-progress", "--if-status-not", "review-by-ai"];
		expect(extractInstanceFlag(argv)).toEqual({ rest: argv, value: null });
	});
});

describe("instance targeting against several live instances", () => {
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env.HOME = TEST_HOME;
		delete process.env.DEV3_CLI_SOCKET;
		delete process.env.DEV3_TASK_ID;
		delete process.env.DEV3_HOME;
		vi.resetModules();
		mockExistsSync.mockReset();
		mockReadFileSync.mockReset();
		mockReaddirSync.mockReset();
		mockStatSync.mockReset();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		mockExistsSync.mockImplementation((path: unknown) => (
			path === PROJECTS_FILE || path === TASKS_FILE || path === SOCKETS_DIR
			|| path === WORKTREE_A || String(path).endsWith(".sock")
		));
		mockReadFileSync.mockImplementation((path: unknown) => {
			const p = String(path);
			if (p === PROJECTS_FILE) return JSON.stringify([{ id: "proj-1", path: "/test/project" }]);
			if (p === TASKS_FILE) {
				return JSON.stringify([
					{ id: TASK_A, seq: 1513 },
					{ id: TASK_B, seq: 1630 },
				]);
			}
			const meta = Object.keys(HOSTS).find((name) => p.endsWith(name));
			if (meta) return JSON.stringify({ pid: 1, hostTaskId: HOSTS[meta], startedAt: "" });
			throw new Error(`Unexpected readFileSync path: ${p}`);
		});
		mockReaddirSync.mockReturnValue(["100.sock", "200.sock", "300.sock"]);
		mockStatSync.mockImplementation((path: unknown) => ({
			mtimeMs: String(path).includes("300") ? 300 : String(path).includes("200") ? 200 : 100,
		}));
	});

	afterEach(() => {
		process.env.HOME = REAL_HOME;
		delete process.env.DEV3_CLI_SOCKET;
		delete process.env.DEV3_TASK_ID;
		killSpy.mockRestore();
	});

	async function resolve(raw: string, cwd?: string) {
		const { resolveInstanceSocket } = await import("../context");
		return resolveInstanceSocket(parseInstanceSelector(raw)!, cwd);
	}

	it("routes --instance primary to the installed app, not the newest guest", async () => {
		expect((await resolve("primary")).socketPath).toBe(PRIMARY_SOCK);
	});

	it("routes --instance task:<prefix> to that task's own dev-server", async () => {
		expect((await resolve("task:aabbccdd")).socketPath).toBe(GUEST_A_SOCK);
		expect((await resolve("task:bbccddee")).socketPath).toBe(GUEST_B_SOCK);
	});

	it("routes --instance seq:<N> through the task number", async () => {
		expect((await resolve("seq:1513")).socketPath).toBe(GUEST_A_SOCK);
		expect((await resolve("seq:1630")).socketPath).toBe(GUEST_B_SOCK);
	});

	it("resolves --instance self from the worktree the shell is in", async () => {
		expect((await resolve("self", WORKTREE_A)).socketPath).toBe(GUEST_A_SOCK);
	});

	it("resolves --instance self from DEV3_TASK_ID when the cwd says nothing", async () => {
		process.env.DEV3_TASK_ID = TASK_B;
		expect((await resolve("self", "/somewhere/else")).socketPath).toBe(GUEST_B_SOCK);
	});

	it("errors instead of guessing when the shell has no task context", async () => {
		const result = await resolve("self", "/somewhere/else");
		expect(result.socketPath).toBeUndefined();
		expect(result.error).toContain("--instance self needs a task context");
	});

	it("errors, listing what is running, when nothing answers the selector", async () => {
		const result = await resolve("task:deadbeef");
		expect(result.socketPath).toBeUndefined();
		expect(result.error).toContain("No running dev3 instance matches");
		expect(result.error).toContain("pid 100 → primary");
		expect(result.error).toContain("pid 200 → task aabbccdd");
	});

	it("errors on an ambiguous selector rather than picking one", async () => {
		// A variant shares its sibling's seq, so one number can name two guests.
		mockReadFileSync.mockImplementation((path: unknown) => {
			const p = String(path);
			if (p === PROJECTS_FILE) return JSON.stringify([{ id: "proj-1", path: "/test/project" }]);
			if (p === TASKS_FILE) {
				return JSON.stringify([{ id: TASK_A, seq: 1513 }, { id: TASK_B, seq: 1513 }]);
			}
			const meta = Object.keys(HOSTS).find((name) => p.endsWith(name));
			if (meta) return JSON.stringify({ pid: 1, hostTaskId: HOSTS[meta], startedAt: "" });
			throw new Error(`Unexpected readFileSync path: ${p}`);
		});
		const result = await resolve("seq:1513");
		expect(result.socketPath).toBeUndefined();
		expect(result.error).toContain("matches 2 running instances");
	});

	it("ignores a dead instance the selector names", async () => {
		killSpy.mockImplementation((pid: number) => {
			if (pid === 200) {
				const err = new Error("no such process") as NodeJS.ErrnoException;
				err.code = "ESRCH";
				throw err;
			}
			return true;
		});
		expect((await resolve("task:aabbccdd")).error).toContain("No running dev3 instance matches");
	});

	// ── The half that must NOT change: how everything else resolves ──

	it("keeps plain discovery on the primary while two guests are live (the hook path)", async () => {
		const { resolveSocketPath } = await import("../context");
		// Same cwd an agent hook runs in — a task worktree with its own dev-server.
		expect(resolveSocketPath(WORKTREE_A)).toBe(PRIMARY_SOCK);
	});

	it("keeps plain discovery on the primary when DEV3_TASK_ID is set, as it is in every agent pane", async () => {
		process.env.DEV3_TASK_ID = TASK_A;
		const { resolveSocketPath } = await import("../context");
		expect(resolveSocketPath(WORKTREE_A)).toBe(PRIMARY_SOCK);
	});

	it("honours DEV3_CLI_SOCKET over discovery", async () => {
		process.env.DEV3_CLI_SOCKET = GUEST_B_SOCK;
		const { resolveSocketPath } = await import("../context");
		expect(resolveSocketPath(WORKTREE_A)).toBe(GUEST_B_SOCK);
	});

	it("falls back to discovery when DEV3_CLI_SOCKET points at something gone", async () => {
		process.env.DEV3_CLI_SOCKET = `${SOCKETS_DIR}/999.sock`;
		mockExistsSync.mockImplementation((path: unknown) => (
			path !== `${SOCKETS_DIR}/999.sock` && (
				path === PROJECTS_FILE || path === TASKS_FILE || path === SOCKETS_DIR
				|| path === WORKTREE_A || String(path).endsWith(".sock")
			)
		));
		const { resolveSocketPath } = await import("../context");
		expect(resolveSocketPath(WORKTREE_A)).toBe(PRIMARY_SOCK);
	});

	it("names the hosting task in the guest diagnostics tag", async () => {
		const { socketDiagnostics } = await import("../context");
		const out = socketDiagnostics(WORKTREE_A);
		expect(out).toContain("hosted by task aabbccdd");
		expect(out).toContain("--instance task:aabbccdd");
	});
});
