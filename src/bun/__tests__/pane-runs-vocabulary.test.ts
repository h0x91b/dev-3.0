/**
 * The pure rules of a pane run (seq 1538): what a command must survive before a
 * pane is opened, how a bounded tail is taken, what an outcome line says, and how
 * ONE command string becomes a process on each shell dialect.
 *
 * The Windows dialect is asserted here because it cannot be asserted from a macOS
 * run of the real thing — the dialect is the part a POSIX-shaped assumption breaks.
 */
import { describe, it, expect } from "vitest";
import {
	PANE_RUN_AUTO_CLOSE_SECONDS,
	PANE_RUN_COMMAND_MAX_LENGTH,
	PANE_RUN_FAILED_AUTO_CLOSE_SECONDS,
	PANE_RUN_TAIL_DEFAULT_LINES,
	PANE_RUN_TAIL_MAX_LINES,
	clampPaneRunTail,
	decodePaneRunStatus,
	isPaneRunId,
	isPaneRunLabel,
	paneRunCommandProblem,
	paneRunDismissal,
	paneRunOutcomeLine,
	paneRunTail,
	renderPaneRunListing,
	renderPaneRunLog,
	type PaneRunView,
} from "../../shared/pane-runs";
import { paneRunShell } from "../pane-run-store";

function view(overrides: Partial<PaneRunView> = {}): PaneRunView {
	return {
		runId: "run-0123456789ab",
		label: "Build",
		command: "bun run build",
		paneId: "pane-2",
		backend: "native",
		status: {
			runId: "run-0123456789ab",
			state: "exited",
			pid: 42,
			exitCode: 0,
			startedAt: "2026-08-14T10:00:00.000Z",
			endedAt: "2026-08-14T10:01:00.000Z",
			detail: null,
		},
		statusDetail: null,
		logPath: "/tmp/dev3-x-pane-runs/run-0123456789ab.log",
		lines: ["done"],
		truncated: false,
		totalLines: 1,
		...overrides,
	};
}

describe("run ids and labels", () => {
	it("accepts only the minted shape, so a run id can safely appear in a file name and an argv", () => {
		expect(isPaneRunId("run-0123456789ab")).toBe(true);
		expect(isPaneRunId("run-0123456789AB")).toBe(false);
		expect(isPaneRunId("run-0123456789")).toBe(false);
		expect(isPaneRunId("../run-0123456789ab")).toBe(false);
		expect(isPaneRunId(42)).toBe(false);
	});

	it("keeps a label to plain human text", () => {
		expect(isPaneRunLabel("Dev server")).toBe(true);
		expect(isPaneRunLabel("build-2.1_x")).toBe(true);
		expect(isPaneRunLabel("$(rm -rf /)")).toBe(false);
		expect(isPaneRunLabel("")).toBe(false);
		expect(isPaneRunLabel("x".repeat(41))).toBe(false);
	});
});

describe("commands a pane must never be opened for", () => {
	it("refuses an empty or over-long command and passes an ordinary one with pipes and operators", () => {
		expect(paneRunCommandProblem("")).toMatch(/empty/);
		expect(paneRunCommandProblem("   ")).toMatch(/empty/);
		expect(paneRunCommandProblem(undefined)).toMatch(/empty/);
		expect(paneRunCommandProblem("x".repeat(PANE_RUN_COMMAND_MAX_LENGTH))).toBeNull();
		expect(paneRunCommandProblem("x".repeat(PANE_RUN_COMMAND_MAX_LENGTH + 1))).toMatch(/longer than/);
		expect(paneRunCommandProblem("bun run build 2>&1 | grep error && echo ok")).toBeNull();
	});

	it("refuses a newline, because the pane would run a second unreviewed command", () => {
		expect(paneRunCommandProblem("bun run build\nrm -rf .")).toMatch(/newline/);
		expect(paneRunCommandProblem("bun run build\r")).toMatch(/newline/);
		expect(paneRunCommandProblem("bun\0run")).toMatch(/NUL/);
	});
});

describe("bounded reads", () => {
	it("clamps a tail into the documented window instead of refusing it", () => {
		expect(clampPaneRunTail(undefined)).toBe(PANE_RUN_TAIL_DEFAULT_LINES);
		expect(clampPaneRunTail(0)).toBe(1);
		expect(clampPaneRunTail(-5)).toBe(1);
		expect(clampPaneRunTail(PANE_RUN_TAIL_MAX_LINES + 10_000)).toBe(PANE_RUN_TAIL_MAX_LINES);
		expect(clampPaneRunTail("50")).toBe(50);
	});

	it("returns the LAST lines with the total, stripping escape sequences and the trailing blank line", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		expect(paneRunTail(text, 3)).toEqual({ lines: ["line 7", "line 8", "line 9"], totalLines: 10 });
		// A progress-bar redraw must not reach an agent's context.
		expect(paneRunTail("\u001b[2Kbuilding\u001b[0m\n", 10).lines).toEqual(["building"]);
		// A log file always ends with a newline.
		expect(paneRunTail("only\n", 10)).toEqual({ lines: ["only"], totalLines: 1 });
	});
});

describe("the outcome line — a hung build must never read as a failed one", () => {

	it("names a running, finished, signalled, starting, unknown or never-started run for what it is", () => {
		const base = view().status!;
		const cases: Array<[name: string, run: PaneRunView, expected: RegExp]> = [
			["still running", view({ status: { ...base, state: "running", exitCode: null, endedAt: null } }), /still running \(pid 42\)/],
			// A quiet tail is not an ending.
			["still running warns", view({ status: { ...base, state: "running", exitCode: null, endedAt: null } }), /empty tail means quiet, not finished/],
			// Unknown, never not-running.
			["unknown status", view({ status: null, statusDetail: "the status file could not be believed" }), /^outcome: unknown.*could not be believed/s],
			["exit code", view({ status: { ...base, exitCode: 7 } }), /^outcome: finished — exit code 7$/],
			["signal death", view({ status: { ...base, exitCode: null } }), /killed by a signal, no exit code/],
			["starting while the pane is there", view({ paneId: "pane-2", status: { ...base, state: "starting", exitCode: null, endedAt: null } }), /^outcome: starting/],
			["never started", view({ status: { ...base, state: "failed", detail: "SystemRoot is required" } }), /never ran — SystemRoot is required/],
		];
		for (const [name, run, expected] of cases) {
			expect(paneRunOutcomeLine(run), name).toMatch(expected);
		}
	});

	it("reports a run whose pane is gone as stopped, not as still running", () => {
		// `dev3 pane close` kills the pane, which kills the runner before it can write
		// a final status. Believing that stale file leaves an agent waiting forever.
		const line = paneRunOutcomeLine(
			view({ paneId: "", status: { ...view().status!, state: "running", exitCode: null, endedAt: null } }),
		);
		expect(line).toMatch(/^outcome: gone/);
		expect(line).not.toMatch(/still running/);
	});
});

describe("status decoding", () => {
	it("refuses a status that cannot be believed rather than filling in defaults, and keeps a null exit code null", () => {
		expect(decodePaneRunStatus(null)).toBeNull();
		expect(decodePaneRunStatus({ runId: "nope", state: "running" })).toBeNull();
		expect(decodePaneRunStatus({ runId: "run-0123456789ab", state: "sprinting" })).toBeNull();
		// The signal case must survive the round trip.
		const decoded = decodePaneRunStatus({ runId: "run-0123456789ab", state: "exited", exitCode: null });
		expect(decoded?.exitCode).toBeNull();
		expect(decoded?.state).toBe("exited");
	});
});

describe("what a finished pane does with itself", () => {
	it("closes a clean run on the short timer and a failed one on the long window, saying how long it has", () => {
		const clean = paneRunDismissal(0);
		expect(clean.autoCloseMs).toBe(PANE_RUN_AUTO_CLOSE_SECONDS * 1000);
		expect(clean.message).toContain(`${PANE_RUN_AUTO_CLOSE_SECONDS}s`);
		// A failed run's output is the whole point.
		const failed = paneRunDismissal(1);
		expect(failed.autoCloseMs).toBe(PANE_RUN_FAILED_AUTO_CLOSE_SECONDS * 1000);
		expect(failed.message).toContain("30m");
		expect(failed.autoCloseMs).toBeGreaterThan(clean.autoCloseMs * 10);
	});

	it("bounds every outcome and treats an unreadable one as a failure, never as a success", () => {
		for (const exitCode of [0, 1, 137, null]) {
			expect(paneRunDismissal(exitCode).autoCloseMs, String(exitCode)).toBeGreaterThan(0);
		}
		// null is what a signal death writes: killed is not clean.
		expect(paneRunDismissal(null).autoCloseMs).toBe(PANE_RUN_FAILED_AUTO_CLOSE_SECONDS * 1000);
	});
});

describe("rendering", () => {
	it("states that a tail was truncated, and marks a count from a windowed log as a floor", () => {
		// So a first error is not read as the first error.
		expect(renderPaneRunLog(view({ lines: ["b", "c"], truncated: true, totalLines: 900 }))).toMatch(/showing the last 2 of 900 lines/);
		expect(renderPaneRunLog(view({ lines: ["b", "c"], truncated: true, totalLines: 900, logWindowed: true }))).toMatch(/showing the last 2 of 900\+ lines/);
	});

	it("names the backend and the screen-read limit in the listing", () => {
		const text = renderPaneRunListing({
			backend: "native",
			screenReadable: false,
			screenReadableDetail: "the native backend publishes no screen snapshot",
			selfPaneId: "pane-1",
			panes: [
				{ paneId: "pane-1", index: 1, label: "zsh", active: true, self: true, alive: true, runId: null },
				{ paneId: "pane-2", index: 2, label: "dev3 __pane-run", active: false, self: false, alive: true, runId: "run-0123456789ab" },
			],
			runs: [view()],
		});
		expect(text).toMatch(/terminal backend: native/);
		expect(text).toMatch(/NOT readable/);
		expect(text).toMatch(/pane-1 zsh \[you, active\]/);
		expect(text).toMatch(/pane-2 dev3 __pane-run \[run run-0123456789ab\]/);
	});

	it("marks each agent pane with its role and the handle `dev3 message --agent` takes", () => {
		const text = renderPaneRunListing({
			backend: "tmux",
			screenReadable: true,
			screenReadableDetail: "",
			selfPaneId: "%1",
			panes: [
				{ paneId: "%1", index: 1, label: "bash cmd.sh", active: false, self: true, alive: null, runId: null, agentRole: "main", agentHandle: "AiEB" },
				{ paneId: "%3", index: 2, label: "bash col-agent.sh", active: false, self: false, alive: null, runId: null, agentRole: "review", agentHandleUnavailable: "the agent in pane %3 has exited" },
				{ paneId: "%4", index: 3, label: "zsh", active: false, self: false, alive: null, runId: null },
			],
			runs: [],
		});
		expect(text).toContain("1. %1 bash cmd.sh [main agent, you]\n     message it: --agent AiEB\n");
		expect(text).toContain("2. %3 bash col-agent.sh [AI Review agent]\n     no --agent handle: the agent in pane %3 has exited\n");
		expect(text).toMatch(/3\. %4 zsh\n\nruns:/);
	});
});

describe("paneRunShell — the one place a shell dialect genuinely differs", () => {
	it("runs a POSIX command through sh -c, so pipes and && behave as typed", () => {
		expect(paneRunShell("bun run build | tee x", { platform: "darwin", env: {} })).toEqual({
			executable: "/bin/sh",
			argv: ["-c", "bun run build | tee x"],
		});
	});

	it("runs a Windows command through Windows PowerShell 5.1 under SystemRoot, UTF-8 output, exit code propagated", () => {
		const spec = paneRunShell("bun run build", { platform: "win32", env: { SystemRoot: "C:\\Windows" } });
		expect(spec.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(spec.argv.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-Command"]);
		const script = spec.argv[3];
		// PowerShell 5.1 would otherwise use the console code page.
		expect(script).toMatch(/\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
		expect(script).toMatch(/\$OutputEncoding = \[Console\]::OutputEncoding/);
		// powershell -Command does not propagate the exit code by itself.
		expect(script).toContain("; bun run build; ");
		expect(script).toContain("$dev3Code = $LASTEXITCODE");
		expect(script.endsWith("exit $dev3Code")).toBe(true);
	});

	it("falls back to $? when nothing set $LASTEXITCODE, so a mistyped command cannot exit 0", () => {
		const script = paneRunShell("nosuchtool", { platform: "win32", env: { WINDIR: "C:\\Windows" } }).argv[3];
		// A cmdlet or a command that was never found leaves $LASTEXITCODE null, and a
		// bare `exit $LASTEXITCODE` would turn "never ran" into "exit code 0".
		expect(script).not.toMatch(/;\s*exit \$LASTEXITCODE\s*$/);
		expect(script).toContain("if ($null -eq $dev3Code) { if ($dev3Ok) { exit 0 } else { exit 1 } }");
		// $? is captured BEFORE anything else runs, or it would describe our own read.
		expect(script.indexOf("$dev3Ok = $?")).toBeLessThan(script.indexOf("$dev3Code = $LASTEXITCODE"));
	});

	// Proved on windows-latest: PowerShell 5.1 without %SystemRoot% dies with
	// "Internal Windows PowerShell error ... 8009001d" and exits 0, so a PATH
	// fallback would hand the agent a silent no-op instead of this named refusal.
	it("refuses to guess a PowerShell path when Windows names no SystemRoot", () => {
		expect(() => paneRunShell("echo hi", { platform: "win32", env: {} })).toThrow(/SystemRoot is required/);
	});
});
