/**
 * Where a pane run's three files live, and how the command inside one is spelled
 * for the platform's own shell.
 *
 * ON-DISK CHOICE, deliberate: a run's files go to the OS temp directory, under the
 * same `dev3-<taskId>-…` prefix the auxiliary-pane launch scripts already use.
 *  • NOT the task worktree — a log there would show up in `git status` and in the
 *    diff the user reviews.
 *  • NOT `~/.dev3.0` — that directory is shared with every other installed version
 *    of the app (see the on-disk invariants in AGENTS.md), and a run log is
 *    per-process scratch with no reason to be durable or discoverable there.
 * A run is scratch by construction: the pane it belongs to dies with the task.
 *
 * The app and the in-pane runner are two different processes, so nothing is
 * derived twice: the app mints the directory and passes it to the runner in argv.
 */

import { win32 as pathWin32 } from "node:path";
import { dev3TaskTempPath } from "./temp-paths";

/** The directory holding every run of one task. Created by the app, never by the runner. */
export function paneRunDir(taskId: string): string {
	return dev3TaskTempPath(taskId, "pane-runs");
}

export function paneRunSpecPath(dir: string, runId: string): string {
	return `${dir}/${runId}.run.json`;
}

export function paneRunStatusPath(dir: string, runId: string): string {
	return `${dir}/${runId}.status.json`;
}

export function paneRunLogPath(dir: string, runId: string): string {
	return `${dir}/${runId}.log`;
}

/**
 * The internal CLI verb the pane's process runs. Hidden from `--help` on purpose:
 * it is dev3 talking to itself, and a user invoking it by hand would be running a
 * run that no task asked for.
 */
export const PANE_RUN_VERB = "__pane-run";

/**
 * PowerShell 5.1 hands a pipe whatever the console code page is (CP866 / CP1251 on
 * a localized Windows), so a log written from those bytes decodes as mojibake. The
 * prelude pins the child's output to UTF-8 before the command runs — the one place
 * in this feature where a shell dialect genuinely differs, and it is authored per
 * dialect rather than assumed from POSIX.
 */
const POWERSHELL_UTF8_PRELUDE =
	"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding";

/**
 * How the command's outcome becomes the process's exit code.
 *
 * `$LASTEXITCODE` is set by NATIVE commands only: a mistyped command, or one that
 * is a PowerShell cmdlet, leaves it `$null`, and a bare `exit $LASTEXITCODE` turns
 * that into exit 0 — an agent would read "the build never ran" as "the build
 * passed". `$?` is the fallback that covers those, and both are captured into
 * variables FIRST because `$?` describes only the statement right before it.
 */
const POWERSHELL_EXIT_EPILOGUE =
	"$dev3Ok = $?; $dev3Code = $LASTEXITCODE; if ($null -eq $dev3Code) { if ($dev3Ok) { exit 0 } else { exit 1 } }; exit $dev3Code";

export interface PaneRunShellSpec {
	readonly executable: string;
	readonly argv: readonly string[];
}

export interface PaneRunShellLookup {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * How ONE command string becomes an executable plus argv on this platform.
 *
 * POSIX runs it through `sh -c`, so pipes and `&&` behave as the agent typed them.
 * Windows runs it through Windows PowerShell 5.1 — the same shell a native pane
 * opens by default — with the encoding prelude and an explicit `exit`, because
 * `powershell -Command` does not otherwise propagate a native command's exit code.
 */
export function paneRunShell(command: string, lookup: PaneRunShellLookup): PaneRunShellSpec {
	if (lookup.platform === "win32") {
		const systemRoot = lookup.env.SystemRoot ?? lookup.env.SYSTEMROOT ?? lookup.env.WINDIR;
		if (!systemRoot) throw new Error("SystemRoot is required to run a pane command on Windows");
		return {
			executable: pathWin32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			argv: [
				"-NoLogo",
				"-NoProfile",
				"-Command",
				`${POWERSHELL_UTF8_PRELUDE}; ${command}; ${POWERSHELL_EXIT_EPILOGUE}`,
			],
		};
	}
	return { executable: "/bin/sh", argv: ["-c", command] };
}
