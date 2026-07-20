import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { TmuxClient } from "../client";
import { TmuxError, TmuxSpawnError, isTmuxError, isTmuxSpawnError } from "../errors";
import {
	PANE_ID_FORMAT,
	PANE_IN_MODE_FORMAT,
	SESSION_OVERVIEW_FORMAT,
	WINDOW_SWITCHER_FORMAT,
	STATUS_GEOMETRY_FORMAT,
} from "../formats";
import { DEV3_HOME } from "../../paths";

// The client is constructed with an INJECTED fake spawn — the only seam its
// own tests use. Assertions target external behavior: the argv handed to
// spawn and the typed structures returned.

function makeProc(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		pid: 42,
		kill: vi.fn(),
		stdout: "",
		stderr: "",
		exited: Promise.resolve(0),
		terminal: { close: vi.fn(), resize: vi.fn(), write: vi.fn() },
		...overrides,
	};
}

function makeClient(result: Partial<Record<string, unknown>> = {}) {
	const spawnFn = vi.fn().mockReturnValue(makeProc(result));
	const client = new TmuxClient({ spawn: spawnFn as never });
	return { client, spawnFn };
}

function argvOf(spawnFn: ReturnType<typeof vi.fn>, call = 0): string[] {
	return spawnFn.mock.calls[call][0] as string[];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("argv construction", () => {
	it("always targets the socket: <binary> -L <socket> …", async () => {
		const { client, spawnFn } = makeClient();
		await client.hasSession("dev3-abc12345", { socket: "my-sock" });
		expect(argvOf(spawnFn)).toEqual(["tmux", "-L", "my-sock", "has-session", "-t", "dev3-abc12345"]);
	});

	it("falls back to the constructor socket (default dev3)", async () => {
		const { client, spawnFn } = makeClient();
		await client.hasSession("dev3-abc12345");
		expect(argvOf(spawnFn).slice(0, 3)).toEqual(["tmux", "-L", "dev3"]);
	});

	it("honors a custom default socket", async () => {
		const spawnFn = vi.fn().mockReturnValue(makeProc());
		const client = new TmuxClient({ spawn: spawnFn as never, socket: "custom" });
		await client.killSession("s");
		expect(argvOf(spawnFn).slice(0, 3)).toEqual(["tmux", "-L", "custom"]);
	});

	it("pipes stdout and stderr for every run", async () => {
		const { client, spawnFn } = makeClient();
		await client.sourceFile("/tmp/conf");
		expect(spawnFn.mock.calls[0][1]).toEqual({ stdout: "pipe", stderr: "pipe" });
	});
});

describe("hasSession", () => {
	it("maps exit 0 to true and non-zero to false (no throw)", async () => {
		const { client } = makeClient({ exited: Promise.resolve(0) });
		expect(await client.hasSession("s")).toBe(true);
		const { client: gone } = makeClient({ exited: Promise.resolve(1) });
		expect(await gone.hasSession("s")).toBe(false);
	});

	it("propagates a launch failure as TmuxSpawnError", async () => {
		const spawnFn = vi.fn(() => { throw new Error("posix_spawn ENOENT"); });
		const client = new TmuxClient({ spawn: spawnFn as never });
		await expect(client.hasSession("s")).rejects.toSatisfy((err: unknown) => isTmuxSpawnError(err));
	});
});

describe("error model", () => {
	it("wraps a non-zero exit in TmuxError with args/exitCode/stderr", async () => {
		const { client } = makeClient({ exited: Promise.resolve(1), stderr: "can't find session: x\n" });
		let caught: unknown;
		try {
			await client.killSession("x");
		} catch (err) {
			caught = err;
		}
		expect(isTmuxError(caught)).toBe(true);
		const err = caught as TmuxError;
		expect(err.exitCode).toBe(1);
		expect(err.stderr).toBe("can't find session: x");
		expect(err.args[0]).toBe("kill-session");
	});

	it("bestEffort swallows TmuxError but not launch failures", async () => {
		const { client } = makeClient({ exited: Promise.resolve(1), stderr: "nope" });
		await expect(client.killSession("x", { bestEffort: true })).resolves.toBeUndefined();

		const spawnFn = vi.fn(() => { throw new Error("EACCES"); });
		const broken = new TmuxClient({ spawn: spawnFn as never });
		await expect(broken.killSession("x", { bestEffort: true })).rejects.toBeInstanceOf(TmuxSpawnError);
	});

	it("TmuxSpawnError carries the Full Disk Access hint and the cause", async () => {
		const cause = new Error("posix_spawn '/opt/tmux'");
		const spawnFn = vi.fn(() => { throw cause; });
		const client = new TmuxClient({ spawn: spawnFn as never });
		const err = await client.sourceFile("/tmp/x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TmuxSpawnError);
		expect((err as Error).message).toContain("Full Disk Access");
		expect((err as TmuxSpawnError).cause).toBe(cause);
	});
});

describe("list/parse methods", () => {
	it("listPanes parses rows through the format declaration", async () => {
		const { client, spawnFn } = makeClient({ stdout: "%1\n%2\n" });
		const rows = await client.listPanes(PANE_ID_FORMAT, { target: "dev3-abc" });
		expect(rows).toEqual([{ paneId: "%1" }, { paneId: "%2" }]);
		expect(argvOf(spawnFn)).toEqual(["tmux", "-L", "dev3", "list-panes", "-t", "dev3-abc", "-F", "#{pane_id}"]);
	});

	it("listPanes scope session adds -s, scope server uses -a without target", async () => {
		const { client, spawnFn } = makeClient({ stdout: "%1\t1\n" });
		await client.listPanes(PANE_IN_MODE_FORMAT, { target: "dev3-abc", scope: "session" });
		expect(argvOf(spawnFn)).toContain("-s");

		const { client: server, spawnFn: serverSpawn } = makeClient({ stdout: "" });
		await server.listPanes(PANE_ID_FORMAT, { scope: "server" });
		expect(argvOf(serverSpawn)).toContain("-a");
		expect(argvOf(serverSpawn)).not.toContain("-t");
	});

	it("listPanes requires a target unless scope is server", async () => {
		const { client } = makeClient();
		await expect(client.listPanes(PANE_ID_FORMAT, {})).rejects.toThrow(/target is required/);
	});

	it("listWindows and listSessions pass the format string", async () => {
		const { client, spawnFn } = makeClient({ stdout: "@1\t1\tmain\n" });
		const windows = await client.listWindows(WINDOW_SWITCHER_FORMAT, { target: "dev3-abc" });
		expect(windows).toEqual([{ windowId: "@1", active: true, name: "main" }]);
		expect(argvOf(spawnFn)).toContain(WINDOW_SWITCHER_FORMAT.formatString);

		const { client: sessions, spawnFn: sessionsSpawn } = makeClient({ stdout: "dev3-a\t1\t123\t/tmp\n" });
		const rows = await sessions.listSessions(SESSION_OVERVIEW_FORMAT);
		expect(rows[0]).toMatchObject({ name: "dev3-a", windowCount: 1, createdAt: 123, cwd: "/tmp" });
		expect(argvOf(sessionsSpawn)[3]).toBe("list-sessions");
	});

	it("displayMessage returns the first parsed row or null", async () => {
		const { client, spawnFn } = makeClient({ stdout: "51\t50\ton\tbottom\n" });
		const row = await client.displayMessage(STATUS_GEOMETRY_FORMAT, { target: "dev3-abc" });
		expect(row).toEqual({ clientHeight: 51, windowHeight: 50, status: "on", statusPosition: "bottom" });
		expect(argvOf(spawnFn)).toEqual([
			"tmux", "-L", "dev3", "display-message", "-p", "-t", "dev3-abc", STATUS_GEOMETRY_FORMAT.formatString,
		]);

		const { client: empty } = makeClient({ stdout: "" });
		expect(await empty.displayMessage(STATUS_GEOMETRY_FORMAT, { target: "x" })).toBeNull();
	});

	it("activePaneId trims to the pane id or null", async () => {
		const { client } = makeClient({ stdout: "%7\n" });
		expect(await client.activePaneId("dev3-abc")).toBe("%7");
		const { client: empty } = makeClient({ stdout: "\n" });
		expect(await empty.activePaneId("dev3-abc")).toBeNull();
	});
});

describe("splitWindow / newWindow", () => {
	it("builds the full flag set in canonical order and returns the pane id", async () => {
		const { client, spawnFn } = makeClient({ stdout: "%9\n", stderr: "warn\n" });
		const result = await client.splitWindow({
			target: "dev3-abc",
			orientation: "horizontal",
			size: "40%",
			printPaneId: true,
			env: { A: "1", B: "2" },
			cwd: "/wt",
			command: "zsh",
			socket: "s1",
		});
		expect(result).toEqual({ paneId: "%9", stderr: "warn\n" });
		expect(argvOf(spawnFn)).toEqual([
			"tmux", "-L", "s1", "split-window", "-h",
			"-l", "40%",
			"-P", "-F", "#{pane_id}",
			"-e", "A=1", "-e", "B=2",
			"-t", "dev3-abc", "-c", "/wt", "zsh",
		]);
	});

	it("vertical orientation maps to -v, before to -b, no -P without printPaneId", async () => {
		const { client, spawnFn } = makeClient({ stdout: "" });
		const result = await client.splitWindow({ target: "t", orientation: "vertical", before: true });
		expect(result.paneId).toBeNull();
		const argv = argvOf(spawnFn);
		expect(argv).toContain("-v");
		expect(argv).toContain("-b");
		expect(argv).not.toContain("-P");
	});

	it("throws TmuxError on a failed split", async () => {
		const { client } = makeClient({ exited: Promise.resolve(1), stderr: "pane too small" });
		await expect(client.splitWindow({ target: "t", orientation: "vertical" })).rejects.toBeInstanceOf(TmuxError);
	});

	it("newWindow passes -n name and returns the pane id", async () => {
		const { client, spawnFn } = makeClient({ stdout: "%3\n" });
		const result = await client.newWindow({ target: "dev3-abc:", name: "make:test", printPaneId: true, cwd: "/wt", command: "cmd" });
		expect(result.paneId).toBe("%3");
		expect(argvOf(spawnFn)).toEqual([
			"tmux", "-L", "dev3", "new-window", "-n", "make:test",
			"-P", "-F", "#{pane_id}", "-t", "dev3-abc:", "-c", "/wt", "cmd",
		]);
	});
});

describe("newSessionDetached", () => {
	it("starts detached with env flags and pins the client cwd to DEV3_HOME", async () => {
		const { client, spawnFn } = makeClient({ stderr: "" });
		const { stderr } = await client.newSessionDetached({
			sessionName: "dev3-dev-abc",
			cwd: "/wt",
			env: { DEV3_TASK_ID: "t1" },
			command: "bash dev.sh",
		});
		expect(stderr).toBe("");
		expect(argvOf(spawnFn)).toEqual([
			"tmux", "-L", "dev3", "new-session", "-d",
			"-e", "DEV3_TASK_ID=t1",
			"-s", "dev3-dev-abc", "-c", "/wt", "bash dev.sh",
		]);
		// Decision 103: a tmux server started by this client must never inherit
		// a mortal worktree cwd.
		expect(spawnFn.mock.calls[0][1]).toMatchObject({ cwd: DEV3_HOME });
	});

	it("throws TmuxError with captured stderr on failure", async () => {
		const { client } = makeClient({ exited: Promise.resolve(1), stderr: "duplicate session" });
		await expect(client.newSessionDetached({ sessionName: "s", cwd: "/wt" })).rejects.toMatchObject({
			name: "TmuxError",
			stderr: "duplicate session",
		});
	});
});

describe("spawnAttachedSession", () => {
	it("builds -f config new-session [-A] -c cwd -e… -s name cmd and pins client cwd", () => {
		const { client, spawnFn } = makeClient();
		const terminal = { cols: 220, rows: 50, data: vi.fn() };
		const proc = client.spawnAttachedSession({
			socket: "s1",
			sessionName: "dev3-abc12345",
			configFile: "/tmp/conf",
			cwd: "/wt",
			attachIfExists: true,
			envFlags: { K: "v" },
			command: "zsh",
			terminal,
			processEnv: { TERM: "xterm-256color" },
		});
		expect(proc).toBeDefined();
		expect(argvOf(spawnFn)).toEqual([
			"tmux", "-L", "s1", "-f", "/tmp/conf", "new-session", "-A",
			"-c", "/wt", "-e", "K=v", "-s", "dev3-abc12345", "zsh",
		]);
		expect(spawnFn.mock.calls[0][1]).toMatchObject({
			terminal,
			env: { TERM: "xterm-256color" },
			cwd: DEV3_HOME,
		});
	});

	it("omits -A without attachIfExists and wraps launch failures", () => {
		const { client, spawnFn } = makeClient();
		client.spawnAttachedSession({
			sessionName: "dev3-cl-abc",
			configFile: "/tmp/conf",
			cwd: "/wt",
			terminal: { cols: 1, rows: 1, data: vi.fn() },
		});
		expect(argvOf(spawnFn)).not.toContain("-A");

		const throwing = vi.fn(() => { throw new Error("ENOENT"); });
		const broken = new TmuxClient({ spawn: throwing as never });
		expect(() => broken.spawnAttachedSession({
			sessionName: "s", configFile: "/c", cwd: "/w",
			terminal: { cols: 1, rows: 1, data: vi.fn() },
		})).toThrow(TmuxSpawnError);
	});
});

describe("command methods build the documented argv", () => {
	const CASES: Array<[string, (c: TmuxClient) => Promise<void>, string[]]> = [
		["selectPane", (c) => c.selectPane("%1"), ["select-pane", "-t", "%1"]],
		["selectPane with title", (c) => c.selectPane("%1", { title: "Shell" }), ["select-pane", "-t", "%1", "-T", "Shell"]],
		["selectWindow", (c) => c.selectWindow("dev3-a:+"), ["select-window", "-t", "dev3-a:+"]],
		["selectLayout", (c) => c.selectLayout("dev3-a", "tiled"), ["select-layout", "-t", "dev3-a", "tiled"]],
		["nextLayout", (c) => c.nextLayout("dev3-a"), ["next-layout", "-t", "dev3-a"]],
		["toggleZoom", (c) => c.toggleZoom("dev3-a"), ["resize-pane", "-Z", "-t", "dev3-a"]],
		["killPane", (c) => c.killPane("%4"), ["kill-pane", "-t", "%4"]],
		["sendKeys", (c) => c.sendKeys("%4", ["Left", "Left"]), ["send-keys", "-t", "%4", "Left", "Left"]],
		["exitCopyMode", (c) => c.exitCopyMode("%4"), ["send-keys", "-t", "%4", "-X", "cancel"]],
		["enterCopyMode", (c) => c.enterCopyMode("%4"), ["copy-mode", "-t", "%4"]],
		["copyModeHistoryBottom", (c) => c.copyModeHistoryBottom("%4"), ["send-keys", "-t", "%4", "-X", "history-bottom"]],
		["copyModeSearchBackwardText", (c) => c.copyModeSearchBackwardText("%4", "needle [x]"), ["send-keys", "-t", "%4", "-X", "search-backward-text", "needle [x]"]],
		["copyModeSearchStep older", (c) => c.copyModeSearchStep("%4", "older"), ["send-keys", "-t", "%4", "-X", "search-again"]],
		["copyModeSearchStep newer", (c) => c.copyModeSearchStep("%4", "newer"), ["send-keys", "-t", "%4", "-X", "search-reverse"]],
		["setOption", (c) => c.setOption("dev3-a", "pane-border-status", "top"), ["set-option", "-t", "dev3-a", "pane-border-status", "top"]],
		["setWindowHook", (c) => c.setWindowHook("dev3-a", "pane-exited", "run-shell x"), ["set-hook", "-wt", "dev3-a", "pane-exited", "run-shell x"]],
		["setEnvironment", (c) => c.setEnvironment("dev3-a", "K", "v"), ["set-environment", "-t", "dev3-a", "K", "v"]],
		["removeEnvironment", (c) => c.removeEnvironment("dev3-a", "K"), ["set-environment", "-r", "-t", "dev3-a", "K"]],
		["sourceFile", (c) => c.sourceFile("/tmp/conf"), ["source-file", "/tmp/conf"]],
	];

	for (const [name, run, expected] of CASES) {
		it(name, async () => {
			const { client, spawnFn } = makeClient();
			await run(client);
			expect(argvOf(spawnFn)).toEqual(["tmux", "-L", "dev3", ...expected]);
		});
	}
});

describe("capturePane", () => {
	it("captures with -p, optional -e escapes and -S/-E line bounds", async () => {
		const { client, spawnFn } = makeClient({ stdout: "line\n" });
		const out = await client.capturePane({ target: "%1", escapes: true, startLine: 5, endLine: 5 });
		expect(out).toBe("line\n");
		expect(argvOf(spawnFn)).toEqual([
			"tmux", "-L", "dev3", "capture-pane", "-p", "-e", "-t", "%1", "-S", "5", "-E", "5",
		]);
	});

	it("supports a plain capture without escapes or bounds", async () => {
		const { client, spawnFn } = makeClient({ stdout: "" });
		await client.capturePane({ target: "dev3-abc" });
		expect(argvOf(spawnFn)).toEqual(["tmux", "-L", "dev3", "capture-pane", "-p", "-t", "dev3-abc"]);
	});
});
