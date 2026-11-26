import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks (hoisted before imports) ----

// One shared logger object, so a test can read the ORDER of what was logged. Fresh vi.fn()s
// per call would be unreachable from here.
const { mockLog } = vi.hoisted(() => ({
	mockLog: { lines: [] as string[] },
}));
vi.mock("../logger", () => {
	const record = (level: string) => (message: string) => void mockLog.lines.push(`${level}:${message}`);
	return {
		createLogger: () => ({
			debug: vi.fn(record("debug")),
			info: vi.fn(record("info")),
			warn: vi.fn(record("warn")),
			error: vi.fn(record("error")),
		}),
	};
});

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

import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "../spawn";
import { DEV3_HOME } from "../paths";
import { ENV_UNSET } from "../../shared/agent-accounts";
import { _resetUserShellCacheForTests } from "../shell-env";
import { TmuxMissingCwdError, TmuxSpawnError, tmuxConfigPath } from "../tmux";
import {
	cwdExists,
	createSession,
	destroySession,
	hasSession,
	hasDeadSession,
	capturePane,
	listPaneIds,
	installPaneExitedHooks,
	getTmuxLayout,
	getSessionProjectId,
	getSessionSocket,
	getSessionTmuxName,
	getSessionType,
	setOnPtyDied,
	setOnBell,
	setOnOsc52Copy,
	_resetTmuxBinaryLoggedForTests,
	noteHumanTerminalInput,
	applyTmuxTheme,
	syncTmuxTaskTitle,
	tmuxTaskTitleValue,
} from "../pty-server";
import { readFileSync } from "node:fs";
import {
	agentMessageHoldKey,
	holdAgentMessage,
	pendingAgentMessageHoldCount,
	resetAgentMessageHolds,
	type HeldDeliveryResult,
} from "../agent-message-hold";
import {
	AGENT_MESSAGE_HOLD_CEILING_MS,
	AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS,
	AGENT_MESSAGE_HOLD_IDLE_MS,
} from "../../shared/agent-message-hold-timing";

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
	// ------- createSession -------

	describe("createSession", () => {
		it("registers the session and spawns tmux new-session on the given socket", async () => {
			const id = track("task-spawn-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {}, "my-socket");
			expect(hasSession(id)).toBe(true);
			expect(hasSession("nonexistent")).toBe(false);

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
			expect(tmuxCall![0]).toEqual(expect.arrayContaining(["-L", "my-socket", "-f", tmuxConfigPath("dark", true)]));
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

		it("keeps session env out of the tmux client process — it would become the server's global env", () => {
			const id = track("task-env-proc-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", { DEV3_TASK_ID: id, DEV3_TASK_SEQ: "14-1" });

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			const processEnv = (tmuxCall![1] as { env?: Record<string, string> }).env ?? {};
			expect(processEnv.DEV3_TASK_ID).toBeUndefined();
			expect(processEnv.DEV3_TASK_SEQ).toBeUndefined();
			expect(tmuxCall![0]).toContain("DEV3_TASK_SEQ=14-1");
		});

		it("drops ENV_UNSET keys from the first pane with env -u and from later panes with set-environment -r", async () => {
			vi.useFakeTimers();
			const id = track("project-unset-01");
			createSession(id, "proj-1", "/tmp/cwd", "/bin/zsh", { DEV3_TASK_SEQ: ENV_UNSET, DEV3_PROJECT_NAME: "base44" }, "my-socket", "project");

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			const args = tmuxCall![0] as string[];
			expect(args[args.length - 1]).toBe("env -u DEV3_TASK_SEQ /bin/zsh");
			expect(args).toContain("DEV3_PROJECT_NAME=base44");
			expect(args.some((a) => a.startsWith("DEV3_TASK_SEQ="))).toBe(false);
			mockSpawn.mockClear();

			await vi.advanceTimersByTimeAsync(300);
			const removals = mockSpawn.mock.calls
				.map((c) => c[0])
				.filter((cmd) => Array.isArray(cmd) && cmd.includes("set-environment") && cmd.includes("-r"));
			expect(removals).toContainEqual(expect.arrayContaining(["set-environment", "-r", "DEV3_TASK_SEQ"]));
			vi.useRealTimers();
		});

		it("uses the user shell when tmuxCommand is empty", () => {
			process.env.SHELL = "/bin/zsh";
			// The shell is resolved once and cached for an hour — including at the
			// import that wrote the tmux config, long before this line.
			_resetUserShellCacheForTests();
			const id = track("task-defcmd-01");
			createSession(id, "proj-1", "/tmp/cwd", "", {});

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			// last arg should be the resolved user shell
			expect(tmuxCall![0][tmuxCall![0].length - 1]).toBe("/bin/zsh");
		});

		it("refuses to start a session in a cwd that does not exist — tmux would open it in $HOME", () => {
			// tmux `new-session -c <missing dir>` exits 0 and starts the pane in the
			// user's home directory; it never fails the fork. The tmux client refuses
			// instead (TmuxMissingCwdError), so no session is retained.
			mockExistsSync.mockReturnValue(false);
			const id = track("task-nocwd-01");
			expect(() => createSession(id, "proj-1", "/tmp/nonexistent", "bash", {})).toThrow(TmuxMissingCwdError);
			expect(hasSession(id)).toBe(false);
			expect(mockSpawn.mock.calls.some(([cmd]) => Array.isArray(cmd) && cmd.includes("new-session"))).toBe(false);
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

		it("clears a session's status override on attach; a task hands its window bar to the navigator, a project terminal keeps it", async () => {
			vi.useFakeTimers();
			const id = track("task-window-nav");
			const projectId = track("project-window-nav");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "my-socket");
			createSession(projectId, "proj-1", "/tmp/cwd", "bash", {}, "my-socket", "project");
			mockSpawn.mockClear();

			await vi.advanceTimersByTimeAsync(300);
			await Promise.resolve();
			await Promise.resolve();

			const sets = mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((a) => Array.isArray(a) && a.includes("set-option"));
			const task = `=${getSessionTmuxName(id)}:`;
			expect(sets).toContainEqual(expect.arrayContaining(["set-option", "-t", task, "status", "off"]));
			const project = `=${getSessionTmuxName(projectId)}:`;
			expect(sets.some((a) => a.includes(project) && a.includes("off"))).toBe(false);
			// The session's own status override is cleared so the window bar shows.
			expect(sets).toContainEqual(
				expect.arrayContaining(["-L", "my-socket", "set-option", "-u", "-t", expect.stringMatching(/^=dev3-.*:$/), "status"]),
			);

			vi.useRealTimers();
		});

		it("with empty env sets only DEV3_WORKTREE_ROOT via tmux set-environment", async () => {
			vi.useFakeTimers();
			const id = track("task-env-empty");
			createSession(id, "proj-1", "/tmp/my-worktree", "bash", {}, "my-socket");
			mockSpawn.mockClear();

			await vi.advanceTimersByTimeAsync(300);
			await Promise.resolve();
			await Promise.resolve();

			// DEV3_WORKTREE_ROOT is always set, but no user env vars should be set
			const setEnvCalls = mockSpawn.mock.calls.filter(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment") && !c[0].includes("DEV3_WORKTREE_ROOT"),
			);
			expect(setEnvCalls).toHaveLength(0);
			const rootCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment") && c[0].includes("DEV3_WORKTREE_ROOT"),
			);
			expect(rootCall![0]).toContain("/tmp/my-worktree");

			vi.useRealTimers();
		});
	});

	// ------- destroySession -------

	describe("destroySession", () => {
		it("removes the session, kills its proc/terminal and the tmux session", () => {
			const mockProc = defaultSpawnReturn();
			mockSpawn.mockReturnValue(mockProc as any);
			const id = track("task-dstr-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(hasSession(id)).toBe(true);
			mockSpawn.mockClear();

			destroySession(id);
			activeSessions.splice(activeSessions.indexOf(id), 1);
			expect(hasSession(id)).toBe(false);
			expect(mockProc.kill).toHaveBeenCalled();
			expect(mockProc.terminal.close).toHaveBeenCalled();
			const killCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall![0]).toContain("dev3-task-dst");
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

			// No session and no fallback → still the default "dev3" socket.
			mockSpawn.mockClear();
			expect(() => destroySession("orphan-task-id-5678")).not.toThrow();
			const orphanKill = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(orphanKill![0][2]).toBe("dev3");
		});
	});

	// ------- hasSession -------

	// ------- hasDeadSession -------

	describe("hasDeadSession", () => {
		it("is false for unknown/live sessions, true (and onPtyDied fires) after the proc exits", async () => {
			expect(hasDeadSession("nonexistent")).toBe(false);
			let exitResolve!: (code: number) => void;
			const exitPromise = new Promise<number>((resolve) => {
				exitResolve = resolve;
			});
			mockSpawn.mockReturnValue(defaultSpawnReturn({ exited: exitPromise }) as any);

			const diedCb = vi.fn();
			setOnPtyDied(diedCb);
			const id = track("task-dead-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			expect(hasDeadSession(id)).toBe(false);
			expect(diedCb).not.toHaveBeenCalled();

			exitResolve(0);
			await new Promise((r) => setTimeout(r, 10));

			expect(hasSession(id)).toBe(true); // still in map
			expect(hasDeadSession(id)).toBe(true); // but proc is gone
			expect(diedCb).toHaveBeenCalledWith(id);
		});
	});

		// ------- getSessionProjectId -------

	describe("getSessionProjectId / getSessionSocket", () => {
		it("returns the project id and socket, with null / the default socket for unknown sessions", () => {
			const id = track("task-gsck-01");
			createSession(id, "my-project-42", "/tmp/cwd", "bash", {}, "my-socket");
			expect(getSessionProjectId(id)).toBe("my-project-42");
			expect(getSessionProjectId("nonexistent")).toBeNull();
			expect(getSessionSocket(id)).toBe("my-socket");
			const plain = track("task-gsck-02");
			createSession(plain, "proj-1", "/tmp/cwd", "bash", {});
			expect(getSessionSocket(plain)).toBe("dev3");
			expect(getSessionSocket("nonexistent")).toBe("dev3");
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
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "cap-sock");

			const content = "Hello, world!\n";
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc(content, 0)
					: (defaultSpawnReturn() as any),
			);

			expect(await capturePane(id)).toBe(content);
			const captureCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("capture-pane"),
			);
			expect(captureCall![0]).toEqual(expect.arrayContaining(["-L", "cap-sock"]));
		});

		it("returns null on non-zero exit, empty stdout, spawn error, or a missing session", async () => {
			const id = track("task-cap-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc("error", 1)
					: (defaultSpawnReturn() as any),
			);

			expect(await capturePane(id)).toBeNull();

			mockSpawn.mockImplementation((cmd: any) =>
				Array.isArray(cmd) && cmd.includes("capture-pane")
					? makeCaptureProc(new Uint8Array(0), 0)
					: (defaultSpawnReturn() as any),
			);
			expect(await capturePane(id)).toBeNull();
			expect(await capturePane("no-such-session")).toBeNull();

			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("capture-pane")) throw new Error("tmux error");
				return defaultSpawnReturn() as any;
			});
			expect(await capturePane(id)).toBeNull();
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
		// the middle, with a 1-col divider at column 99). Fields follow
		// WINDOW_OVERVIEW_FORMAT: index, active, panes, zoomed, layout, name —
		// window_layout is the zoom-independent geometry source, the free-text
		// window name rides last (tail field).
		const WINDOWS = "0\t1\t2\t0\tcf3a,200x50,0,0{99x50,0,0,1,100x50,100,0,2}\tmain\n";
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
			const layout = await getTmuxLayout("task-layout-01", "custom-sock");
			const winCall = mockSpawn.mock.calls.find((c) => Array.isArray(c[0]) && c[0].includes("list-windows"));
			expect(winCall![0]).toEqual(expect.arrayContaining(["-L", "custom-sock"]));

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

			// A pane title containing tabs/spaces survives intact.
			mockLayoutSpawn({ panes: "0\t%1\t1\t0\t0\t200\t50\tvim\tmy file.txt\n" });
			expect((await getTmuxLayout("task-layout-04")).panes[0].title).toBe("my file.txt");
		});

		it("returns an empty layout when the session is gone (list-windows fails)", async () => {
			mockLayoutSpawn({ windowsExit: 1 });
			const layout = await getTmuxLayout("task-layout-03");

			expect(layout.exists).toBe(false);
			expect(layout.windows).toHaveLength(0);
			expect(layout.panes).toHaveLength(0);
		});

		it("reports the status-bar reservation (client_height - window_height)", async () => {
			mockLayoutSpawn({ status: "51\t50\ton\tbottom\n" });
			const layout = await getTmuxLayout("task-status-01");
			expect(layout.statusLines).toBe(1);
			expect(layout.statusAtTop).toBe(false);

			mockLayoutSpawn({ status: "50\t50\toff\tbottom\n" });
			expect((await getTmuxLayout("task-status-02")).statusLines).toBe(0);

			mockLayoutSpawn({ status: "52\t50\ton\ttop\n" });
			const top = await getTmuxLayout("task-status-03");
			expect(top.statusLines).toBe(2);
			expect(top.statusAtTop).toBe(true);
		});

		it("uses zoom-independent window_layout geometry over collapsed pane fields", async () => {
			// While the window is zoomed, list-panes collapses the ACTIVE pane to the
			// full window (200 wide, left 0) — overlapping the other pane. The real
			// split must still come from window_layout (%1 = 99 wide @ left 0).
			mockLayoutSpawn({
				windows: "0\t1\t2\t1\tcf3a,200x50,0,0{99x50,0,0,1,100x50,100,0,2}\tmain\n",
				panes: "0\t%1\t1\t0\t0\t200\t50\tclaude\tAgent\n" + "0\t%2\t0\t100\t0\t100\t50\tzsh\tShell\n",
			});
			const layout = await getTmuxLayout("task-layout-05");
			expect(layout.windows[0].zoomed).toBe(true);

			expect(layout.panes[0]).toMatchObject({ paneId: "%1", left: 0, width: 99 });
			expect(layout.panes[1]).toMatchObject({ paneId: "%2", left: 100, width: 100 });
			// The collapsed full-window width (200) must NOT leak through.
			expect(layout.panes[0].width).not.toBe(200);

			// Without window_layout, per-pane geometry is the fallback.
			mockLayoutSpawn({ windows: "0\t1\t1\t0\t\tmain\n", panes: "0\t%7\t1\t3\t4\t80\t20\tzsh\tShell\n" });
			const flat = await getTmuxLayout("task-layout-06");
			expect(flat.panes[0]).toMatchObject({ paneId: "%7", left: 3, top: 4, width: 80, height: 20 });
		});
	});

	// ------- Callbacks -------

	describe("panes of every window", () => {
		const proc = (stdout: string) => ({ pid: 1, kill: vi.fn(), stdout: new Response(stdout).body, stderr: new Response("").body, exited: Promise.resolve(0) }) as any;
		const tmuxCall = (verb: string) => mockSpawn.mock.calls.map((c) => c[0] as string[]).find((cmd) => Array.isArray(cmd) && cmd.includes(verb));

		it("listPaneIds reads the whole session, not just its current window", async () => {
			mockSpawn.mockImplementation(() => proc("%1\n%12\n") as any);
			expect(await listPaneIds("task-lp-01", "sock")).toEqual(["%1", "%12"]);
			expect(tmuxCall("list-panes")).toEqual(expect.arrayContaining(["list-panes", "-s", "-t"]));
		});

		it("installPaneExitedHooks hooks every window that exists and every one that will", async () => {
			mockSpawn.mockImplementation((cmd: any) => proc(cmd.includes("list-windows") ? "@1\t0\t1\t\tzsh\n@5\t1\t0\t\tAgents\n" : "") as any);
			await installPaneExitedHooks("dev3-abc", "sock");
			const calls = mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((cmd) => cmd.includes("set-hook"));
			const exited = (target: string) => calls.find((cmd) => cmd.includes("-wt") && cmd.includes(target));
			expect(exited("@1")).toEqual(expect.arrayContaining(["-L", "sock", "set-hook", "-wt", "@1", "pane-exited"]));
			expect(exited("@5")![exited("@5")!.length - 1]).toContain("/pane-exited?session=dev3-abc&pane=#{hook_pane}");
			// The new-window hook carries the very same text, quoted as an argument of set-hook -w.
			const session = calls.find((cmd) => cmd.includes("after-new-window"))!;
			expect(session).toEqual(expect.arrayContaining(["set-hook", "-t", "dev3-abc", "after-new-window"]));
			const inner = session[session.length - 1];
			expect(inner).toMatch(/^set-hook -w pane-exited "run-shell \\"curl -s '.*\/pane-exited\?session=dev3-abc&pane=#\{hook_pane\}' \|\| true\\""$/);
			expect(inner).not.toContain("##{");
		});
	});

	describe("callbacks", () => {
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

		it("fires onBell for a BEL (string or bytes), but not for the BEL terminating an OSC", () => {
			const bellCb = vi.fn();
			setOnBell(bellCb);

			const id = track("task-bell-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(capturedDataCb).not.toBeNull();

			capturedDataCb!(null, "some output\x07more");
			expect(bellCb).toHaveBeenCalledWith(id);

			bellCb.mockClear();
			capturedDataCb!(null, new TextEncoder().encode("output\x07"));
			expect(bellCb).toHaveBeenCalledWith(id);

			bellCb.mockClear();
			// OSC 0 (title change) uses \x07 as terminator — not a real bell
			capturedDataCb!(null, "\x1b]0;window title\x07");
			expect(bellCb).not.toHaveBeenCalled();

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

			// An OSC 52 query (b64 is '?') is ignored.
			osc52Cb.mockClear();
			capturedDataCb!(null, "\x1b]52;c;?\x07");
			expect(osc52Cb).not.toHaveBeenCalled();
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

		it("does not throw on data callback errors", () => {
			const id = track("task-dataerr-1");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			// null data will cause TextDecoder.decode(null) to throw,
			// but the try/catch in the callback should swallow it
			expect(() => capturedDataCb!(null, null as any)).not.toThrow();
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
			expect(sourceCall![0]).toContain(tmuxConfigPath("dark", true));

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

		// The order this asserts is the whole point: `new-session` first, the generation
		// token second. Minting it first would ask a socket with no server on it, start an
		// empty server, and race the real session onto a generation nobody observed.
		it("mints the generation token only after new-session created the server", async () => {
			vi.useFakeTimers();

			const id = track("task-token-order");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "token-sock");

			const indexOfCall = (needle: string) =>
				mockSpawn.mock.calls.findIndex((c) => Array.isArray(c[0]) && c[0].includes("token-sock") && c[0].join(" ").includes(needle));

			await vi.advanceTimersByTimeAsync(200);
			await vi.waitFor(() => {
				expect(indexOfCall("@dev3_server_token")).toBeGreaterThanOrEqual(0);
			});

			const sessionAt = indexOfCall("new-session");
			const tokenAt = indexOfCall("@dev3_server_token");
			expect(sessionAt).toBeGreaterThanOrEqual(0);
			expect(tokenAt).toBeGreaterThan(sessionAt);

			vi.useRealTimers();
		});

		// A server that never answers must not break the terminal: the pane stays usable and
		// only pane input loses the ability to pin it.
		it("retries a failing token a bounded number of times and still configures", async () => {
			vi.useFakeTimers();

			const id = track("task-token-retry");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "retry-sock");
			let tokenCalls = 0;
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.join(" ").includes("@dev3_server_token")) {
					tokenCalls += 1;
					throw new Error("no server running");
				}
				return defaultSpawnReturn() as any;
			});

			mockLog.lines.length = 0;
			await expect(vi.advanceTimersByTimeAsync(200 + 3 * 150)).resolves.not.toThrow();
			await vi.waitFor(() => {
				expect(tokenCalls).toBe(3);
			});
			// The setup step must be AWAITING the token: its closing line comes after the
			// last failed attempt, not before the retries have even run.
			await vi.waitFor(() => {
				expect(mockLog.lines).toContain("debug:tmux session setup finished");
			});
			const lastWarn = mockLog.lines.lastIndexOf("warn:tmux server has no dev3 generation token; its panes cannot be pinned");
			expect(lastWarn).toBeGreaterThanOrEqual(0);
			expect(mockLog.lines.indexOf("debug:tmux session setup finished")).toBeGreaterThan(lastWarn);
			// Sourcing the config still happens, so the terminal is unaffected.
			await vi.waitFor(() => {
				const sourced = mockSpawn.mock.calls.find(
					(c) => Array.isArray(c[0]) && c[0].includes("source-file") && c[0].includes("retry-sock"),
				);
				expect(sourced).toBeDefined();
			});

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
		it("creates a project session typed 'project' with the dev3-pt- tmux name", () => {
			const key = track("project-a1b2c3d4-e5f6-7890-abcd-ef1234567890");
			createSession(key, "a1b2c3d4", "/tmp/project-root", "bash", {}, "dev3", "project");
			expect(hasSession(key)).toBe(true);
			expect(getSessionType(key)).toBe("project");
			expect(getSessionTmuxName(key)).toBe("dev3-pt-a1b2c3d4");
			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall![0]).toContain("dev3-pt-a1b2c3d4");

			// destroySession kills the dev3-pt- tmux session.
			destroySession(key);
			expect(hasSession(key)).toBe(false);
			const killCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall![0]).toContain("dev3-pt-a1b2c3d4");
		});

		it("a task session is typed 'task' with the dev3- tmux name; unknown is null", () => {
			const id = track("task-tmux-name-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			expect(getSessionTmuxName(id)).toBe("dev3-task-tmu");
			expect(getSessionType(id)).toBe("task");
			expect(getSessionType("nonexistent")).toBeNull();
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
	});

	// ------- cwdExists -------

	describe("cwdExists", () => {
		// Regression: a PTY cwd is always a DIRECTORY, and the old check used
		// `Bun.file(cwd).exists()`, which returns false for directories — so every
		// valid worktree/project dir produced a bogus "PTY cwd missing" error.
		it("returns true for an existing directory or file, false for a missing path", async () => {
			expect(await cwdExists(join(tmpdir(), "dev3-cwd-nope-zzzzzzzz"))).toBe(false);
			const dir = await mkdtemp(join(tmpdir(), "dev3-cwd-"));
			const file = join(dir, "f.txt");
			await writeFile(file, "x");
			try {
				expect(await cwdExists(dir)).toBe(true);
				expect(await cwdExists(file)).toBe(true);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	});
});

// ================================================================
// Held `dev3 message` vs the human at the keyboard
// ================================================================

describe("noteHumanTerminalInput", () => {
	const TASK = "task-typing";
	const session = { taskId: TASK } as any;

	function heldMessage() {
		const item = { text: "", deliver: vi.fn<() => HeldDeliveryResult>(() => "landed"), bytes: 0, submit: vi.fn<() => HeldDeliveryResult>(() => "landed") };
		holdAgentMessage(agentMessageHoldKey("tmux", TASK, "%1"), item, {});
		return item;
	}

	beforeEach(() => {
		resetAgentMessageHolds();
		vi.useFakeTimers();
	});
	afterEach(() => {
		resetAgentMessageHolds();
		vi.useRealTimers();
	});

	it("holds a message back while the user types, with no ceiling", async () => {
		const item = heldMessage();
		const ws: any = {};
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_HOLD_CEILING_MS * 2) {
			await vi.advanceTimersByTimeAsync(1_000);
			elapsed += 1_000;
			noteHumanTerminalInput(session, ws, "a");
		}
		expect(item.deliver).not.toHaveBeenCalled();
	});

	it("lands it at once when he submits his own line", async () => {
		const item = heldMessage();
		noteHumanTerminalInput(session, {}, "ship it\r");
		await vi.advanceTimersByTimeAsync(0);
		expect(item.deliver).toHaveBeenCalledTimes(1);
		expect(item.submit).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("keeps holding through a Shift+Enter, which is a newline he is still writing", async () => {
		const item = heldMessage();
		noteHumanTerminalInput(session, {}, "first line\x1b\r");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS - 1);
		expect(item.deliver).not.toHaveBeenCalled();
	});

	it("gives him the longer human window, not the message one, once he has typed", async () => {
		const item = heldMessage();
		noteHumanTerminalInput(session, {}, "thinking");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(item.deliver).not.toHaveBeenCalled();
	});

	it("does not push a held message back for a mouse click or wheel scroll", async () => {
		const item = heldMessage();
		noteHumanTerminalInput(session, {}, "\x1b[<0;12;5M");
		noteHumanTerminalInput(session, {}, "\x1b[<0;12;5m");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(item.deliver).toHaveBeenCalledTimes(1);

		const wheel = heldMessage();
		noteHumanTerminalInput(session, {}, "\x1b[<64;12;5M\x1b[<64;12;5M");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(wheel.deliver).toHaveBeenCalledTimes(1);
	});

	it("reads a CR inside a paste split across frames as content, not a submit", async () => {
		const item = heldMessage();
		const ws: any = {};
		noteHumanTerminalInput(session, ws, "\x1b[200~line one\r");
		noteHumanTerminalInput(session, ws, "line two\r\x1b[201~");
		await vi.advanceTimersByTimeAsync(0);
		expect(item.deliver).not.toHaveBeenCalled();
	});

	it("is wired into EVERY keystroke path of the WS message handler", () => {
		// The behaviour above is worthless if a path writes to the shell without
		// reporting the keystrokes, so the wiring itself is asserted here.
		const source = readFileSync(new URL("../pty-server.ts", import.meta.url), "utf8");
		const writes = [...source.matchAll(/shell\.write\(data\);\n(.*)\n/g)];
		expect(writes.length).toBeGreaterThanOrEqual(2);
		for (const write of writes) {
			expect(write[1]).toContain("noteHumanTerminalInput(session, ws, data)");
		}
	});
});

// Every dev3 instance shares the tmux server, so the dimming choice lives there:
// only an explicit toggle may set it, and it must land before the re-source that
// derives the pane styles from it.
describe("applyTmuxTheme pane dimming", () => {
	const tmuxArgs = () => mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((a) => Array.isArray(a));
	const dimSet = (args: string[]) => args.includes("set-option") && args.includes("@dev3_pane_dimming");

	it("sets the server-wide choice on an explicit toggle, before sourcing", async () => {
		mockSpawn.mockClear();
		await applyTmuxTheme("dark", { paneDimming: false });
		const calls = tmuxArgs();
		const setIdx = calls.findIndex(dimSet);
		const sourceIdx = calls.findIndex((a) => a.includes("source-file"));
		expect(setIdx).toBeGreaterThanOrEqual(0);
		expect(calls[setIdx]).toEqual(expect.arrayContaining(["-L", "dev3", "set-option", "-g", "@dev3_pane_dimming", "off"]));
		expect(sourceIdx).toBeGreaterThan(setIdx);
	});

	it("leaves the server-wide choice alone on a plain theme apply", async () => {
		mockSpawn.mockClear();
		await applyTmuxTheme("dark");
		const calls = tmuxArgs();
		expect(calls.some((a) => a.includes("source-file"))).toBe(true);
		expect(calls.some(dimSet)).toBe(false);
	});
});

describe("tmux task title", () => {
	const titleSets = () =>
		mockSpawn.mock.calls.map((c) => c[0] as string[]).filter((a) => Array.isArray(a) && a.includes("@dev3_task_title"));

	it("writes the flattened, markup-defused title into the task's own session, exactly targeted", async () => {
		expect(tmuxTaskTitleValue("  Fix\n the   #[fg=red]bar \t")).toBe("Fix the # [fg=red]bar");
		const id = "title-sync-task-0001";
		createSession(id, "proj-1", "/tmp/test-cwd", "bash", {});
		mockSpawn.mockClear();
		await syncTmuxTaskTitle(id, "Move tmux window bar to top");
		expect(titleSets()).toEqual([
			expect.arrayContaining(["-L", "dev3", "set-option", "-t", `=${getSessionTmuxName(id)}:`, "@dev3_task_title", "Move tmux window bar to top"]),
		]);
		destroySession(id);
	});

	it("does nothing for a task with no open terminal or a project terminal", async () => {
		createSession("title-sync-project-0001", "proj-1", "/tmp/test-cwd", "bash", {}, "dev3", "project");
		mockSpawn.mockClear();
		await syncTmuxTaskTitle("no-such-task", "x");
		await syncTmuxTaskTitle("title-sync-project-0001", "x");
		expect(titleSets()).toEqual([]);
		destroySession("title-sync-project-0001");
	});
});
