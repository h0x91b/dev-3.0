/**
 * Electrobun `preBuild` hook: make sure the build folder can actually be deleted.
 *
 * Electrobun opens every build with `rmSync(buildFolder, { recursive: true })`
 * (electrobun 1.18.1 `src/cli/index.ts`, immediately after `runHook("preBuild")`)
 * — no `force`, no retries. On Windows that throws `EBUSY` whenever anything still
 * holds the folder, and something usually does: `runApp` launches the dev app with
 * `cwd` set to `build/<prefix>/<app>/bin`, and a live process's current directory
 * is undeletable on Windows. macOS unlinks a running image happily, so the whole
 * problem is Windows-only and every other host returns immediately.
 *
 * Order of work matters as much as the process query: the delete is attempted
 * FIRST, so a machine holding nothing never runs a process query at all.
 * Enumeration happens only after the delete failed and we need to name the holder.
 * See decisions/2026/08/06/windows-build-folder-freed-before-electrobun-wipes-it.md.
 *
 * What it deliberately does NOT kill: the packaged `cli/dev3.exe` sitting in the
 * same folder. Agent hooks in OTHER worktrees invoke the CLI by that absolute path
 * (`resolveDev3CliPath`), and some of those calls block for up to ten minutes
 * waiting for the user to approve something — killing one turns into an
 * unexplainable failure in an unrelated task. Those are named and the build stops
 * so the user decides. Same reason `taskkill /T` is not used: a detached native
 * terminal host still records the app as its parent, and `/T` would take out live
 * agent terminals. Every process worth killing is matched by image PATH, never by
 * process name.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { win32 } from "node:path";

export interface ProcessRow {
	pid: number;
	name: string;
	/** Full image path, or null when the query could not tell us. */
	executablePath: string | null;
}

/** How a process inside the build folder relates to us. */
export type BuildFolderRole = "app-runtime" | "packaged-cli";

export interface BuildFolderRelease {
	/** This build's own app image — safe to terminate. */
	kill: ProcessRow[];
	/** The packaged CLI: may be serving another task, so the user decides. */
	refuse: ProcessRow[];
}

/** Only Windows locks a running image or a live cwd; every other host no-ops. */
export function shouldFreeBuildFolder(platform: NodeJS.Platform): boolean {
	return platform === "win32";
}

/** Lowercased, `/`-normalized, trailing-separator-free — Windows path comparison. */
function normalizeWindowsPath(path: string): string {
	const unified = path.replaceAll("/", "\\").toLowerCase();
	return unified.length > 3 && unified.endsWith("\\") ? unified.slice(0, -1) : unified;
}

/**
 * Is `candidate` the directory `parent` or something below it?
 *
 * The separator check is what keeps `build\dev-win-x64-old` from matching
 * `build\dev-win-x64` — a bare prefix test would reach into an unrelated tree.
 */
export function isInsideDirectory(parent: string, candidate: string): boolean {
	const root = normalizeWindowsPath(parent);
	const path = normalizeWindowsPath(candidate);
	if (!root || !path) return false;
	return path === root || path.startsWith(`${root}\\`);
}

/**
 * `tasklist /FO CSV /NH` rows → `{ name, pid }`.
 *
 * `/NH` is what makes this locale-safe: no column headers to translate, and the
 * first two fields are the image name and the pid on every Windows build. A row
 * that is not a quoted name followed by a numeric pid is dropped.
 *
 * `scripts/verify-windows-app-launch.ts` (`parseTasklistPids`) parses the same output
 * separately, and the split is DELIBERATE: same lesson (locale-safe CSV, and a
 * zero-row parse is a failure, never an empty machine), different contracts (it wants
 * pids only and keeps pid 0; this wants name+pid pairs and drops pid 0) and different
 * blast radius (a CI proof of a packaged app there; this developer-machine hook here).
 * Do not merge them into one helper with a flag.
 */
export function parseTasklistCsv(stdout: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
		if (!match) continue;
		const pid = Number(match[2]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		rows.push({ pid, name: match[1] ?? "", executablePath: null });
	}
	return rows;
}

/** `Get-Process | Select-Object Id,ProcessName,Path | ConvertTo-Json` — one row is not an array. */
export function parseProcessPaths(json: string): ProcessRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const result: ProcessRow[] = [];
	for (const row of rows) {
		const entry = row as { Id?: unknown; ProcessName?: unknown; Path?: unknown };
		const pid = Number(entry.Id);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		result.push({
			pid,
			name: typeof entry.ProcessName === "string" ? entry.ProcessName : "",
			executablePath: typeof entry.Path === "string" && entry.Path ? entry.Path : null,
		});
	}
	return result;
}

/**
 * Every `.exe` this build folder actually contains, lowercased.
 *
 * Derived from our own folder instead of a hardcoded list, so a bundle that starts
 * shipping another executable is covered without editing this hook.
 */
export function bundleExecutableNames(root: string, listDir: (path: string) => string[] = defaultListDir): Set<string> {
	const names = new Set<string>();
	const walk = (dir: string, depth: number): void => {
		if (depth > 8) return;
		for (const entry of listDir(dir)) {
			if (entry.toLowerCase().endsWith(".exe")) names.add(entry.toLowerCase());
			else walk(win32.join(dir, entry), depth + 1);
		}
	};
	walk(root, 0);
	return names;
}

function defaultListDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Which running processes are worth asking about, so the expensive path query stays
 * narrow. A name match NEVER authorizes a kill — `bun.exe` matches half the machine.
 */
export function candidateHolders(rows: ProcessRow[], bundleNames: Set<string>, selfPid: number): ProcessRow[] {
	return rows.filter((row) => {
		if (row.pid === selfPid || !row.name) return false;
		const name = row.name.toLowerCase();
		return bundleNames.has(name.endsWith(".exe") ? name : `${name}.exe`);
	});
}

/** The packaged CLI is the one image in the bundle that can be serving someone else. */
export function buildFolderRole(executablePath: string): BuildFolderRole {
	return win32.basename(executablePath).toLowerCase() === "dev3.exe" ? "packaged-cli" : "app-runtime";
}

/**
 * Split confirmed image paths into ours and not-ours.
 *
 * Image path is the only ownership signal worth trusting: a `bun.exe` on PATH
 * belongs to some agent's session, while `build\…\bin\bun.exe` is this repo's own
 * dev build.
 *
 * `selfPid` is excluded so the hook can never terminate itself, and a process whose
 * path the query withheld (another user, or it exited meanwhile) is left alone.
 */
export function planBuildFolderRelease(rows: ProcessRow[], buildDir: string, selfPid: number): BuildFolderRelease {
	const release: BuildFolderRelease = { kill: [], refuse: [] };
	for (const row of rows) {
		if (row.pid === selfPid || row.executablePath === null) continue;
		if (!isInsideDirectory(buildDir, row.executablePath)) continue;
		if (buildFolderRole(row.executablePath) === "packaged-cli") release.refuse.push(row);
		else release.kill.push(row);
	}
	return release;
}

export interface ProcessListing {
	rows: ProcessRow[];
	failure: string | null;
}

/**
 * A query that answered but parsed to ZERO processes is a broken query, never
 * "nothing is running" — treating it as the latter would silently report every
 * owned process dead and clear nothing while claiming success.
 */
export function interpretProcessRows(label: string, rows: ProcessRow[]): ProcessListing {
	if (rows.length === 0) return { rows: [], failure: `${label} produced output that parsed to zero processes` };
	return { rows, failure: null };
}

export function describeHolder(row: ProcessRow, commandLine?: string | null): string {
	const suffix = commandLine ? ` — command: ${commandLine}` : "";
	return `${row.name || "?"} (pid ${row.pid}) — ${row.executablePath ?? "unknown path"}${suffix}`;
}

/**
 * Refusal message for the packaged CLI. Names the CAUSE (another task's in-flight
 * `dev3` call lives in this folder) and the FIX (let it finish, or end it), because
 * killing it is the user's call and not ours.
 */
export function refusedPackagedCliMessage(buildDir: string, refused: string[]): string {
	return [
		`Refusing to clear the build folder ${buildDir}: a packaged dev3 CLI is running out of it, and it may be serving a DIFFERENT task.`,
		"Agent hooks in other worktrees invoke this exact path, and some of those calls block for up to ten minutes waiting for your approval in the app — terminating one would fail that task with no visible reason.",
		`Still running: ${refused.join("; ")}`,
		"Fix: let that command finish (or approve/cancel whatever it is waiting for, or stop it yourself), then run `bun run dev` again. If you are sure it belongs to nothing you care about, end it in Task Manager and re-run.",
	].join("\n");
}

/**
 * Give-up message after the delete still failed. The cause the user cannot see is a
 * handle no process list shows — a shell or Explorer window sitting in the folder, a
 * scanner — so name it, and name the QUERY as the culprit when that is what failed,
 * pointing at the OS process list rather than at the app.
 */
export function stuckBuildFolderMessage(buildDir: string, killed: string[], queryFailure: string | null): string {
	const context = queryFailure
		? `The Windows process query did not answer, so no holder could be named and nothing was terminated — that is this machine's OS process list, not the app: ${queryFailure}.`
		: killed.length
			? `Terminated this build's own processes first: ${killed.join("; ")}.`
			: "No process is running an executable from inside that folder, so the handle belongs to something else.";
	return [
		`Cannot clear the build folder ${buildDir}: Windows refuses to delete it because a process still holds a file or its current directory inside it.`,
		context,
		`Fix: close every dev-3.0 window left over from an earlier run, close any terminal or Explorer window whose current folder is inside ${buildDir}, let an antivirus scan finish, then run \`bun run dev\` again. If it still fails, delete ${buildDir} by hand once and re-run.`,
	].join("\n");
}

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;

/**
 * Bounded ATTEMPTS, not one long wait. A sibling task observed a Windows process
 * enumeration stall for tens of seconds on a CI runner, and its evidence cannot
 * separate a stalled WMI round-trip from a stalled `powershell.exe` start — so this
 * hook must never turn EBUSY into a silent hang, and every query records how long it
 * took so the next stall arrives with evidence. Sized against one measured Windows
 * runner (tasklist 349ms worst, a WMI tree walk 3316ms worst) — one run, not a
 * distribution; see the decision record.
 */
const QUERY_ATTEMPTS = 2;
const TASKLIST_TIMEOUT_MS = 5_000;
const PATH_QUERY_TIMEOUT_MS = 10_000;

function system32(...segments: string[]): string {
	return SYSTEM_ROOT ? win32.join(SYSTEM_ROOT, "System32", ...segments) : segments[segments.length - 1]!;
}

interface QueryOutcome {
	stdout: string | null;
	/** Why it produced nothing usable, ready to embed in an error message. */
	failure: string | null;
}

/** Run a query with bounded attempts, always reporting what each attempt cost. */
function query(label: string, command: string[], timeoutMs: number): QueryOutcome {
	const failures: string[] = [];
	for (let attempt = 1; attempt <= QUERY_ATTEMPTS; attempt++) {
		const startedAt = Date.now();
		const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore", env: process.env, timeout: timeoutMs });
		const elapsedMs = Date.now() - startedAt;
		const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
		console.log(`[free-build-folder] ${label} attempt ${attempt}: ${elapsedMs}ms, exit ${result.exitCode ?? "timed out"}`);
		if (result.exitCode === 0 && stdout.trim()) return { stdout, failure: null };
		failures.push(
			result.exitCode === null
				? `${label} attempt ${attempt} timed out after ${elapsedMs}ms`
				: `${label} attempt ${attempt} exited ${result.exitCode} after ${elapsedMs}ms`,
		);
	}
	return { stdout: null, failure: failures.join("; ") };
}

/**
 * `tasklist` rather than PowerShell: a native executable, no WMI service, no
 * PowerShell cold start — the two halves of the observed stall that nobody could
 * separate.
 */
function runningProcesses(): ProcessListing {
	const outcome = query("tasklist", [system32("tasklist.exe"), "/FO", "CSV", "/NH"], TASKLIST_TIMEOUT_MS);
	if (outcome.stdout === null) return { rows: [], failure: outcome.failure };
	return interpretProcessRows("tasklist", parseTasklistCsv(outcome.stdout));
}

/** Confirm real image paths for a narrow pid list — the only thing that authorizes a kill. */
function imagePathsOf(pids: number[]): ProcessListing {
	const outcome = query(
		"image paths",
		[
			system32("WindowsPowerShell", "v1.0", "powershell.exe"),
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress -Depth 3`,
		],
		PATH_QUERY_TIMEOUT_MS,
	);
	if (outcome.stdout === null) return { rows: [], failure: outcome.failure };
	return interpretProcessRows("the image-path query", parseProcessPaths(outcome.stdout));
}

/** Best-effort attribution of a refused CLI to a task; failure is fine. */
function commandLineOf(pid: number): string | null {
	const outcome = query(
		`command line of ${pid}`,
		[
			system32("WindowsPowerShell", "v1.0", "powershell.exe"),
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
		],
		PATH_QUERY_TIMEOUT_MS,
	);
	const line = outcome.stdout?.trim();
	return line ? line.slice(0, 300) : null;
}

function terminate(pid: number): void {
	Bun.spawnSync([system32("taskkill.exe"), "/PID", String(pid), "/F"], {
		stdout: "ignore",
		stderr: "ignore",
		env: process.env,
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** True when the folder is gone. The retries absorb a handle closing a moment late. */
function tryRemove(buildDir: string): boolean {
	try {
		rmSync(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	if (!shouldFreeBuildFolder(process.platform)) return;

	const buildDir = process.env.ELECTROBUN_BUILD_DIR;
	if (!buildDir) {
		console.warn("[free-build-folder] ELECTROBUN_BUILD_DIR is unset — leaving the build folder to electrobun");
		return;
	}
	if (!existsSync(buildDir)) return;

	// Delete first: on a machine holding nothing, no process query runs at all.
	if (tryRemove(buildDir)) {
		console.log(`[free-build-folder] cleared ${buildDir}`);
		return;
	}

	const listing = runningProcesses();
	const candidates = candidateHolders(listing.rows, bundleExecutableNames(buildDir), process.pid);
	const confirmed = candidates.length ? imagePathsOf(candidates.map((row) => row.pid)) : { rows: [], failure: null };
	const queryFailure = listing.failure ?? confirmed.failure;
	const release = planBuildFolderRelease(confirmed.rows, buildDir, process.pid);

	if (release.refuse.length) {
		throw new Error(
			refusedPackagedCliMessage(
				buildDir,
				release.refuse.map((row) => describeHolder(row, commandLineOf(row.pid))),
			),
		);
	}

	const killed = release.kill.map((row) => describeHolder(row));
	for (const holder of release.kill) {
		console.log(`[free-build-folder] terminating ${describeHolder(holder)}`);
		terminate(holder.pid);
	}
	// `/F` returns before the kernel has torn the process down; without this the
	// delete races the closing handles.
	if (release.kill.length) await sleep(500);

	if (!tryRemove(buildDir)) throw new Error(stuckBuildFolderMessage(buildDir, killed, queryFailure));
	console.log(`[free-build-folder] cleared ${buildDir}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
