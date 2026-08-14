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
	PANE_RUN_COMMAND_MAX_LENGTH,
	PANE_RUN_TAIL_DEFAULT_LINES,
	PANE_RUN_TAIL_MAX_LINES,
	clampPaneRunTail,
	decodePaneRunStatus,
	isPaneRunId,
	isPaneRunLabel,
	paneRunCommandProblem,
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
	it("refuses an empty command", () => {
		expect(paneRunCommandProblem("")).toMatch(/empty/);
		expect(paneRunCommandProblem("   ")).toMatch(/empty/);
		expect(paneRunCommandProblem(undefined)).toMatch(/empty/);
	});

	it("refuses a newline, because the pane would run a second unreviewed command", () => {
		expect(paneRunCommandProblem("bun run build\nrm -rf .")).toMatch(/newline/);
		expect(paneRunCommandProblem("bun run build\r")).toMatch(/newline/);
		expect(paneRunCommandProblem("bun\0run")).toMatch(/NUL/);
	});

	it("refuses a command longer than the documented ceiling", () => {
		expect(paneRunCommandProblem("x".repeat(PANE_RUN_COMMAND_MAX_LENGTH))).toBeNull();
		expect(paneRunCommandProblem("x".repeat(PANE_RUN_COMMAND_MAX_LENGTH + 1))).toMatch(/longer than/);
	});

	it("passes an ordinary command with pipes and operators", () => {
		expect(paneRunCommandProblem("bun run build 2>&1 | grep error && echo ok")).toBeNull();
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

	it("returns the LAST lines and reports how many there were", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const tail = paneRunTail(text, 3);
		expect(tail.lines).toEqual(["line 7", "line 8", "line 9"]);
		expect(tail.totalLines).toBe(10);
	});

	it("strips escape sequences, so a progress-bar redraw cannot reach an agent's context", () => {
		const tail = paneRunTail("\u001b[2Kbuilding\u001b[0m\n", 10);
		expect(tail.lines).toEqual(["building"]);
	});

	it("trims the trailing blank line a log file always ends with", () => {
		expect(paneRunTail("only\n", 10)).toEqual({ lines: ["only"], totalLines: 1 });
	});
});

describe("the outcome line — a hung build must never read as a failed one", () => {
	it("names a still-running command and warns that a quiet tail is not an ending", () => {
		const line = paneRunOutcomeLine(view({ status: { ...view().status!, state: "running", exitCode: null, endedAt: null } }));
		expect(line).toMatch(/still running \(pid 42\)/);
		expect(line).toMatch(/empty tail means quiet, not finished/);
	});

	it("names the exit code of a finished command", () => {
		expect(paneRunOutcomeLine(view({ status: { ...view().status!, exitCode: 7 } }))).toBe("outcome: finished — exit code 7");
	});

	it("says a signal death is a signal death rather than inventing a code", () => {
		expect(paneRunOutcomeLine(view({ status: { ...view().status!, exitCode: null } }))).toMatch(/killed by a signal, no exit code/);
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

	it("keeps saying still-running while the pane is there", () => {
		const line = paneRunOutcomeLine(
			view({ paneId: "pane-2", status: { ...view().status!, state: "starting", exitCode: null, endedAt: null } }),
		);
		expect(line).toMatch(/^outcome: starting/);
	});

	it("reports an unknown status as unknown, never as not-running", () => {
		const line = paneRunOutcomeLine(view({ status: null, statusDetail: "the status file could not be believed" }));
		expect(line).toMatch(/^outcome: unknown/);
		expect(line).toMatch(/could not be believed/);
	});

	it("distinguishes a command that never started from one that failed", () => {
		const line = paneRunOutcomeLine(
			view({ status: { ...view().status!, state: "failed", detail: "SystemRoot is required" } }),
		);
		expect(line).toMatch(/never ran — SystemRoot is required/);
	});
});

describe("status decoding", () => {
	it("refuses a status that cannot be believed rather than filling in defaults", () => {
		expect(decodePaneRunStatus(null)).toBeNull();
		expect(decodePaneRunStatus({ runId: "nope", state: "running" })).toBeNull();
		expect(decodePaneRunStatus({ runId: "run-0123456789ab", state: "sprinting" })).toBeNull();
	});

	it("keeps a null exit code null — the signal case must survive the round trip", () => {
		const decoded = decodePaneRunStatus({ runId: "run-0123456789ab", state: "exited", exitCode: null });
		expect(decoded?.exitCode).toBeNull();
		expect(decoded?.state).toBe("exited");
	});
});

describe("rendering", () => {
	it("states that a tail was truncated, so a first error is not read as the first error", () => {
		const text = renderPaneRunLog(view({ lines: ["b", "c"], truncated: true, totalLines: 900 }));
		expect(text).toMatch(/showing the last 2 of 900 lines/);
	});

	it("marks a line count taken from a windowed log as a floor, not the whole file", () => {
		const text = renderPaneRunLog(view({ lines: ["b", "c"], truncated: true, totalLines: 900, logWindowed: true }));
		expect(text).toMatch(/showing the last 2 of 900\+ lines/);
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
});

describe("paneRunShell — the one place a shell dialect genuinely differs", () => {
	it("runs a POSIX command through sh -c, so pipes and && behave as typed", () => {
		expect(paneRunShell("bun run build | tee x", { platform: "darwin", env: {} })).toEqual({
			executable: "/bin/sh",
			argv: ["-c", "bun run build | tee x"],
		});
	});

	it("runs a Windows command through Windows PowerShell 5.1 under SystemRoot", () => {
		const spec = paneRunShell("bun run build", {
			platform: "win32",
			env: { SystemRoot: "C:\\Windows" },
		});
		expect(spec.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(spec.argv.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-Command"]);
	});

	it("pins the Windows child's output to UTF-8, because PowerShell 5.1 would use the console code page", () => {
		const script = paneRunShell("bun run build", { platform: "win32", env: { SystemRoot: "C:\\Windows" } }).argv[3];
		expect(script).toMatch(/\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
		expect(script).toMatch(/\$OutputEncoding = \[Console\]::OutputEncoding/);
	});

	it("propagates the Windows exit code explicitly — powershell -Command does not do it by itself", () => {
		const script = paneRunShell("bun run build", { platform: "win32", env: { WINDIR: "C:\\Windows" } }).argv[3];
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

	it("refuses to guess a PowerShell path when Windows names no SystemRoot", () => {
		expect(() => paneRunShell("echo hi", { platform: "win32", env: {} })).toThrow(/SystemRoot is required/);
	});
});
