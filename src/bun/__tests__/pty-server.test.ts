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
		existsSync: vi.fn(() => true),
		writeFileSync: vi.fn(),
	};
});

vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

// ---- Imports ----

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "../spawn";
import {
	tmuxArgs,
	createSession,
	destroySession,
	hasSession,
	hasDeadSession,
	capturePane,
	getSessionProjectId,
	getSessionSocket,
	getPtyPort,
	setOnPtyDied,
	setOnBell,
	TMUX_CONF_PATH,
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
});

afterEach(() => {
	for (const id of activeSessions) {
		if (hasSession(id)) destroySession(id);
	}
	activeSessions.length = 0;
	setOnPtyDied(() => {});
	setOnBell(() => {});
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

	// ------- createSession -------

	describe("createSession", () => {
		it("creates a session and marks it as existing", () => {
			const id = track("task-create-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {});
			expect(hasSession(id)).toBe(true);
		});

		it("spawns tmux new-session via spawn", () => {
			const id = track("task-spawn-01");
			createSession(id, "proj-1", "/tmp/test-cwd", "bash", {});

			// spawnSync for "which tmux" check
			expect(mockSpawnSync).toHaveBeenCalledWith(["which", "tmux"]);

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
			expect(tmuxCall![1]).toEqual(expect.objectContaining({ cwd: "/tmp/test-cwd" }));
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

		it("uses 'bash' when tmuxCommand is empty", () => {
			const id = track("task-defcmd-01");
			createSession(id, "proj-1", "/tmp/cwd", "", {});

			const tmuxCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("new-session"),
			);
			expect(tmuxCall).toBeDefined();
			// last arg should be "bash" (default)
			expect(tmuxCall![0][tmuxCall![0].length - 1]).toBe("bash");
		});

		it("calls onPtyDied when cwd does not exist", () => {
			mockExistsSync.mockReturnValue(false);
			const diedCb = vi.fn();
			setOnPtyDied(diedCb);

			const id = track("task-nocwd-01");
			createSession(id, "proj-1", "/tmp/nonexistent", "bash", {});

			expect(diedCb).toHaveBeenCalledWith(id);
		});

		it("calls onPtyDied when spawn throws", () => {
			mockSpawn.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("new-session")) {
					throw new Error("spawn failed");
				}
				return defaultSpawnReturn() as any;
			});
			const diedCb = vi.fn();
			setOnPtyDied(diedCb);

			const id = track("task-spnfail-1");
			expect(() => createSession(id, "proj-1", "/tmp/cwd", "bash", {})).not.toThrow();
			expect(diedCb).toHaveBeenCalledWith(id);
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

			// Advance past the 200ms setTimeout
			vi.advanceTimersByTime(300);

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

		it("does not call tmux set-environment when env is empty", async () => {
			vi.useFakeTimers();
			const id = track("task-env-empty");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "my-socket");
			mockSpawn.mockClear();

			vi.advanceTimersByTime(300);

			const setEnvCalls = mockSpawn.mock.calls.filter(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment"),
			);
			expect(setEnvCalls).toHaveLength(0);

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

		it("kills tmux session via spawnSync", () => {
			const id = track("task-dstr-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawnSync.mockClear();

			destroySession(id);
			activeSessions.splice(activeSessions.indexOf(id), 1);

			const killCall = mockSpawnSync.mock.calls.find(
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

			// Make kill-session throw
			mockSpawnSync.mockImplementation((cmd: any) => {
				if (Array.isArray(cmd) && cmd.includes("kill-session")) {
					throw new Error("tmux kill failed");
				}
				return { exitCode: 0, stdout: new Uint8Array(0) } as any;
			});

			expect(() => destroySession(id)).not.toThrow();
			activeSessions.splice(activeSessions.indexOf(id), 1);
		});

		it("kills tmux session even when not in memory map (fallback socket)", () => {
			mockSpawnSync.mockClear();

			// Destroy a session that was never created in the Map
			destroySession("unknown-task-id-1234", "dev3");

			const killCall = mockSpawnSync.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("kill-session"),
			);
			expect(killCall).toBeDefined();
			expect(killCall![0]).toContain("dev3-unknown-");
			expect(killCall![0]).toContain("-L");
			expect(killCall![0]).toContain("dev3");
		});

		it("uses fallback socket 'dev3' when no session and no fallback provided", () => {
			mockSpawnSync.mockClear();

			destroySession("orphan-task-id-5678");

			const killCall = mockSpawnSync.mock.calls.find(
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
		it("returns pane content on success", () => {
			const id = track("task-cap-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			const content = "Hello, world!\n";
			mockSpawnSync.mockReturnValue({
				exitCode: 0,
				stdout: new TextEncoder().encode(content),
			} as any);

			expect(capturePane(id)).toBe(content);
		});

		it("uses session socket for tmux command", () => {
			const id = track("task-cap-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "cap-sock");

			mockSpawnSync.mockReturnValue({
				exitCode: 0,
				stdout: new TextEncoder().encode("data"),
			} as any);

			capturePane(id);

			const captureCall = mockSpawnSync.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("capture-pane"),
			);
			expect(captureCall).toBeDefined();
			expect(captureCall![0]).toContain("-L");
			expect(captureCall![0]).toContain("cap-sock");
		});

		it("returns null on non-zero exit code", () => {
			const id = track("task-cap-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			mockSpawnSync.mockReturnValue({
				exitCode: 1,
				stdout: new TextEncoder().encode("error"),
			} as any);

			expect(capturePane(id)).toBeNull();
		});

		it("returns null on empty stdout", () => {
			const id = track("task-cap-04");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			mockSpawnSync.mockReturnValue({
				exitCode: 0,
				stdout: new Uint8Array(0),
			} as any);

			expect(capturePane(id)).toBeNull();
		});

		it("returns null on spawnSync error", () => {
			const id = track("task-cap-05");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			mockSpawnSync.mockImplementation(() => {
				throw new Error("tmux error");
			});

			expect(capturePane(id)).toBeNull();
		});

		it("works even without an active session (uses null socket)", () => {
			mockSpawnSync.mockReturnValue({
				exitCode: 1,
				stdout: new Uint8Array(0),
			} as any);

			expect(capturePane("no-such-session")).toBeNull();
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

		it("handles OSC 52 clipboard data and calls pbcopy", () => {
			const id = track("task-osc52-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			const testText = "Hello clipboard";
			const b64 = Buffer.from(testText).toString("base64");
			const osc52Seq = `\x1b]52;c;${b64}\x07`;

			// Reset spawn mock to track pbcopy call
			mockSpawn.mockClear();
			const mockStdin = { write: vi.fn(), end: vi.fn() };
			mockSpawn.mockReturnValue({ pid: 999, stdin: mockStdin } as any);

			capturedDataCb!(null, osc52Seq);

			expect(mockSpawn).toHaveBeenCalledWith(
				["pbcopy"],
				expect.objectContaining({ stdin: "pipe" }),
			);
		});

		it("ignores OSC 52 query (b64 is '?')", () => {
			const id = track("task-osc52-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});

			mockSpawn.mockClear();

			// OSC 52 query: base64 content is "?"
			capturedDataCb!(null, "\x1b]52;c;?\x07");

			// pbcopy should NOT be called
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
	});

	// ------- configureTmux via spawnPty (setTimeout) -------

	describe("configureTmux via spawnPty", () => {
		it("sources tmux config after timeout when socket is provided", () => {
			vi.useFakeTimers();

			const id = track("task-conf-01");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "conf-socket");
			mockSpawnSync.mockClear();
			mockSpawn.mockClear();

			vi.advanceTimersByTime(200);

			const sourceCall = mockSpawnSync.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("source-file"),
			);
			expect(sourceCall).toBeDefined();
			expect(sourceCall![0]).toContain("-L");
			expect(sourceCall![0]).toContain("conf-socket");
			expect(sourceCall![0]).toContain(TMUX_CONF_PATH);

			vi.useRealTimers();
		});

		it("sets tmux PATH when env.PATH is provided", () => {
			vi.useFakeTimers();

			const id = track("task-conf-02");
			createSession(id, "proj-1", "/tmp/cwd", "bash", { PATH: "/usr/local/bin" }, "path-sock");
			mockSpawn.mockClear();

			vi.advanceTimersByTime(200);

			const envCall = mockSpawn.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("set-environment"),
			);
			expect(envCall).toBeDefined();
			expect(envCall![0]).toContain("PATH");
			expect(envCall![0]).toContain("/usr/local/bin");

			vi.useRealTimers();
		});

		it("always sources config with default socket", () => {
			vi.useFakeTimers();

			const id = track("task-conf-03");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {});
			mockSpawnSync.mockClear();

			vi.advanceTimersByTime(200);

			const sourceCall = mockSpawnSync.mock.calls.find(
				(c) => Array.isArray(c[0]) && c[0].includes("source-file"),
			);
			expect(sourceCall).toBeDefined();

			vi.useRealTimers();
		});

		it("does not throw when configureTmux fails", () => {
			vi.useFakeTimers();

			const id = track("task-conf-04");
			createSession(id, "proj-1", "/tmp/cwd", "bash", {}, "err-sock");
			mockSpawnSync.mockImplementation(() => {
				throw new Error("source-file failed");
			});

			expect(() => vi.advanceTimersByTime(200)).not.toThrow();

			vi.useRealTimers();
		});
	});

	// ------- TMUX_CONF_PATH -------

	describe("TMUX_CONF_PATH", () => {
		it("equals /tmp/dev3-tmux.conf", () => {
			expect(TMUX_CONF_PATH).toBe("/tmp/dev3-tmux.conf");
		});
	});
});
