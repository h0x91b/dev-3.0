import { describe, expect, it } from "vitest";
import { DEFAULT_SNAPSHOT_SCROLLBACK_CAP } from "../../native-terminal-registry/live-parser";
import {
	busyForegroundCommand,
	DEFAULT_SOAK_WORKLOAD,
	doneMarker,
	longLivedGrandchildCommands,
	nestedShellCommand,
	reportPidCommand,
	SHORT_SOAK_WORKLOAD,
	soakWorkloadCommand,
	SOAK_DONE_PREFIX,
} from "../workload";

describe("soak workload", () => {
	it("is byte-identical for the same shape and tag", () => {
		const first = soakWorkloadCommand(DEFAULT_SOAK_WORKLOAD, "burst-0", "linux");
		const second = soakWorkloadCommand(DEFAULT_SOAK_WORKLOAD, "burst-0", "linux");
		expect(first).toBe(second);
	});

	it("gives every tag its own completion marker", () => {
		expect(soakWorkloadCommand(SHORT_SOAK_WORKLOAD, "cyc1", "linux")).toContain(`${SOAK_DONE_PREFIX}cyc1`);
		expect(soakWorkloadCommand(SHORT_SOAK_WORKLOAD, "cyc2", "linux")).not.toContain(`${SOAK_DONE_PREFIX}cyc1`);
		expect(doneMarker("cyc2")).toBe(`${SOAK_DONE_PREFIX}cyc2`);
	});

	it("emits alt-screen, colour, and carriage-return redraws on both platforms", () => {
		const posix = soakWorkloadCommand(SHORT_SOAK_WORKLOAD, "t", "darwin");
		expect(posix).toContain("\\033[?1049h");
		expect(posix).toContain("\\033[?1049l");
		expect(posix).toContain("\\033[36m");
		expect(posix).toContain("\\r");

		const windows = soakWorkloadCommand(SHORT_SOAK_WORKLOAD, "t", "win32");
		expect(windows).toContain("$e=[char]27");
		expect(windows).toContain("$e[?1049h");
		expect(windows).toContain("$e[?1049l");
		expect(windows).toContain("`r");
		// PowerShell 5.1 has no "`e" escape sequence — using it would print literally.
		expect(windows).not.toContain("`e[");
	});

	it("over-fills the parser core scrollback so cycle samples measure a saturated host", () => {
		expect(DEFAULT_SOAK_WORKLOAD.lines).toBeGreaterThan(1_000);
		expect(DEFAULT_SOAK_WORKLOAD.lines).toBeGreaterThan(DEFAULT_SNAPSHOT_SCROLLBACK_CAP);
		expect(SHORT_SOAK_WORKLOAD.lines).toBeLessThan(DEFAULT_SOAK_WORKLOAD.lines);
	});

	it("rejects a tag or shape that could escape the shell command", () => {
		expect(() => soakWorkloadCommand(SHORT_SOAK_WORKLOAD, "'; rm -rf /; echo '", "linux")).toThrow(/unsafe soak tag/);
		expect(() => soakWorkloadCommand(SHORT_SOAK_WORKLOAD, "", "linux")).toThrow(/unsafe soak tag/);
		expect(() => soakWorkloadCommand({ ...SHORT_SOAK_WORKLOAD, lines: -1 }, "t", "linux")).toThrow(/lines/);
		expect(() => soakWorkloadCommand({ ...SHORT_SOAK_WORKLOAD, lines: 1.5 }, "t", "linux")).toThrow(/lines/);
		expect(() => reportPidCommand("bad label", "linux")).toThrow(/unsafe soak tag/);
	});

	it("reports PIDs and spawns descendants with platform-correct syntax", () => {
		expect(reportPidCommand("SOAKCHILD", "linux")).toBe('echo "SOAKCHILD[$$]"');
		expect(reportPidCommand("SOAKCHILD", "win32")).toBe('Write-Output "SOAKCHILD[$PID]"');
		expect(nestedShellCommand("linux")).toContain("bash");
		expect(nestedShellCommand("win32")).toContain("powershell.exe");
		expect(longLivedGrandchildCommands("SOAKGRAND", 30, "linux")).toEqual([
			"set +H",
			"sleep 30 &",
			'echo "SOAKGRAND[$!]"',
		]);
		expect(longLivedGrandchildCommands("SOAKGRAND", 30, "win32")).toHaveLength(1);
		expect(longLivedGrandchildCommands("SOAKGRAND", 30, "win32")[0]).toContain("Start-Process -PassThru");
	});

	it("keeps the crashed shell busy in the foreground rather than idle at a prompt", () => {
		expect(busyForegroundCommand("SOAKBUSY", "linux")).toContain("while :;");
		expect(busyForegroundCommand("SOAKBUSY", "linux")).toContain("SOAKBUSY:");
		expect(busyForegroundCommand("SOAKBUSY", "win32")).toContain("while ($true)");
	});

	it("never invokes tmux", () => {
		const commands = [
			soakWorkloadCommand(DEFAULT_SOAK_WORKLOAD, "t", "linux"),
			soakWorkloadCommand(DEFAULT_SOAK_WORKLOAD, "t", "win32"),
			nestedShellCommand("linux"),
			nestedShellCommand("win32"),
			busyForegroundCommand("B", "linux"),
			...longLivedGrandchildCommands("G", 1, "linux"),
		];
		for (const command of commands) expect(command).not.toMatch(/tmux/i);
	});
});
