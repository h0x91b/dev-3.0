/**
 * The `bun run dev` / `bun run start` orchestrator.
 *
 * The package scripts used to be one POSIX shell line: `A && B && VAR=x $(cmd)
 * electrobun dev`. Environment-variable prefixes, `$(...)` substitution and
 * `${VAR:-0}` defaulting are all shell syntax PowerShell does not speak, so on
 * Windows the dev loop could not start at all. This runs the identical steps as
 * a process chain with no shell involved, and resolves every tool through a
 * concrete file inside `node_modules` rather than a PATH lookup (Windows has no
 * `vite` executable — only `vite.cmd` — and `electrobun.cjs` needs a runtime).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKER_ENTRIES } from "./build-cli";
import { type QaScopeMode, qaScopeRoot, seedQaScope } from "./qa-scope";

/** Lazy: `import.meta.dir` is a Bun-runtime value, absent when tests import this. */
function repoRoot(): string {
	return resolve(import.meta.dir, "..");
}

/** Tools resolved as files so no shell wrapper or PATH entry is required. */
const VITE_BIN = "node_modules/vite/bin/vite.js";
const ELECTROBUN_BIN = "node_modules/electrobun/bin/electrobun.cjs";

export type DevMode = "dev" | "start";

/** `desktop` opens the Electrobun window; `headless` serves the same UI through `dev3 remote`. */
export type DevShell = "desktop" | "headless";

const WEBKIT_LIB = "libwebkit2gtk-4.1.so.0";
const LINUX_LIB_DIRS = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib"];

export function linuxHasWebkit(exists: (path: string) => boolean = existsSync): boolean {
	return LINUX_LIB_DIRS.some((dir) => exists(join(dir, WEBKIT_LIB)));
}

/**
 * Electrobun's Linux window is GTK over WebKitGTK, so it cannot open without a
 * display or without libwebkit2gtk-4.1 (WSL without WSLg, SSH, containers). Those
 * hosts fall back to the headless server instead of failing the whole dev loop.
 */
export function devShell(
	argv: readonly string[],
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
	hasWebkit: () => boolean,
): { shell: DevShell; reason: string | null } {
	if (argv.includes("--headless") || env.DEV3_DEV_HEADLESS === "1") return { shell: "headless", reason: "requested" };
	if (platform !== "linux") return { shell: "desktop", reason: null };
	if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { shell: "headless", reason: "no DISPLAY or WAYLAND_DISPLAY" };
	if (!hasWebkit()) return { shell: "headless", reason: `${WEBKIT_LIB} not found` };
	return { shell: "desktop", reason: null };
}

export interface DevStep {
	label: string;
	command: string[];
}

/**
 * `start` deliberately skips `vite build` — it reuses whatever the last `dev`
 * emitted into `dist/`, which is the entire point of the second entry point.
 */
export function devPlan(mode: DevMode, execPath: string, shell: DevShell = "desktop"): DevStep[] {
	const steps: DevStep[] = [
		{ label: "build info", command: [execPath, "scripts/generate-build-info.ts"] },
		{ label: "changelog", command: [execPath, "scripts/generate-changelog.ts"] },
	];
	if (mode === "dev") {
		steps.push({ label: "renderer bundle", command: [execPath, VITE_BIN, "build"] });
	}
	if (shell === "headless") {
		// The server runs from source, so it needs only the worker bundles it loads from dist/.
		for (const entry of WORKER_ENTRIES) {
			steps.push({ label: `worker ${entry}`, command: [execPath, "build", entry, "--target", "bun", "--outdir", "dist/workers"] });
		}
		return steps;
	}
	steps.push(
		{ label: "CLI + native build", command: [execPath, "scripts/build-cli.ts"] },
		{ label: "electrobun build", command: [execPath, ELECTROBUN_BIN, "build"] },
	);
	return steps;
}

/**
 * Env for the `electrobun dev` run. `dev` additionally pins the stable per-machine
 * web-access code and the remote port, which the shell script passed inline.
 */
export function devRunEnv(
	mode: DevMode,
	source: { staticCode: string | null; port0: string | undefined; qaScope?: Record<string, string> },
): Record<string, string> {
	const env: Record<string, string> = { DEV3_FRESH_START: "1" };
	// QA scoping applies to both entry points: `--start` reuses the last build and
	// is just as capable of clicking another task's completion dialog.
	Object.assign(env, source.qaScope ?? {});
	if (mode !== "dev") return env;
	if (source.staticCode) env.DEV3_REMOTE_STATIC_CODE = source.staticCode;
	// `${DEV3_PORT0:-0}`: 0 means "pick a free port".
	env.DEV3_REMOTE_PORT = source.port0?.trim() || "0";
	return env;
}

/**
 * The headless server runs from source on purpose: the compiled `dist/dev3` has no
 * build channel, so the managed-CLI guard would treat it as an install and let it
 * overwrite the shared `~/.dev3.0/bin/dev3`. A `bun` process is refused that write.
 */
export function headlessCommand(execPath: string): string[] {
	return [execPath, "src/cli/main.ts", "remote", "--no-detach"];
}

/**
 * Pinned in both modes because an agent shell inherits the installed server's
 * `DEV3_REMOTE_PORT` and `DEV3_VIEWS_DIR`, which would clash with it on the port
 * and serve the installed UI instead of this checkout's.
 */
export function headlessRunEnv(root: string, port0: string | undefined): Record<string, string> {
	return {
		DEV3_REMOTE_NO_TUNNEL: "1",
		DEV3_REMOTE_HOST: "127.0.0.1",
		DEV3_REMOTE_PORT: port0?.trim() || "0",
		DEV3_VIEWS_DIR: join(root, "dist"),
		DEV3_VIEWS_DIR_AUTO: "",
	};
}

/**
 * Opt-in for the desktop run. The plain `bun run dev` is the main local dev flow and
 * must keep showing the real board; only a run that explicitly asks gets a
 * throwaway one. A headless run passes `seeded` as its `fallback`.
 *
 * `seeded` gets one throwaway project (the QA default); `virgin` gets nothing, so
 * an instance can be brought up in the state a brand-new user is actually in.
 */
export function qaScopeMode(
	argv: readonly string[],
	env: Record<string, string | undefined>,
	fallback: QaScopeMode | null = null,
): QaScopeMode | null {
	const flag = argv.find((arg) => arg === "--qa" || arg.startsWith("--qa="));
	const requested = flag?.includes("=") ? flag.slice("--qa=".length).trim() : flag ? "seeded" : env.DEV3_QA_SCOPE?.trim();
	if (!requested) return fallback;
	if (requested === "0") return null;
	if (requested === "virgin") return "virgin";
	if (requested === "1" || requested === "seeded") return "seeded";
	throw new Error(`[dev] unknown QA scope mode ${JSON.stringify(requested)} — use "seeded" or "virgin"`);
}

function runOrExit(step: DevStep): void {
	const result = Bun.spawnSync(step.command, {
		cwd: repoRoot(),
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (result.exitCode !== 0) {
		console.error(`[dev] ${step.label} failed (exit ${result.exitCode})`);
		process.exit(result.exitCode ?? 1);
	}
}

function readDevWebCode(): string | null {
	const result = Bun.spawnSync([process.execPath, "scripts/dev-web-code.ts"], {
		cwd: repoRoot(),
		stdout: "pipe",
		stderr: "inherit",
		env: process.env,
	});
	if (result.exitCode !== 0) {
		console.warn("[dev] dev web access code unavailable — the browser UI will need the rotating token");
		return null;
	}
	return new TextDecoder().decode(result.stdout).trim() || null;
}

/**
 * Signals this script must intercept so Ctrl+C tears the app down with it.
 *
 * `SIGBREAK` exists only on Windows and Node throws `ERR_UNKNOWN_SIGNAL` for an
 * unsupported name, so the list is platform-dependent. `SIGHUP` covers closing
 * the terminal window.
 */
export function shutdownSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
	return platform === "win32"
		? ["SIGINT", "SIGTERM", "SIGBREAK"]
		: ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * Windows recursive kill. `taskkill /T` is the only thing that reaches the app,
 * because the app is a GRANDCHILD (this script -> electrobun CLI -> launcher ->
 * app) and Windows has no process group for Ctrl+C to propagate through.
 *
 * `taskkill` is addressed through `%SystemRoot%` rather than PATH — same lesson as
 * the search-PATH bug: never assume a system binary is resolvable.
 */
export function treeKillCommand(
	pid: number,
	platform: NodeJS.Platform,
	env: Record<string, string | undefined> = process.env,
): string[] | null {
	if (platform !== "win32") return null;
	const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
	const taskkill = systemRoot ? `${systemRoot}\\System32\\taskkill.exe` : "taskkill";
	return [taskkill, "/PID", String(pid), "/T", "/F"];
}

/** `ps -Ao pid=,ppid=` rows → {pid, ppid}; malformed lines are dropped. */
export function parseProcessTable(stdout: string): Array<{ pid: number; ppid: number }> {
	const rows: Array<{ pid: number; ppid: number }> = [];
	for (const line of stdout.split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/);
		const parsed = { pid: Number(pid), ppid: Number(ppid) };
		if (Number.isInteger(parsed.pid) && Number.isInteger(parsed.ppid) && parsed.pid > 0) rows.push(parsed);
	}
	return rows;
}

/**
 * Every descendant of `rootPid`, deepest first, `rootPid` last.
 *
 * Needed on POSIX too: signalling the direct child does NOT cascade. Verified on
 * macOS — after SIGINT to this script the electrobun CLI processes died while the
 * app launcher and the app itself survived and kept logging.
 *
 * Self-parenting or cyclic rows cannot loop the walk: a pid is expanded at most
 * once.
 */
export function descendantPids(rows: Array<{ pid: number; ppid: number }>, rootPid: number): number[] {
	const childrenOf = new Map<number, number[]>();
	for (const row of rows) {
		if (row.pid === row.ppid) continue;
		const siblings = childrenOf.get(row.ppid);
		if (siblings) siblings.push(row.pid);
		else childrenOf.set(row.ppid, [row.pid]);
	}
	const ordered: number[] = [];
	const seen = new Set<number>();
	const walk = (pid: number): void => {
		if (seen.has(pid)) return;
		seen.add(pid);
		for (const child of childrenOf.get(pid) ?? []) walk(child);
		ordered.push(pid);
	};
	walk(rootPid);
	return ordered;
}

const FORCE_KILL_GRACE_MS = 3_000;

function posixTreePids(rootPid: number): number[] {
	const result = Bun.spawnSync(["ps", "-Ao", "pid=,ppid="], { stdout: "pipe", stderr: "ignore", env: process.env });
	if (result.exitCode !== 0 || !result.stdout) return [rootPid];
	return descendantPids(parseProcessTable(new TextDecoder().decode(result.stdout)), rootPid);
}

function signalPids(pids: number[], signal: NodeJS.Signals | number): void {
	for (const pid of pids) {
		try { process.kill(pid, signal); } catch { /* already gone */ }
	}
}

function main(): void {
	const mode: DevMode = process.argv.includes("--start") ? "start" : "dev";
	const { shell, reason } = devShell(process.argv, process.env, process.platform, linuxHasWebkit);
	if (reason) console.log(`[dev] headless (${reason}): serving the UI through dev3 remote, not a desktop window`);
	for (const step of devPlan(mode, process.execPath, shell)) runOrExit(step);

	let qaScope: Record<string, string> | undefined;
	// Headless defaults to a throwaway board: the real one usually belongs to an
	// installed `dev3 remote` on the same machine. `DEV3_QA_SCOPE=0` opts back in.
	const scopeMode = qaScopeMode(process.argv, process.env, shell === "headless" ? "seeded" : null);
	if (scopeMode) {
		const root = qaScopeRoot(repoRoot(), scopeMode);
		qaScope = seedQaScope(root, scopeMode);
		console.log(`[dev] QA scope (${scopeMode}): DEV3_HOME=${qaScope.DEV3_HOME} — real ~/.dev3.0 untouched`);
		console.log(`[dev] reset this scope with: rm -rf ${root}`);
	}

	const env = devRunEnv(mode, {
		staticCode: mode === "dev" ? readDevWebCode() : null,
		port0: process.env.DEV3_PORT0,
		qaScope,
	});
	if (shell === "headless") Object.assign(env, headlessRunEnv(repoRoot(), process.env.DEV3_PORT0));

	const command = shell === "headless" ? headlessCommand(process.execPath) : [process.execPath, ELECTROBUN_BIN, "dev"];
	const child = Bun.spawn(command, {
		cwd: repoRoot(),
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		env: { ...process.env, ...env },
	});

	let shuttingDown = false;
	const shutDown = (signal: NodeJS.Signals): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		const tree = treeKillCommand(child.pid, process.platform);
		if (tree) {
			// One recursive call covers the whole tree on Windows.
			Bun.spawnSync(tree, { stdout: "ignore", stderr: "ignore", env: process.env });
			// The desktop app is NOT always inside that tree: the electrobun launcher
			// can leave it detached, so `/T` misses it. Observed live — waiting on
			// `child.exited` then never returned and wedged the console with no way
			// to type. The prompt comes back on a deadline no matter what.
			const giveUp = setTimeout(() => {
				console.error("[dev] the app did not exit after taskkill; leaving it to the OS");
				process.exit(0);
			}, FORCE_KILL_GRACE_MS);
			child.exited.then(() => {
				clearTimeout(giveUp);
				process.exit(0);
			});
			return;
		}
		// POSIX: enumerate first, because the pids disappear as we kill them.
		const pids = posixTreePids(child.pid);
		signalPids(pids, signal);
		// The app can take a moment to close its window; anything still alive after
		// the grace period gets SIGKILL, so the shell never returns a prompt to a
		// console another process is still writing to.
		const forceKill = setTimeout(() => {
			signalPids(pids, "SIGKILL");
			process.exit(0);
		}, FORCE_KILL_GRACE_MS);
		child.exited.then(() => {
			clearTimeout(forceKill);
			signalPids(pids, "SIGKILL");
			process.exit(0);
		});
	};

	for (const signal of shutdownSignals(process.platform)) {
		process.on(signal, () => shutDown(signal));
	}

	child.exited.then((code) => process.exit(code ?? 0));
}

if (import.meta.main) main();
