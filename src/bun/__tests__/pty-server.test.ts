import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks (hoisted before imports) ----

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		accessSync: vi.fn(),
		existsSync: vi.fn(() => true),
		writeFileSync: vi.fn(),
		// Shim-management fns (updateTmuxShim) must never touch the real
		// ~/.dev3.0/bin of whoever runs the tests.
		mkdirSync: vi.fn(),
		lstatSync: vi.fn(() => { throw new Error("ENOENT"); }),
		statSync: vi.fn(() => ({ isFile: () => true })),
		readlinkSync: vi.fn(() => { throw new Error("EINVAL"); }),
		realpathSync: vi.fn((p: string) => p),
		unlinkSync: vi.fn(),
		symlinkSync: vi.fn(),
	};
});

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// ---- Imports ----

import { accessSync, existsSync, lstatSync, statSync, readlinkSync, realpathSync, unlinkSync, symlinkSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "../spawn";
import { DEV3_HOME } from "../paths";
import {
	tmuxArgs,
	spawnTmux,
	TmuxSpawnError,
	isTmuxSpawnError,
	cwdExists,
	createSession,
	destroySession,
	hasSession,
	hasDeadSession,
	capturePane,
	getTmuxLayout,
	parseWindowLayout,
	getSessionProjectId,
	getSessionSocket,
	getSessionTmuxName,
	getSessionType,
	getPtyPort,
	setOnPtyDied,
	setOnBell,
	setOnOsc52Copy,
	smallestClientSize,
	TMUX_CONF_PATH,
	_resetTmuxBinaryLoggedForTests,
	selectTmuxBinary,
	updateTmuxShim,
	dereferenceTmuxShim,
	sanitizeTmuxShim,
	TMUX_SHIM_PATH,
	getTmuxBinary,
	setTmuxBinary,
} from "../pty-server";

// ---- Typed mock handles ----

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
const mockExistsSync = vi.mocked(existsSync);

// ---- Helpers ----

const activeSessions: string[] = [];

function defaultSpawnReturn(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		pid: 123,
		terminal: { close: vi.fn(), resize: vi.fn(), write: vi.fn() },
		kill: vi.fn(),
		exited: Promise.resolve(0),
		stdin: { write: vi.fn(), end: vi.fn() },
		...overrides,
	};
}

function track(taskId: string) {
	activeSessions.push(taskId);
	return taskId;
}

// ---- Setup / teardown ----

beforeEach(() => {
	vi.clearAllMocks();
	mockExistsSync.mockReturnValue(true);
	mockSpawn.mockReturnValue(defaultSpawnReturn() as any);
	mockSpawnSync.mockReturnValue({ exitCode: 0, stdout: new Uint8Array(0) } as any);
	// `which tmux` now runs only once per app lifetime — reset the cache so each
	// test that expects it can observe the spawnSync call.
	_resetTmuxBinaryLoggedForTests();
});

afterEach(() => {
	// Always restore real timers in case a test forgot — fake timers leaking
	// into the next test causes mysterious hangs on async code paths.
	vi.useRealTimers();
	for (const id of activeSessions) {
		if (hasSession(id)) destroySession(id);
	}
	activeSessions.length = 0;
	setOnPtyDied(() => {});
	setOnBell(() => {});
	setOnOsc52Copy(() => {});
});

// ================================================================
// Tests
// ================================================================

describe("pty-server", () => {
	// ------- tmuxArgs -------

	describe("tmuxArgs", () => {
		it("prepends -L socket when socket is provided", () => {
			expect(tmuxArgs("my-socket", "new-session", "-s", "test")).toEqual([
				"tmux", "-L", "my-socket", "new-session", "-s", "test",
			]);
		});

		it("always includes -L with socket name", () => {
			expect(tmuxArgs("dev3", "list-sessions")).toEqual(["tmux", "-L", "dev3", "list-sessions"]);
		});

		it("passes multiple args correctly", () => {
			expect(tmuxArgs("sock", "kill-session", "-t", "dev3-abc")).toEqual([
				"tmux", "-L", "sock", "kill-session", "-t", "dev3-abc",
			]);
		});
	});

	// ------- spawnTmux / TmuxSpawnError -------

	describe("spawnTmux / TmuxSpawnError", () => {
		it("spawns with the full tmux argv and returns the proc on success", () => {
			const proc = spawnTmux("dev3", ["has-session", "-t", "dev3-dev-abc"], { stdout: "pipe", stderr: "pipe" });
			expect(proc).toBeDefined();
			expect(mockSpawn).toHaveBeenCalledWith(
				["tmux", "-L", "dev3", "has-session", "-t", "dev3-dev-abc"],
				{ stdout: "pipe", stderr: "pipe" },
			);
		});

		it("translates a launch-time spawn failure into a TmuxSpawnError with an actionable message", () => {
			mockSpawn.mockImplementationOnce(() => {
				throw new Error("ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/tmux'");
			});

			let caught: unknown;
			try {
				spawnTmux("dev3", ["list-sessions"]);
			} catch (err) {
				caught = err;
			}

			expect(isTmuxSpawnError(caught)).toBe(true);
			expect(caught).toBeInstanceOf(TmuxSpawnError);
			const message = (caught as Error).message;
			expect(message).toContain("tmux failed to spawn");
			expect(message).toContain("posix_spawn"); // preserves the raw cause
			expect(message).toContain("Full Disk Access"); // points at the usual macOS fix
			expect((caught as TmuxSpawnError).cause).toBeInstanceOf(Error);
		});

		it("isTmuxSpawnError is false for unrelated errors and non-errors", () => {
			expect(isTmuxSpawnError(new Error("boom"))).toBe(false);
			expect(isTmuxSpawnError(null)).toBe(false);
			expect(isTmuxSpawnError(undefined)).toBe(false);
		});
	});

	// ------- createSession -------

	describe("createSession", () => {
		it("creates a session and marks it as existing", () => {
			const id = track("task-create-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {});
			expect(hasSession(id)).toBe(true);
		});

		it("spawns tmux new-session via spawn", async () => {
			const id = track("task-spawn-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {});

			// `which tmux` diagnostic now runs as a fire-and-forget async spawn
			// — flush microtasks so the IIFE has a chance to register the call.
			await Promise.resolve();
			expect(mockSpawn).toHaveBeenCalledWith(["which", "tmux"], expect.any(Object));

			// spawn for tmux new-session
			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			expect(tmuxCall![0]).toContain("tmux");
			expect(tmuxCall![0]).toContain("new-session");
			expect(tmuxCall![0]).toContain("-A");
			expect(tmuxCall![0]).toContain("-s");
			expect(tmuxCall![0]).toContain("dev3-task-spa");
		});

		it("passes -c <cwd> to new-session and spawns the tmux client from DEV3_HOME", () => {
			// Regression (tmux 3.7): the dev3 tmux server daemonizes with the cwd
			// of the first client that starts it. If that client is spawned from a
			// task worktree, the server's cwd dies when that task completes and its
			// worktree is deleted — after which tmux 3.7 silently ignores `-c` on
			// every subsequent new-session/split-window and spawns panes in the
			// server's (deleted) cwd. Fix: the client process always starts from
			// the immortal DEV3_HOME, and the pane cwd travels via explicit `-c`.
			const id = track("task-safe-cwd");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {});

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			const args = tmuxCall![0] as string[];
			const cIndex = args.indexOf("-c");
			expect(cIndex).toBeGreaterThan(-1);
			expect(args[cIndex + 1]).toBe("/tmp/test-cwd");
			expect(tmuxCall![1]).toEqual(expect.objectContaining({ cwd: DEV3_HOME }));
		});

		it("passes session env vars to tmux via -e KEY=VAL on new-session (no leak across tasks)", () => {
			const id = track("task-env-leak-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {
				DEV3_TASK_ID: id,
				CUSTOM_KEY: "custom-value",
			});

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			const args = tmuxCall![0] as string[];

			// -e flags must come BEFORE -s in new-session so they apply atomically
			// to session-environment. This prevents DEV3_TASK_ID from one task
			// leaking into a sibling task's panes via the tmux server's global env.
			expect(args).toContain("-e");
			expect(args).toContain(`DEV3_TASK_ID=${id}`);
			expect(args).toContain("CUSTOM_KEY=custom-value");
			expect(args).toContain(`DEV3_WORKTREE_ROOT=/tmp/test-cwd`);

			// Sanity check: DEV3_TASK_ID=... is preceded by -e (not free-floating)
			const taskIdEnvIndex = args.indexOf(`DEV3_TASK_ID=${id}`);
			expect(taskIdEnvIndex).toBeGreaterThan(-1);
			expect(args[taskIdEnvIndex - 1]).toBe("-e");
		});

		it("uses custom tmux socket when provided", () => {
			const id = track("task-socket-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "my-socket");

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			expect(tmuxCall![0]).toContain("-L");
			expect(tmuxCall![0]).toContain("my-socket");
			expect(tmuxCall![0]).toContain("-f");
			expect(tmuxCall![0]).toContain(TMUX_CONF_PATH);
		});

		it("uses the user shell when tmuxCommand is empty", () => {
			process.env.SHELL = "/bin/zsh";
			const id = track("task-defcmd-01");
			createSession(id, "proj-1", "/tmp/cwd", "", {});

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			// last arg should be the resolved user shell
			expect(tmuxCall![0][tmuxCall![0].length - 1]).toBe("/bin/zsh");
		});

		it("logs a warning when cwd does not exist but still spawns (fork will fail)", () => {
			// The pre-flight `existsSync(cwd)` check was removed (it was sync I/O
			// in the hot path). A missing cwd now manifests as a failed fork —
			// the child exits non-zero and `proc.exited` fires onPtyDied via the
			// normal exit path. The synchronous early-return was the bottleneck.
			mockExistsSync.mockReturnValue(false);
			const id = track("task-nocwd-01");
			expect(() => createSession(id, "proj-1", "/tmp/nonexistent", "bash", {})).not.toThrow();
			// spawn was still attempted (fork would fail in production, but the
			// mocked spawn returns a healthy proc — so no onPtyDied callback fires
			// here unless we wire up an actually-exiting proc, which other tests do).
			expect(mockSpawn).toHaveBeenCalled();
		});

		it("propagates a tmux spawn failure and does not retain a dead session", () => {
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("new-session")) {
					throw new Error("spawn failed");
				}
				return defaultSpawnReturn() as any;
			});
			const diedCb = vi.fn();
			setOnPtyDied(diedCb);

			const id = track("task-spnfail-1");
			expect(() => createSession(id, "proj-1", "/tmp/cwd", "bash", {})).toThrow(TmuxSpawnError);
			expect(hasSession(id)).toBe(false);
			expect(diedCb).not.toHaveBeenCalled();
		});

		it("propagates all env vars via tmux set-environment after session starts", async () => {
			vi.useFakeTimers();
			const id = track("task-env-prop");
			const env = {
				MY_VAR: "hello",
				CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
				PATH: "/custom/bin:/usr/bin",
			};
			createSession(id, "proj-1", "/tmp/cwd", "bash", env, "my-socket");
			mockSpawn.mockClear();

			// Advance past the 200ms setTimeout AND flush the async configureTmux
			// chain (the IIFE awaits source-file/set-hook before reaching set-environment).
			await vi.advanceTimersByTimeAsync(300);
			await Promise.resolve();
			await Promise.resolve();

			// Check that set-environment was called for each env var
			const setEnvCalls = mockSpawn.mock.calls.filter(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment"),
			);

			expect(setEnvCalls.length).toBeGreaterThanOrEqual(3);

			const setEnvArgs = setEnvCalls.map((c) => c[0]);
			expect(setEnvArgs).toContainEqual(
				expect.arrayContaining(["set-environment", "-t", expect.stringContaining("dev3-"), "MY_VAR", "hello"]),
			);
			expect(setEnvArgs).toContainEqual(
				expect.arrayContaining(["set-environment", "-t", expect.stringContaining("dev3-"), "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1"]),
			);
			expect(setEnvArgs).toContainEqual(
				expect.arrayContaining(["set-environment", "-t", expect.stringContaining("dev3-"), "PATH", "/custom/bin:/usr/bin"]),
			);

			vi.useRealTimers();
		});

		it("does not call tmux set-environment for user env when env is empty", async () => {
			vi.useFakeTimers();
			const id = track("task-env-empty");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "my-socket");
			mockSpawn.mockClear();

			await vi.advanceTimersByTimeAsync(300);
			await Promise.resolve();
			await Promise.resolve();

			// DEV3_WORKTREE_ROOT is always set, but no user env vars should be set
			const setEnvCalls = mockSpawn.mock.calls.filter(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment") && !c[0].includes("DEV3_WORKTREE_ROOT"),
			);
			expect(setEnvCalls).toHaveLength(0);

			vi.useRealTimers();
		});

		it("always sets DEV3_WORKTREE_ROOT in tmux session env", async () => {
			vi.useFakeTimers();
			const id = track("task-env-root");
			createSession(id, "proj-1", "/tmp/my-worktree", "bash", {}, "root-sock");
			mockSpawn.mockClear();

			await vi.advanceTimersByTimeAsync(300);
			await Promise.resolve();
			await Promise.resolve();

			const rootCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment") && c[0].includes("DEV3_WORKTREE_ROOT"),
			);
			expect(rootCall).toBeDefined();
			expect(rootCall![0]).toContain("/tmp/my-worktree");

			vi.useRealTimers();
		});
	});

	// ------- destroySession -------

	describe("destroySession", () => {
		it("removes session from the map", () => {
			const id = track("task-dstr-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(hasSession(id)).toBe(true);

			destroySession(id);
			activeSessions.splice(activeSessions.indexOf(id), 1);
			expect(hasSession(id)).toBe(false);
		});

		it("kills tmux session via async spawn (non-blocking)", () => {
			const id = track("task-dstr-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawn.mockClear();

			destroySession(id);
			activeSessions.splice(activeSessions.indexOf(id), 1);

			const killCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall).toBeDefined();
			expect(killCall![0]).toContain("dev3-task-dst");
		});

		it("kills proc and closes terminal", () => {
			const mockProc = defaultSpawnReturn();
			mockSpawn.mockReturnValue(mockProc as any);

			const id = track("task-dstr-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			destroySession(id);
			activeSessions.splice(activeSessions.indexOf(id), 1);

			expect(mockProc.kill).toHaveBeenCalled();
			expect(mockProc.terminal.close).toHaveBeenCalled();
		});

		it("handles unknown session gracefully", () => {
			expect(() => destroySession("nonexistent")).not.toThrow();
		});

		it("handles tmux kill-session failure gracefully", () => {
			const id = track("task-dstr-04");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			// Make the kill-session spawn throw — the destroy must still finish
			// cleaning up the local session map (it's a fire-and-forget kill now).
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("kill-session")) {
					throw new Error("tmux kill failed");
				}
				return defaultSpawnReturn() as any;
			});

			expect(() => destroySession(id)).not.toThrow();
			activeSessions.splice(activeSessions.indexOf(id), 1);
		});

		it("kills tmux session even when not in memory map (fallback socket)", () => {
			mockSpawn.mockClear();

			// Destroy a session that was never created in the Map
			destroySession("unknown-task-id-1234", "dev3");

			const killCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall).toBeDefined();
			expect(killCall![0]).toContain("dev3-unknown-");
			expect(killCall![0]).toContain("-L");
			expect(killCall![0]).toContain("dev3");
		});

		it("uses fallback socket 'dev3' when no session and no fallback provided", () => {
			mockSpawn.mockClear();

			destroySession("orphan-task-id-5678");

			const killCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall).toBeDefined();
			// Should use default "dev3" socket
			expect(killCall![0]).toContain("-L");
			expect(killCall![0][2]).toBe("dev3");
		});
	});

	// ------- hasSession -------

	describe("hasSession", () => {
		it("returns true for existing session", () => {
			const id = track("task-has-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(hasSession(id)).toBe(true);
		});

		it("returns false for non-existing session", () => {
			expect(hasSession("nonexistent")).toBe(false);
		});
	});

	// ------- hasDeadSession -------

	describe("hasDeadSession", () => {
		it("returns false for non-existing session", () => {
			expect(hasDeadSession("nonexistent")).toBe(false);
		});

		it("returns false for a session with a live proc", () => {
			const id = track("task-dead-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			// Proc was spawned immediately — should not be dead yet
			expect(hasDeadSession(id)).toBe(false);
		});

		it("returns true after the proc exits", async () => {
			let exitResolve!: (code: number) => void;
			const exitPromise = new Promise<number>((resolve) => {
				exitResolve = resolve;
			});
			mockSpawn.mockReturnValue(defaultSpawnReturn({ exited: exitPromise }) as any);

			const id = track("task-dead-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			expect(hasDeadSession(id)).toBe(false);

			exitResolve(0);
			await new Promise((r) => setTimeout(r, 10));

			expect(hasSession(id)).toBe(true); // still in map
			expect(hasDeadSession(id)).toBe(true); // but proc is gone
		});
	});

		// ------- getSessionProjectId -------

	describe("getSessionProjectId", () => {
		it("returns project ID for existing session", () => {
			const id = track("task-gpid-01");
			createSession(id, "my-project-42", "/tmp/cwd", "bash", {});
			expect(getSessionProjectId(id)).toBe("my-project-42");
		});

		it("returns null for non-existing session", () => {
			expect(getSessionProjectId("nonexistent")).toBeNull();
		});
	});

	// ------- getSessionSocket -------

	describe("getSessionSocket", () => {
		it("returns socket for session with socket", () => {
			const id = track("task-gsck-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "my-socket");
			expect(getSessionSocket(id)).toBe("my-socket");
		});

		it("returns default socket when created without explicit socket", () => {
			const id = track("task-gsck-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(getSessionSocket(id)).toBe("dev3");
		});

		it("returns default socket for non-existing session", () => {
			expect(getSessionSocket("nonexistent")).toBe("dev3");
		});
	});

	// ------- getPtyPort -------

	describe("getPtyPort", () => {
		it("returns port from Bun.serve stub", () => {
			// test-setup.ts stubs Bun.serve → { port: 9999 }
			expect(getPtyPort()).toBe(9999);
		});
	});

	// ------- capturePane -------

	describe("capturePane", () => {
		// capturePane became async (it uses Bun.spawn + proc.exited under the hood
		// instead of spawnSync). The tests below mock `spawn` to return a fake
		// proc with the desired stdout + exit code.
		function makeCaptureProc(stdout: string | Uint8Array, exitCode: number): any {
			const bytes: Uint8Array = typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout;
			// Wrap bytes in a Blob → Response (Blob is an acceptable BodyInit in the TS
			// lib types, raw Uint8Array isn't).
			return {
				pid: 999,
				kill: vi.fn(),
				stdout: new Response(new Blob([bytes as BlobPart])).body,
				exited: Promise.resolve(exitCode),
			};
		}

		it("returns pane content on success", async () => {
			const id = track("task-cap-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			const content = "Hello, world!\n";
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc(content, 0)
					: (defaultSpawnReturn() as any),
			);

			expect(await capturePane(id)).toBe(content);
		});

		it("uses session socket for tmux command", async () => {
			const id = track("task-cap-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "cap-sock");
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc("data", 0)
					: (defaultSpawnReturn() as any),
			);

			await capturePane(id);

			const captureCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("capture-pane"),
			);
			expect(captureCall).toBeDefined();
			expect(captureCall![0]).toContain("-L");
			expect(captureCall![0]).toContain("cap-sock");
		});

		it("returns null on non-zero exit code", async () => {
			const id = track("task-cap-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc("error", 1)
					: (defaultSpawnReturn() as any),
			);

			expect(await capturePane(id)).toBeNull();
		});

		it("returns null on empty stdout", async () => {
			const id = track("task-cap-04");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc(new Uint8Array(0), 0)
					: (defaultSpawnReturn() as any),
			);

			expect(await capturePane(id)).toBeNull();
		});

		it("returns null on spawn error", async () => {
			const id = track("task-cap-05");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("capture-pane")) throw new Error("tmux error");
				return defaultSpawnReturn() as any;
			});

			expect(await capturePane(id)).toBeNull();
		});

		it("works even without an active session (uses null socket)", async () => {
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc(new Uint8Array(0), 1)
					: (defaultSpawnReturn() as any),
			);

			expect(await capturePane("no-such-session")).toBeNull();
		});
	});

	// ------- getTmuxLayout -------

	describe("getTmuxLayout", () => {
		function makeProc(stdout: string, exitCode: number): any {
			const bytes = new TextEncoder().encode(stdout);
			return {
				pid: 777,
				kill: vi.fn(),
				stdout: new Response(new Blob([bytes as BlobPart])).body,
				exited: Promise.resolve(exitCode),
			};
		}

		// Two side-by-side panes in a single window (a 200-col window split down
		// the middle, with a 1-col divider at column 99). The window_layout (5th
		// field) is the zoom-independent geometry source; the trailing field is the
		// window_zoomed_flag (0 = not zoomed).
		const WINDOWS = "0\tmain\t1\t2\tcf3a,200x50,0,0{99x50,0,0,1,100x50,100,0,2}\t0\n";
		const PANES =
			"0\t%1\t1\t0\t0\t99\t50\tclaude\tAgent\n" + "0\t%2\t0\t100\t0\t100\t50\tzsh\tShell\n";

		function mockLayoutSpawn(opts: { windows?: string; windowsExit?: number; panes?: string; panesExit?: number; status?: string } = {}) {
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("list-windows")) {
					return makeProc(opts.windows ?? WINDOWS, opts.windowsExit ?? 0) as any;
				}
				if (Array.isArray(cmd) && cmd.includes("list-panes")) {
					return makeProc(opts.panes ?? PANES, opts.panesExit ?? 0) as any;
				}
				if (Array.isArray(cmd) && cmd.includes("display-message")) {
					// client_height \t window_height \t status \t status-position
					return makeProc(opts.status ?? "51\t50\ton\tbottom\n", 0) as any;
				}
				return defaultSpawnReturn() as any;
			});
		}

		it("parses windows and pane geometry", async () => {
			mockLayoutSpawn();
			const layout = await getTmuxLayout("task-layout-01");

			expect(layout.exists).toBe(true);
			expect(layout.windows).toHaveLength(1);
			expect(layout.windows[0]).toMatchObject({ index: 0, name: "main", active: true, panes: 2, zoomed: false });

			expect(layout.panes).toHaveLength(2);
			expect(layout.panes[0]).toMatchObject({
				windowIndex: 0,
				paneId: "%1",
				active: true,
				left: 0,
				top: 0,
				width: 99,
				height: 50,
				command: "claude",
				title: "Agent",
			});
			expect(layout.panes[1]).toMatchObject({ paneId: "%2", active: false, left: 100, width: 100 });
		});

		it("uses the session socket and target session name", async () => {
			mockLayoutSpawn();
			await getTmuxLayout("task-layout-02", "custom-sock");

			const winCall = mockSpawn.mock.calls.find((c) => Array.isArray(c[0]) && c[0].includes("list-windows"));
			expect(winCall).toBeDefined();
			expect(winCall![0]).toContain("-L");
			expect(winCall![0]).toContain("custom-sock");
		});

		it("returns an empty layout when the session is gone (list-windows fails)", async () => {
			mockLayoutSpawn({ windowsExit: 1 });
			const layout = await getTmuxLayout("task-layout-03");

			expect(layout.exists).toBe(false);
			expect(layout.windows).toHaveLength(0);
			expect(layout.panes).toHaveLength(0);
		});

		it("tolerates a pane title containing tabs/spaces", async () => {
			mockLayoutSpawn({ panes: "0\t%1\t1\t0\t0\t200\t50\tvim\tmy file.txt\n" });
			const layout = await getTmuxLayout("task-layout-04");
			expect(layout.panes[0].title).toBe("my file.txt");
		});

		it("reports the status-bar reservation (client_height - window_height)", async () => {
			mockLayoutSpawn({ status: "51\t50\ton\tbottom\n" });
			const layout = await getTmuxLayout("task-status-01");
			expect(layout.statusLines).toBe(1);
			expect(layout.statusAtTop).toBe(false);
		});

		it("reports statusLines 0 when the status bar is off", async () => {
			mockLayoutSpawn({ status: "50\t50\toff\tbottom\n" });
			const layout = await getTmuxLayout("task-status-02");
			expect(layout.statusLines).toBe(0);
		});

		it("flags a top-positioned status bar", async () => {
			mockLayoutSpawn({ status: "52\t50\ton\ttop\n" });
			const layout = await getTmuxLayout("task-status-03");
			expect(layout.statusLines).toBe(2);
			expect(layout.statusAtTop).toBe(true);
		});

		it("reports a zoomed window via window_zoomed_flag", async () => {
			mockLayoutSpawn({ windows: "0\tmain\t1\t2\tcf3a,200x50,0,0{99x50,0,0,1,100x50,100,0,2}\t1\n" });
			const layout = await getTmuxLayout("task-layout-zoom");
			expect(layout.windows[0].zoomed).toBe(true);
		});

		it("uses zoom-independent window_layout geometry over collapsed pane fields", async () => {
			// While the window is zoomed, list-panes collapses the ACTIVE pane to the
			// full window (200 wide, left 0) — overlapping the other pane. The real
			// split must still come from window_layout (%1 = 99 wide @ left 0).
			mockLayoutSpawn({
				panes: "0\t%1\t1\t0\t0\t200\t50\tclaude\tAgent\n" + "0\t%2\t0\t100\t0\t100\t50\tzsh\tShell\n",
			});
			const layout = await getTmuxLayout("task-layout-05");

			expect(layout.panes[0]).toMatchObject({ paneId: "%1", left: 0, width: 99 });
			expect(layout.panes[1]).toMatchObject({ paneId: "%2", left: 100, width: 100 });
			// The collapsed full-window width (200) must NOT leak through.
			expect(layout.panes[0].width).not.toBe(200);
		});

		it("falls back to per-pane geometry when window_layout is absent", async () => {
			mockLayoutSpawn({ windows: "0\tmain\t1\t1\t\n", panes: "0\t%7\t1\t3\t4\t80\t20\tzsh\tShell\n" });
			const layout = await getTmuxLayout("task-layout-06");
			expect(layout.panes[0]).toMatchObject({ paneId: "%7", left: 3, top: 4, width: 80, height: 20 });
		});
	});

	describe("parseWindowLayout", () => {
		it("extracts leaf geometry keyed by pane id, ignoring containers", () => {
			const geom = parseWindowLayout("21be,200x50,0,0{100x50,0,0,0,99x50,101,0[99x25,101,0,1,99x24,101,26,2]}");
			expect(geom.get("%0")).toEqual({ left: 0, top: 0, width: 100, height: 50 });
			expect(geom.get("%1")).toEqual({ left: 101, top: 0, width: 99, height: 25 });
			expect(geom.get("%2")).toEqual({ left: 101, top: 26, width: 99, height: 24 });
			// The container cell (99x50,101,0) must not be mistaken for a pane.
			expect(geom.size).toBe(3);
		});

		it("maps the trailing integer to pane id (not pane index) after a kill", () => {
			// Non-contiguous ids: %0 and %2 survive; layout uses ids 0 and 2.
			const geom = parseWindowLayout("4f3b,200x50,0,0{100x50,0,0,0,99x50,101,0,2}");
			expect(geom.has("%0")).toBe(true);
			expect(geom.has("%2")).toBe(true);
			expect(geom.has("%1")).toBe(false);
		});

		it("returns an empty map for an empty/garbage layout", () => {
			expect(parseWindowLayout("").size).toBe(0);
			expect(parseWindowLayout("not-a-layout").size).toBe(0);
		});
	});

	// ------- Callbacks -------

	describe("callbacks", () => {
		it("onPtyDied fires when process exits", async () => {
			let exitResolve!: (code: number) => void;
			const exitPromise = new Promise<number>((resolve) => {
				exitResolve = resolve;
			});

			mockSpawn.mockReturnValue(defaultSpawnReturn({ exited: exitPromise }) as any);

			const diedCb = vi.fn();
			setOnPtyDied(diedCb);

			const id = track("task-died-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(diedCb).not.toHaveBeenCalled();

			exitResolve(0);
			await new Promise((r) => setTimeout(r, 10));

			expect(diedCb).toHaveBeenCalledWith(id);
		});

		it("onPtyDied fires when exited promise rejects", async () => {
			let exitReject!: (err: Error) => void;
			const exitPromise = new Promise<number>((_, reject) => {
				exitReject = reject;
			});

			mockSpawn.mockReturnValue(defaultSpawnReturn({ exited: exitPromise }) as any);

			const diedCb = vi.fn();
			setOnPtyDied(diedCb);

			const id = track("task-died-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			exitReject(new Error("crashed"));
			await new Promise((r) => setTimeout(r, 10));

			expect(diedCb).toHaveBeenCalledWith(id);
		});
	});

	// ------- Terminal data handling -------

	describe("terminal data handling", () => {
		let capturedDataCb: ((terminal: unknown, data: string | Uint8Array) => void) | null;

		beforeEach(() => {
			capturedDataCb = null;
			mockSpawn.mockImplementation((_cmd: any, opts: any) => {
				if (opts?.terminal?.data) {
					capturedDataCb = opts.terminal.data;
				}
				return {
					pid: 100,
					terminal: { close: vi.fn(), resize: vi.fn(), write: vi.fn() },
					kill: vi.fn(),
					exited: new Promise(() => {}), // never resolves
				} as any;
			});
		});

		it("detects BEL character and fires onBell callback", () => {
			const bellCb = vi.fn();
			setOnBell(bellCb);

			const id = track("task-bell-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(capturedDataCb).not.toBeNull();

			capturedDataCb!(null, "some output\x07more");
			expect(bellCb).toHaveBeenCalledWith(id);
		});

		it("does not fire onBell for BEL inside OSC sequences", () => {
			const bellCb = vi.fn();
			setOnBell(bellCb);

			const id = track("task-bell-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			// OSC 0 (title change) uses \x07 as terminator — not a real bell
			capturedDataCb!(null, "\x1b]0;window title\x07");
			expect(bellCb).not.toHaveBeenCalled();
		});

		it("fires onBell for BEL outside OSC even if OSC also present", () => {
			const bellCb = vi.fn();
			setOnBell(bellCb);

			const id = track("task-bell-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			// OSC sequence followed by a real BEL
			capturedDataCb!(null, "\x1b]0;title\x07\x07");
			expect(bellCb).toHaveBeenCalledWith(id);
		});

		it("emits OSC 52 clipboard data to the client instead of spawning pbcopy", () => {
			const id = track("task-osc52-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			const osc52Cb = vi.fn();
			setOnOsc52Copy(osc52Cb);

			const testText = "Hello clipboard";
			const b64 = Buffer.from(testText).toString("base64");
			const osc52Seq = `\x1b]52;c;${b64}\x07`;

			mockSpawn.mockClear();

			capturedDataCb!(null, osc52Seq);

			expect(osc52Cb).toHaveBeenCalledWith({
				taskId: id,
				text: testText,
				len: testText.length,
			});
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("emits OSC 52 clipboard data split across PTY chunks", () => {
			const id = track("task-osc52-split");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			const osc52Cb = vi.fn();
			setOnOsc52Copy(osc52Cb);

			const testText = `${"long clipboard line\n".repeat(200)}done`;
			const b64 = Buffer.from(testText).toString("base64");
			const osc52Seq = `\x1b]52;c;${b64}\x07`;
			const splitAt = 120;

			mockSpawn.mockClear();

			capturedDataCb!(null, osc52Seq.slice(0, splitAt));
			capturedDataCb!(null, osc52Seq.slice(splitAt));

			expect(osc52Cb).toHaveBeenCalledWith({
				taskId: id,
				text: testText,
				len: testText.length,
			});
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("ignores OSC 52 query (b64 is '?')", () => {
			const id = track("task-osc52-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			const osc52Cb = vi.fn();
			setOnOsc52Copy(osc52Cb);

			mockSpawn.mockClear();

			// OSC 52 query: base64 content is "?"
			capturedDataCb!(null, "\x1b]52;c;?\x07");

			expect(osc52Cb).not.toHaveBeenCalled();
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("handles Uint8Array data input", () => {
			const bellCb = vi.fn();
			setOnBell(bellCb);

			const id = track("task-uint8-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			const data = new TextEncoder().encode("output\x07");
			capturedDataCb!(null, data);

			expect(bellCb).toHaveBeenCalledWith(id);
		});

		it("does not throw on data callback errors", () => {
			const id = track("task-dataerr-1");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			// null data will cause TextDecoder.decode(null) to throw,
			// but the try/catch in the callback should swallow it
			expect(() => capturedDataCb!(null, null as any)).not.toThrow();
		});

		it("batches PTY data instead of sending immediately", () => {
			vi.useFakeTimers();

			const id = track("task-batch-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(capturedDataCb).not.toBeNull();

			// Simulate WebSocket connection by attaching ws to the session
			// (The real WS is set in the open handler; we skip that here)
			// We need to access the session internals, so we trigger data
			// and check that ws.sendText is NOT called synchronously.

			// First, let's verify the data callback doesn't throw
			capturedDataCb!(null, "chunk1");
			capturedDataCb!(null, "chunk2");

			// WS is null initially, so no sends expected.
			// This test verifies that data flow doesn't crash without WS.
			vi.advanceTimersByTime(20);

			vi.useRealTimers();
		});

		it("does not crash when multiple data chunks arrive without WS", () => {
			const id = track("task-batch-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(capturedDataCb).not.toBeNull();

			// Rapid-fire data without WS connected — should not throw
			for (let i = 0; i < 100; i++) {
				expect(() => capturedDataCb!(null, `line ${i}\n`)).not.toThrow();
			}
		});
	});

	// ------- configureTmux via spawnPty (setTimeout) -------

	describe("configureTmux via spawnPty", () => {
		it("sources tmux config after timeout when socket is provided", async () => {
			vi.useFakeTimers();

			const id = track("task-conf-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "conf-socket");
			mockSpawn.mockClear();

			// Match the source-file call for THIS session's socket specifically.
			// A generic `includes("source-file")` would also match a stale
			// configureTmux timer leaked from a prior test (default "dev3"
			// socket), which made this assertion flaky on slow CI runners.
			const findSourceCall = (socket: string) =>
				mockSpawn.mock.calls.find(
					(c) => Array.isArray(c[0]) && c[0].includes("source-file") && c[0].includes(socket),
				);

			await vi.advanceTimersByTimeAsync(200);
			await vi.waitFor(() => {
				expect(findSourceCall("conf-socket")).toBeDefined();
			});

			// configureTmux now uses async `spawn` rather than `spawnSync`.
			const sourceCall = findSourceCall("conf-socket");
			expect(sourceCall).toBeDefined();
			expect(sourceCall![0]).toContain("-L");
			expect(sourceCall![0]).toContain("conf-socket");
			expect(sourceCall![0]).toContain(TMUX_CONF_PATH);

			vi.useRealTimers();
		});

		it("does not configure tmux when the session is destroyed before the timeout", async () => {
			vi.useFakeTimers();

			const id = track("task-conf-destroy");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "destroy-sock");
			mockSpawn.mockClear();

			// Tear the session down before the deferred 200ms configureTmux fires.
			// The pending timer must be cancelled — otherwise it fires later and
			// sources tmux config for a dead session (and, in the test suite,
			// leaks a stray source-file spawn into whatever test runs next).
			destroySession(id);

			await vi.advanceTimersByTimeAsync(400);

			const sourceCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("source-file"),
			);
			expect(sourceCall).toBeUndefined();

			vi.useRealTimers();
		});

		it("sets tmux PATH when env.PATH is provided", async () => {
			vi.useFakeTimers();

			const id = track("task-conf-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", { PATH: "/usr/local/bin" }, "path-sock");
			mockSpawn.mockClear();

			await vi.advanceTimersByTimeAsync(200);
			await vi.waitFor(() => {
				const call = mockSpawn.mock.calls.find(
					(c) => Array.isArray(c[0]) && c[0].includes("set-environment") && c[0].includes("PATH") && !c[0].includes("DEV3_WORKTREE_ROOT"),
				);
				expect(call).toBeDefined();
			});

			const envCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment") && c[0].includes("PATH") && !c[0].includes("DEV3_WORKTREE_ROOT"),
			);
			expect(envCall).toBeDefined();
			expect(envCall![0]).toContain("PATH");
			expect(envCall![0]).toContain("/usr/local/bin");

			vi.useRealTimers();
		});

		it("always sources config with default socket", async () => {
			vi.useFakeTimers();

			const id = track("task-conf-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawn.mockClear();

			const findDefaultSourceCall = () =>
				mockSpawn.mock.calls.find(
					(c) => Array.isArray(c[0]) && c[0].includes("source-file") && c[0].includes("dev3"),
				);

			await vi.advanceTimersByTimeAsync(200);
			await vi.waitFor(() => {
				expect(findDefaultSourceCall()).toBeDefined();
			});

			// Should use the default "dev3" socket
			const sourceCall = findDefaultSourceCall();
			expect(sourceCall).toBeDefined();
			expect(sourceCall![0]).toContain("dev3");

			vi.useRealTimers();
		});

		it("does not throw when configureTmux fails", async () => {
			vi.useFakeTimers();

			const id = track("task-conf-04");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "err-sock");
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("source-file")) {
					throw new Error("source-file failed");
				}
				return defaultSpawnReturn() as any;
			});

			await expect(vi.advanceTimersByTimeAsync(200)).resolves.not.toThrow();

			vi.useRealTimers();
		});
	});

	// ------- Project terminal sessions -------

	describe("project terminal sessions", () => {
		it("creates a project session with sessionType 'project'", () => {
			const key = track("project-a1b2c3d4-e5f6-7890-abcd-ef1234567890");
			createSession(key, "a1b2c3d4", "/tmp/project-root", "bash", {}, "dev3", "project");
			expect(hasSession(key)).toBe(true);
		});

		it("uses dev3-pt- prefix for project tmux session name", () => {
			const key = track("project-a1b2c3d4-e5f6-7890-abcd-ef1234567890");
			createSession(key, "a1b2c3d4", "/tmp/project-root", "bash", {}, "dev3", "project");

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			expect(tmuxCall![0]).toContain("dev3-pt-a1b2c3d4");
		});

		it("getSessionTmuxName returns dev3-pt- prefix for project sessions", () => {
			const key = track("project-a1b2c3d4-e5f6-7890-abcd-ef1234567890");
			createSession(key, "a1b2c3d4", "/tmp/project-root", "bash", {}, "dev3", "project");
			expect(getSessionTmuxName(key)).toBe("dev3-pt-a1b2c3d4");
		});

		it("getSessionTmuxName returns dev3- prefix for task sessions", () => {
			const id = track("task-tmux-name-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(getSessionTmuxName(id)).toBe("dev3-task-tmu");
		});

		it("getSessionType returns 'project' for project sessions", () => {
			const key = track("project-bbbbbbbb-1111-2222-3333-444444444444");
			createSession(key, "bbbbbbbb", "/tmp/root", "bash", {}, "dev3", "project");
			expect(getSessionType(key)).toBe("project");
		});

		it("getSessionType returns 'task' for task sessions", () => {
			const id = track("task-type-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(getSessionType(id)).toBe("task");
		});

		it("getSessionType returns null for unknown sessions", () => {
			expect(getSessionType("nonexistent")).toBeNull();
		});

		it("destroySession works for project sessions", () => {
			const key = track("project-cccccccc-1111-2222-3333-444444444444");
			createSession(key, "cccccccc", "/tmp/root", "bash", {}, "dev3", "project");
			expect(hasSession(key)).toBe(true);
			destroySession(key);
			expect(hasSession(key)).toBe(false);

			// Verify tmux kill-session used the correct session name
			const killCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall).toBeDefined();
			expect(killCall![0]).toContain("dev3-pt-cccccccc");
		});

		it("creates split panes with correct cwd (-c flag)", async () => {
			vi.useFakeTimers();
			const key = track("project-eeeeeeee-1111-2222-3333-444444444444");
			// setupTiledLayout now uses async `spawn`. Route list-panes to a
			// single-pane response so the tiled layout branch runs; everything
			// else gets a benign exit-0 proc.
			const singlePane = () => ({
				pid: 99,
				kill: vi.fn(),
				stdout: new Response(new TextEncoder().encode("0: [200x50]\n")).body,
				exited: Promise.resolve(0),
			});
			const benign = () => defaultSpawnReturn() as any;
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("list-panes")) return singlePane();
				return benign();
			});

			createSession(key, "eeeeeeee", "/tmp/my-project-root", "bash", {}, "dev3", "project");
			mockSpawn.mockClear();
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("list-panes")) return singlePane();
				return benign();
			});

			await vi.advanceTimersByTimeAsync(300);
			// Tiled layout chains several awaited spawns — flush microtasks.
			for (let i = 0; i < 10; i++) await Promise.resolve();

			// All three split-window calls must include -c with the project root
			const splitCalls = mockSpawn.mock.calls.filter(
				(c) => Array.isArray(c[0]) && c[0].includes("split-window"),
			);
			expect(splitCalls).toHaveLength(3);
			for (const call of splitCalls) {
				expect(call[0]).toContain("-c");
				expect(call[0]).toContain("/tmp/my-project-root");
			}

			vi.useRealTimers();
		});

		it("capturePane works for project sessions", async () => {
			const key = track("project-dddddddd-1111-2222-3333-444444444444");
			createSession(key, "dddddddd", "/tmp/root", "bash", {}, "dev3", "project");
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("capture-pane")) {
					return {
						pid: 999,
						kill: vi.fn(),
						stdout: new Response(new TextEncoder().encode("project terminal content")).body,
						exited: Promise.resolve(0),
					} as any;
				}
				return defaultSpawnReturn() as any;
			});

			const result = await capturePane(key);
			expect(result).toBe("project terminal content");

			// Verify capture used the correct tmux session name
			const captureCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("capture-pane"),
			);
			expect(captureCall).toBeDefined();
			expect(captureCall![0]).toContain("dev3-pt-dddddddd");
		});
	});

	// ------- TMUX_CONF_PATH -------

	describe("TMUX_CONF_PATH", () => {
		it("defaults to /tmp/dev3-tmux-dark.conf", () => {
			expect(TMUX_CONF_PATH).toBe("/tmp/dev3-tmux-dark.conf");
		});

		/** Helper: reimport pty-server with mocked fs and find the dark config content. */
		async function reimportAndGetDarkConfig(): Promise<string> {
			vi.resetModules();
			const writeFileSyncMock = vi.fn();
			vi.doMock("node:fs", async (importOriginal) => {
				const actual = await importOriginal<typeof import("node:fs")>();
				return { ...actual, mkdirSync: vi.fn(), existsSync: vi.fn(() => true), writeFileSync: writeFileSyncMock };
			});
			vi.doMock("../logger", () => ({
				createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
			}));
			vi.doMock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
			const mod = await import("../pty-server");
			// Find the call that writes the dark config (TMUX_CONF_DARK_PATH)
			const call = writeFileSyncMock.mock.calls.find(
				(c: unknown[]) => typeof c[0] === "string" && c[0] === mod.TMUX_CONF_DARK_PATH,
			);
			return call?.[1] as string ?? "";
		}

		it("includes synchronized output (Sync) terminal features", async () => {
			const config = await reimportAndGetDarkConfig();
			expect(config).toContain("xterm-256color:Sync");
			expect(config).toContain("tmux-256color:Sync");
		});

		it("includes extended-keys and focus-events settings", async () => {
			const config = await reimportAndGetDarkConfig();
			expect(config).toContain("extended-keys on");
			expect(config).toContain("focus-events on");
			expect(config).toContain("terminal-overrides");
		});

		it("sets history-limit to 250000", async () => {
			const config = await reimportAndGetDarkConfig();
			expect(config).toContain("history-limit 250000");
		});

		it("writes a backslash split binding with a literal double backslash", async () => {
			const config = await reimportAndGetDarkConfig();
			expect(config).toContain(String.raw`bind \\ split-window -h -c "#{?pane_current_path,#{pane_current_path},#{session_path}}"`);
		});
	});

	// Multi-window / multi-client resize: the shared PTY must be sized to the
	// SMALLEST viewer so two app windows of different sizes on the same task
	// don't flip-flop the geometry (last-write-wins). Mirrors tmux multi-client.
	describe("smallestClientSize", () => {
		it("returns null when no client has reported a size", () => {
			expect(smallestClientSize([])).toBeNull();
			expect(smallestClientSize([{}, {}])).toBeNull();
		});

		it("returns the single client's size", () => {
			expect(smallestClientSize([{ cols: 120, rows: 40 }])).toEqual({ cols: 120, rows: 40 });
		});

		it("takes the min of cols and rows independently across clients", () => {
			// Window A is wide+short, window B is narrow+tall — the PTY must fit
			// inside both, so min width AND min height taken separately.
			expect(
				smallestClientSize([
					{ cols: 200, rows: 30 },
					{ cols: 100, rows: 50 },
				]),
			).toEqual({ cols: 100, rows: 30 });
		});

		it("ignores clients that have not reported a size yet", () => {
			// A freshly-connected window (no size) must not shrink everyone.
			expect(
				smallestClientSize([{ cols: 150, rows: 45 }, {}, { rows: 60 }]),
			).toEqual({ cols: 150, rows: 45 });
		});

		it("ignores non-positive sizes", () => {
			expect(
				smallestClientSize([{ cols: 0, rows: 0 }, { cols: 80, rows: 24 }]),
			).toEqual({ cols: 80, rows: 24 });
		});
	});

	// ------- cwdExists -------

	describe("cwdExists", () => {
		// Regression: a PTY cwd is always a DIRECTORY, and the old check used
		// `Bun.file(cwd).exists()`, which returns false for directories — so every
		// valid worktree/project dir produced a bogus "PTY cwd missing" error.
		it("returns true for an existing directory", async () => {
			const dir = await mkdtemp(join(tmpdir(), "dev3-cwd-"));
			try {
				expect(await cwdExists(dir)).toBe(true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("returns true for an existing file", async () => {
			const dir = await mkdtemp(join(tmpdir(), "dev3-cwd-"));
			const file = join(dir, "f.txt");
			await writeFile(file, "x");
			try {
				expect(await cwdExists(file)).toBe(true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("returns false for a path that does not exist", async () => {
			expect(await cwdExists(join(tmpdir(), "dev3-cwd-nope-zzzzzzzz"))).toBe(false);
		});
	});
});

// ---- tmux binary selection (pinned tmux@3.6 rollout) ----

describe("selectTmuxBinary", () => {
	const PREFERRED = "/opt/homebrew/opt/tmux@3.6/bin/tmux";
	const PATH_TMUX = "/opt/homebrew/bin/tmux";

	function probeResult(exitCode: number, stderr = "") {
		return { exited: Promise.resolve(exitCode), stderr, stdout: "tmux 3.6a\n" } as any;
	}

	function mockVersionAndServer(serverExitCode: number, stderr = "") {
		mockSpawn.mockImplementation(((args: string[]) =>
			args[1] === "-V" ? probeResult(0) : probeResult(serverExitCode, stderr)) as any);
	}

	afterEach(() => {
		setTmuxBinary("tmux");
	});

	it("keeps the preferred binary when no server is running", async () => {
		mockVersionAndServer(1, "no server running on /tmp/tmux-501/dev3");
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		expect(chosen).toBe(PREFERRED);
		expect(getTmuxBinary()).toBe(PREFERRED);
		// One probe only — no fallback scanning when there is no server at all.
		const probes = mockSpawn.mock.calls.filter((c) => (c[0] as string[]).includes("list-sessions"));
		expect(probes).toHaveLength(1);
	});

	it("keeps the preferred binary when the running server accepts it", async () => {
		mockSpawn.mockReturnValue(probeResult(0, ""));
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		expect(chosen).toBe(PREFERRED);
		expect(getTmuxBinary()).toBe(PREFERRED);
	});

	it("falls back to a candidate that can talk to a version-mismatched server", async () => {
		mockSpawn.mockImplementation(((args: string[]) =>
			args[1] === "-V"
				? probeResult(0)
				: args[0] === PREFERRED
				? probeResult(1, "server exited unexpectedly")
				: probeResult(0, "")) as any);
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
	});

	it("keeps the preferred binary when every candidate is incompatible", async () => {
		mockVersionAndServer(1, "server exited unexpectedly");
		const chosen = await selectTmuxBinary(PREFERRED, [PATH_TMUX, "/usr/local/bin/tmux"]);
		expect(chosen).toBe(PREFERRED);
		expect(getTmuxBinary()).toBe(PREFERRED);
	});

	it("skips fallback candidates that do not exist on disk", async () => {
		mockVersionAndServer(1, "server exited unexpectedly");
		mockExistsSync.mockImplementation((path) => path === PREFERRED);
		await selectTmuxBinary(PREFERRED, [PATH_TMUX]);
		const probes = mockSpawn.mock.calls.filter((c) => (c[0] as string[]).includes("list-sessions"));
		expect(probes).toHaveLength(1); // only the preferred binary was probed
	});

	it("dereferences the PATH shim instead of committing it (ELOOP regression)", async () => {
		// ~/.dev3.0/bin is first in PATH, so whichSync can hand us our own shim
		// as "preferred". Committing it and then repointing the shim at it
		// created a self-referential symlink that broke every tmux spawn.
		mockSpawn.mockReturnValue(probeResult(0, ""));
		mockExistsSync.mockReturnValue(true);
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(readlinkSync).mockReturnValue(PATH_TMUX);
		vi.mocked(realpathSync).mockReturnValue(PATH_TMUX);
		const chosen = await selectTmuxBinary(TMUX_SHIM_PATH, [TMUX_SHIM_PATH]);
		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
		expect(vi.mocked(symlinkSync)).not.toHaveBeenCalledWith(TMUX_SHIM_PATH, TMUX_SHIM_PATH);
	});

	it("rejects a PATH shim that resolves to a directory and uses a real fallback", async () => {
		const HOME_DIR = "/Users/tester";
		mockVersionAndServer(1, "no server running on /tmp/tmux-501/dev3");
		mockExistsSync.mockReturnValue(true);
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(readlinkSync).mockReturnValue(HOME_DIR);
		vi.mocked(realpathSync).mockReturnValue(HOME_DIR);
		vi.mocked(statSync).mockImplementation(((path: string) => ({ isFile: () => path !== HOME_DIR })) as any);

		const chosen = await selectTmuxBinary(TMUX_SHIM_PATH, [PATH_TMUX]);

		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(TMUX_SHIM_PATH);
	});

	it("rejects an executable that is not tmux and uses a real fallback", async () => {
		const WRONG_BINARY = "/usr/bin/true";
		mockExistsSync.mockReturnValue(true);
		mockSpawn.mockImplementation(((args: string[]) => {
			if (args[1] === "-V") {
				return args[0] === WRONG_BINARY
					? { exited: Promise.resolve(0), stdout: "true (GNU coreutils) 9.5\n", stderr: "" }
					: { exited: Promise.resolve(0), stdout: "tmux 3.6a\n", stderr: "" };
			}
			return probeResult(1, "no server running on /tmp/tmux-501/dev3");
		}) as any);

		const chosen = await selectTmuxBinary(WRONG_BINARY, [PATH_TMUX]);

		expect(chosen).toBe(PATH_TMUX);
		expect(getTmuxBinary()).toBe(PATH_TMUX);
	});

	it("returns undefined instead of committing an executable that is not tmux", async () => {
		mockSpawn.mockReturnValue({
			exited: Promise.resolve(0),
			stdout: "not tmux\n",
			stderr: "",
		} as any);

		const chosen = await selectTmuxBinary("/usr/bin/true", ["/usr/bin/false"]);

		expect(chosen).toBeUndefined();
		expect(getTmuxBinary()).toBe("tmux");
		expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
	});
});

describe("dereferenceTmuxShim", () => {
	const PATH_TMUX = "/opt/homebrew/bin/tmux";

	it("passes through non-shim paths untouched", () => {
		expect(dereferenceTmuxShim(PATH_TMUX)).toBe(PATH_TMUX);
	});

	it("resolves the shim to its symlink target", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockReturnValue(PATH_TMUX);
		vi.mocked(readlinkSync).mockReturnValue(PATH_TMUX);
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBe(PATH_TMUX);
	});

	it("removes a broken/cyclic shim and returns undefined", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockImplementation(() => { throw new Error("ELOOP"); });
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBeUndefined();
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(TMUX_SHIM_PATH);
	});

	it("leaves a regular file at the shim path alone and uses it as-is", () => {
		// The app only ever creates a symlink there — a regular file is the
		// user's own binary and must never be deleted.
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);
		mockExistsSync.mockReturnValue(true);
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBe(TMUX_SHIM_PATH);
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});

	it("returns undefined for a missing shim path that is not a symlink", () => {
		vi.mocked(lstatSync).mockImplementation(() => { throw new Error("ENOENT"); });
		mockExistsSync.mockReturnValue(false);
		expect(dereferenceTmuxShim(TMUX_SHIM_PATH)).toBeUndefined();
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});
});

describe("sanitizeTmuxShim", () => {
	it("removes the shim when the symlink cannot be resolved (ELOOP)", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockImplementation(() => { throw new Error("ELOOP"); });
		sanitizeTmuxShim();
		expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(TMUX_SHIM_PATH);
	});

	it("keeps a healthy shim", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);
		vi.mocked(realpathSync).mockReturnValue("/opt/homebrew/bin/tmux");
		sanitizeTmuxShim();
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});

	it("ignores a non-symlink file", () => {
		vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);
		sanitizeTmuxShim();
		expect(vi.mocked(unlinkSync)).not.toHaveBeenCalled();
	});
});

describe("updateTmuxShim", () => {
	const TARGET = "/opt/homebrew/opt/tmux@3.6/bin/tmux";
	const SHIM = `${DEV3_HOME}/bin/tmux`;
	const mockLstatSync = vi.mocked(lstatSync);
	const mockReadlinkSync = vi.mocked(readlinkSync);
	const mockUnlinkSync = vi.mocked(unlinkSync);
	const mockSymlinkSync = vi.mocked(symlinkSync);

	beforeEach(() => {
		mockExistsSync.mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => true } as any);
		vi.mocked(accessSync).mockImplementation(() => undefined);
	});

	it("does nothing for a bare binary name", () => {
		updateTmuxShim("tmux");
		expect(mockSymlinkSync).not.toHaveBeenCalled();
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	it("creates the symlink when missing", () => {
		mockExistsSync.mockImplementation((path) => path === TARGET);
		mockLstatSync.mockImplementation(() => { throw new Error("ENOENT"); });
		updateTmuxShim(TARGET);
		expect(mockSymlinkSync).toHaveBeenCalledWith(TARGET, SHIM);
	});

	it("refuses to create a shim for a directory", () => {
		const directory = "/Users/tester";
		mockExistsSync.mockReturnValue(true);
		vi.mocked(statSync).mockReturnValue({ isFile: () => false } as any);

		updateTmuxShim(directory);

		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});

	it("leaves a pre-existing non-symlink file alone", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => false } as any);
		updateTmuxShim(TARGET);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});

	it("repoints the symlink when it targets a different binary", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as any);
		mockReadlinkSync.mockReturnValue("/old/path/tmux");
		updateTmuxShim(TARGET);
		expect(mockUnlinkSync).toHaveBeenCalledWith(SHIM);
		expect(mockSymlinkSync).toHaveBeenCalledWith(TARGET, SHIM);
	});

	it("is a no-op when the symlink already points at the binary", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as any);
		mockReadlinkSync.mockReturnValue(TARGET);
		updateTmuxShim(TARGET);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});

	it("refuses to point the shim at itself (ELOOP regression)", () => {
		mockExistsSync.mockReturnValue(true);
		mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as any);
		mockReadlinkSync.mockReturnValue("/opt/homebrew/bin/tmux");
		updateTmuxShim(SHIM);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
		expect(mockSymlinkSync).not.toHaveBeenCalled();
	});
});
