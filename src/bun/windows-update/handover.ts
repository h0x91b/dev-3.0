import { spawnSync } from "../spawn";

/**
 * Hand the swap script to Task Scheduler so it outlives our own process tree.
 *
 * The `/tr` value carries a quoted path through an argv array into a native
 * Windows command line — the boundary where this project's last Windows-only
 * failure lived (Git Bash handed bun an MSYS path). Kept in one function so the
 * Windows e2e drives exactly what production drives.
 */
export function scheduleSwapScript(scriptPath: string, taskName: string): { ok: boolean; error?: string } {
	const scriptPathWin = scriptPath.replace(/\//g, "\\");
	const create = spawnSync([
		"schtasks",
		"/create",
		"/tn",
		taskName,
		"/tr",
		`cmd /c "${scriptPathWin}"`,
		"/sc",
		"once",
		"/st",
		"00:00",
		"/f",
	]);
	if (create.exitCode !== 0) {
		return { ok: false, error: `schtasks /create failed (${create.exitCode}): ${create.stderr?.toString() ?? ""}` };
	}
	// Task Scheduler refuses to start a task on battery by default, and it refuses
	// silently — the app quits, the swap never runs, nothing reports a failure.
	// (Same script, reported upstream as blackboardsh/electrobun#300.) Best effort:
	// a machine that will not let us relax the condition still gets the /run below.
	spawnSync([
		"powershell",
		"-NoProfile",
		"-Command",
		`Set-ScheduledTask -TaskName '${taskName}' -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries)`,
	]);

	const run = spawnSync(["schtasks", "/run", "/tn", taskName]);
	if (run.exitCode !== 0) {
		return { ok: false, error: `schtasks /run failed (${run.exitCode}): ${run.stderr?.toString() ?? ""}` };
	}
	return { ok: true };
}
