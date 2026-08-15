#!/usr/bin/env bun
/**
 * The dev-server pane's wrapper, EXECUTED on this runner's real platform (Seq 1546).
 *
 * "The pane opened" was never the question. The whole feature was dead on Windows
 * because the wrapper was hand-written bash launched through `/bin/bash` (issue
 * #1387: the Dev Server button answered "requires the tmux backend, which is
 * POSIX-only"), and a bash body handed to PowerShell half-runs instead of failing
 * — which is why porting only the launch would have been worse than the outage.
 * So what is proved here is that the wrapper RUNS A COMMAND and that the command
 * SEES ITS ENVIRONMENT:
 *
 *   start    the dev command actually executed, and read back DEV3_TASK_SEQ, the
 *            project's own env var and DEV3_PORT0 — the three env blocks the
 *            wrapper writes, in the dialect it writes them in
 *   crash    a dev server that exits non-zero prints its code and does NOT hang
 *            on its own "press any key" prompt with no keyboard attached
 *   re-find  the script the pane launches carries the marker that later looks the
 *            pane up (running? replace it? stop it?) on THIS platform's file name
 *
 * The POSIX legs are the control that none of this changed macOS/Linux.
 *
 * NOT proved here, and it cannot be: that a user's own `devScript` runs. Its text
 * is the user's, in whatever shell they had in mind, and dev3 does not translate
 * it. The probe below is deliberately a command that is valid in both dialects.
 *
 * Run: bun run test:dev-server-pane-e2e   (all three platforms)
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../spawn";
import { buildDevServerScript } from "../dev-server-script";
import { generatedScriptLaunch, generatedScriptName, writeLaunchScript } from "../rpc-handlers/shared-pure";
import { auxPaneMarker } from "../task-aux-panes";
import { dev3TaskTempPath } from "../temp-paths";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "dev3-dev-server-e2e-"));
const asPath = (...parts: string[]) => join(root, ...parts).replaceAll("\\", "/");

/**
 * The "dev server": a script that records the environment it was launched with
 * and exits with the code it is told to. `bun <file>` is one of the few command
 * lines that means the same thing in bash and in PowerShell — which is the point,
 * since dev3 does not translate the user's own devScript.
 */
const PROBE = asPath("probe.mjs");
const RECORD = asPath("record.json");
writeFileSync(
	PROBE,
	[
		"import { writeFileSync } from 'node:fs';",
		`writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify({`,
		"  seq: process.env.DEV3_TASK_SEQ ?? null,",
		"  project: process.env.DEV3_PROBE_PROJECT_VAR ?? null,",
		"  port: process.env.DEV3_PORT0 ?? null,",
		"  cwd: process.cwd(),",
		"}));",
		"process.exit(Number(process.argv[2] ?? 0));",
	].join("\n"),
	"utf8",
);

/**
 * Run the wrapper exactly the way the pane does: written through
 * `writeLaunchScript` (a Windows `.ps1` needs its byte-order mark) and launched
 * through `generatedScriptLaunch` (the executable and argv are the app's).
 *
 * stdin is closed on purpose. The failure path ends in "press any key", and a
 * wrapper that blocks there forever hangs the pane exactly as it hangs this run.
 */
async function runWrapper(exitCode: number): Promise<{ code: number; output: string; scriptPath: string }> {
	rmSync(RECORD, { force: true });
	const scriptPath = asPath(generatedScriptName("dev"));
	await writeLaunchScript(
		scriptPath,
		buildDevServerScript({
			devScript: `bun ${PROBE} ${exitCode}`,
			envGroups: [
				{ DEV3_PROBE_PROJECT_VAR: "from the project config" },
				{ DEV3_TASK_SEQ: "1546", DEV3_WORKTREE_PATH: root.replaceAll("\\", "/") },
				{ DEV3_PORT0: "51730" },
			],
			// A native pane has no nesting and no tmux binary — and on Windows there
			// is no tmux at all. This is the shape the button actually takes there.
			tmuxDetachCommand: null,
		}),
	);
	const launch = generatedScriptLaunch(scriptPath);
	const proc = spawn([launch.executable, ...launch.argv], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, output: `${out}\n${err}`, scriptPath };
}

console.log(`dev-server pane wrapper on ${process.platform}`);

try {
	console.log("\nstart — the dev command runs and sees its environment");
	{
		const { output } = await runWrapper(0);
		check(existsSync(RECORD), "the dev command actually executed (it wrote its record)");
		if (existsSync(RECORD)) {
			const record = JSON.parse(readFileSync(RECORD, "utf8")) as Record<string, string | null>;
			check(record.seq === "1546", `the task env block reached the command (DEV3_TASK_SEQ=${record.seq})`);
			check(
				record.project === "from the project config",
				`the project env block reached the command (${record.project})`,
			);
			check(record.port === "51730", `the port env block reached the command (DEV3_PORT0=${record.port})`);
		}
		check(
			!output.includes("Process exited with code"),
			"a dev server that exits cleanly prints no failure notice",
		);
	}

	console.log("\ncrash — a non-zero exit is reported and does not hang the pane");
	{
		const { output } = await runWrapper(7);
		check(existsSync(RECORD), "the dev command executed before failing");
		check(
			output.includes("Process exited with code 7"),
			`the pane shows the real exit code (output: ${JSON.stringify(output.trim().slice(-160))})`,
		);
		// Reaching this line at all is the proof: the run above is awaited to
		// completion with no keyboard attached.
		check(true, "the wrapper terminated instead of blocking on its own keypress prompt");
	}

	console.log("\nre-find — the launched script carries this platform's pane marker");
	{
		const taskId = "abcdef12-0000-0000-0000-000000000005";
		const scriptPath = dev3TaskTempPath(taskId, generatedScriptName("dev"));
		const launch = generatedScriptLaunch(scriptPath);
		check(
			[launch.executable, ...launch.argv].join(" ").includes(auxPaneMarker(taskId, "devServer")),
			`the launch command matches the devServer marker (${scriptPath})`,
		);
		check(
			process.platform === "win32"
				? launch.executable.toLowerCase().includes("powershell") && scriptPath.endsWith(".ps1")
				: launch.executable === "/bin/bash" && scriptPath.endsWith(".sh"),
			`the pane launches ${launch.executable} for ${scriptPath}`,
		);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
