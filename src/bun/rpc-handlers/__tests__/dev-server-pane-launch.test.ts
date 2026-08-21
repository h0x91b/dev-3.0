/**
 * How the dev-server pane is LAUNCHED, and where it refuses (Seq 1546).
 *
 * `runDevServer` used to refuse on Windows before it read anything — Arseny's
 * own box answered the Dev Server button with "the dev-server pane requires the
 * tmux backend, which is POSIX-only" (issue #1387). The refusal belonged to the
 * NESTED TMUX SESSION the tmux backend hosts the server in, not to the pane, and
 * a native task has neither.
 *
 * Sibling of `git-op-pane-launch.test.ts`: the E2E that executes the wrapper
 * calls `generatedScriptLaunch` itself, so it stays green while the call site
 * hands the pane a hardcoded `/bin/bash`. The script and the launch are two
 * separate things and each needs its own proof.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	openAuxPane: vi.fn(),
	writeLaunchScript: vi.fn(async (_scriptPath: string, _body: string) => {}),
	resolveOperationalProjectConfig: vi.fn(),
	newSessionDetached: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

vi.mock("../shared", () => ({
	getPushMessage: () => null,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: vi.fn(),
}));

vi.mock("../settings-config", () => ({
	resolveOperationalProjectConfig: mocks.resolveOperationalProjectConfig,
}));

vi.mock("../../task-aux-panes", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-aux-panes")>()),
	openAuxPane: mocks.openAuxPane,
	auxPaneAlive: vi.fn(async () => false),
	closeAuxPane: vi.fn(),
	findAuxPane: vi.fn(async () => null),
	nativeAuxPaneShellPid: vi.fn(async () => null),
}));

vi.mock("../shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared-pure")>()),
	writeLaunchScript: mocks.writeLaunchScript,
}));

vi.mock("../../tmux", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tmux")>();
	return {
		...actual,
		tmux: {
			...actual.tmux,
			binaryPath: () => "/opt/homebrew/bin/tmux",
			hasSession: vi.fn(async () => false),
			newSessionDetached: mocks.newSessionDetached,
			splitWindow: vi.fn(async () => ({ paneId: "%3" })),
			selectPane: vi.fn(async () => {}),
			setOption: vi.fn(async () => {}),
			listPanes: vi.fn(async () => []),
			killPane: vi.fn(async () => {}),
			killSession: vi.fn(async () => {}),
		},
	};
});

vi.mock("../../port-scanner", () => ({
	findPortHolders: vi.fn(async () => []),
	waitForPortsFree: vi.fn(async () => []),
	getLsofOutput: vi.fn(async () => ""),
	parseLsofOutput: () => [],
	buildProcessTree: vi.fn(async () => new Map()),
	collectDescendants: () => [],
	getSessionPanePids: vi.fn(async () => []),
	collectTaskPids: vi.fn(async () => new Set()),
	scanTaskPorts: vi.fn(async () => []),
	getPortsForTask: () => [],
	getResourceUsage: () => undefined,
	clearDevServerSummaryForTask: vi.fn(),
	schedulePortScanSoon: vi.fn(),
	clearPortDataForTask: vi.fn(),
	getPidCwd: vi.fn(async () => null),
	terminatePidsVerified: vi.fn(async () => []),
}));

import { runDevServer } from "../tmux-pty";

const PROJECT = { id: "proj-1", name: "p", path: "/repo", defaultBaseBranch: "main" } as any;
/** Windows stamps every new task `native` (`newTaskTerminalBackend`). */
const NATIVE_TASK = {
	id: "abcdef12-0000-0000-0000-000000000004",
	title: "Run the dev server",
	worktreePath: "/repo/wt",
	terminalBackend: "native",
	tmuxSocket: "dev3",
} as any;
const TMUX_TASK = { ...NATIVE_TASK, terminalBackend: "tmux" } as any;
const isWindows = process.platform === "win32";

/**
 * Await INSIDE the platform override, not around it: `runDevServer` reads
 * `process.platform` after its first await, so a synchronous restore would put
 * the platform back before the code under test ever looks at it.
 */
async function asWindows<T>(run: () => Promise<T>): Promise<T> {
	const real = process.platform;
	const realSystemRoot = process.env.SystemRoot;
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	process.env.SystemRoot ??= "C:\\Windows";
	try {
		return await run();
	} finally {
		Object.defineProperty(process, "platform", { value: real, configurable: true });
		if (realSystemRoot === undefined) delete process.env.SystemRoot;
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(NATIVE_TASK);
	mocks.resolveOperationalProjectConfig.mockResolvedValue({ devScript: "bun run dev", env: {}, portCount: 0 });
	mocks.openAuxPane.mockResolvedValue({ backend: "native", paneId: "%9" });
});

describe(`dev-server pane launch on ${process.platform}`, () => {
	it("never hands the pane a POSIX shell path that cannot exist here", async () => {
		await runDevServer({ taskId: NATIVE_TASK.id, projectId: PROJECT.id });
		const launch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
		if (isWindows) {
			expect(launch.executable).not.toBe("/bin/bash");
			expect(launch.executable).not.toMatch(/^\/bin\//);
			expect(launch.executable).toMatch(/(powershell|pwsh)(\.exe)?$/i);
			expect(launch.argv).toContain("-File");
			expect(launch.argv[launch.argv.length - 1]).toMatch(/\.ps1$/);
		} else {
			// The POSIX control: byte-identical to the literal it replaced.
			expect(launch.executable).toBe("/bin/bash");
			expect(launch.argv).toEqual([launch.argv[0]]);
			expect(launch.argv[0]).toMatch(/\.sh$/);
		}
	});

	it("writes the wrapper to the very path the pane launches", async () => {
		await runDevServer({ taskId: NATIVE_TASK.id, projectId: PROJECT.id });
		const launch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
		expect(mocks.writeLaunchScript.mock.calls.map(([path]) => String(path)))
			.toContain(launch.argv[launch.argv.length - 1]);
	});

	it("writes a wrapper in this platform's dialect, not hand-written bash", async () => {
		await runDevServer({ taskId: NATIVE_TASK.id, projectId: PROJECT.id });
		const body = String(mocks.writeLaunchScript.mock.calls[0][1]);
		if (isWindows) expect(body).not.toContain("#!/bin/bash");
		else expect(body.startsWith("#!/bin/bash\n")).toBe(true);
	});

	it("launches the pane on a native task when the platform reports win32", async () => {
		await asWindows(() => runDevServer({ taskId: NATIVE_TASK.id, projectId: PROJECT.id }));
		expect(mocks.openAuxPane).toHaveBeenCalledTimes(1);
		const launch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
		expect(launch.executable).toMatch(/(powershell|pwsh)(\.exe)?$/i);
		expect(launch.argv).toContain("-File");
		// `-File` on a `.sh` is not a PowerShell script: the NAME has to move with
		// the dialect, not just the interpreter.
		expect(launch.argv[launch.argv.length - 1]).toMatch(/\.ps1$/);
		// The refusal Arseny saw must be gone from the native path entirely.
		expect(String(mocks.writeLaunchScript.mock.calls[0][1])).not.toContain("#!/bin/bash");
	});

	it("still refuses the NESTED TMUX SESSION on Windows instead of half-running it", async () => {
		mocks.getTask.mockResolvedValue(TMUX_TASK);
		await expect(asWindows(() => runDevServer({ taskId: TMUX_TASK.id, projectId: PROJECT.id })))
			.rejects.toThrow(/tmux backend, which is POSIX-only/);
		expect(mocks.newSessionDetached).not.toHaveBeenCalled();
	});

	// The marker re-finds the pane later (is it running, replace it, stop it) by
	// substring-matching the launch command. An extension in it matches nothing on
	// the other platform, so the pane launches and is then invisible forever.
	it("re-finds the pane it just launched, on either platform's script name", async () => {
		const { auxPaneMarker } = await import("../../task-aux-panes");
		await asWindows(() => runDevServer({ taskId: NATIVE_TASK.id, projectId: PROJECT.id }));
		const windowsLaunch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
		expect(windowsLaunch.argv.join(" ")).toContain(auxPaneMarker(NATIVE_TASK.id, "devServer"));

		mocks.openAuxPane.mockClear();
		await runDevServer({ taskId: NATIVE_TASK.id, projectId: PROJECT.id });
		const nativeLaunch = mocks.openAuxPane.mock.calls[0][0].nativeLaunch;
		expect(nativeLaunch.argv.join(" ")).toContain(auxPaneMarker(NATIVE_TASK.id, "devServer"));
	});
});
