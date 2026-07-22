#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSessionClient } from "../client";
import { isProcessAlive } from "../process-identity";
import { readToken } from "../record";
import { start, stop } from "../registry";
import { cmdArgvProbeBatch, powershellArgvProbeCommand, powershellLiteral } from "../shell-probe";
import {
	shellCommand,
	shellExitVerdict,
	ShellExecutableNotFoundError,
	windowsShellLaunchSpec,
	type RequiredWindowsShell,
	type ShellLaunchSpec,
} from "../shell-launch";

interface Detection {
	detected: boolean;
	path?: string;
	version?: string;
	reason?: string;
}

interface MatrixConfig {
	outputDir: string;
	capturedAt: string;
	required: Record<RequiredWindowsShell, Detection>;
	optional: Record<"git-bash" | "wsl", Detection>;
}

interface ProbeEvidence {
	cwd: string;
	environment: string;
	arguments: string[];
	parentPid: number;
}

interface Check {
	id: string;
	passed: boolean;
	detail: string;
}

interface RequiredShellVerdict {
	shell: RequiredWindowsShell;
	detected: boolean;
	supported: boolean;
	version: string;
	checks: Check[];
	failure?: string;
	launch?: {
		executable: string;
		argvEntries: number;
		cwdHasSpaces: boolean;
		cwdHasUnicode: boolean;
	};
	pids?: {
		host: number;
		shell: number;
		reattachedShell: number;
		ownedChild: number;
	};
	exit?: ReturnType<typeof shellExitVerdict> & { requested: number };
}

const REQUIRED_SHELLS: RequiredWindowsShell[] = ["windows-powershell-5.1", "powershell-7", "cmd"];
const PROBE_ARGS = ["argument with spaces", 'quote"value', "meta & | < > ^ ! ( ) ;", "plain-tail"];
const UNICODE_ENV = "Живой ✓ 日本語 שלום";
const OUTPUT_DEADLINE_MS = 10_000;
const fixtureDir = dirname(fileURLToPath(import.meta.url));

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T;
}

function sameWindowsPath(left: string, right: string): boolean {
	return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function waitForText(client: NativeSessionClient, text: string): Promise<boolean> {
	return client.waitForTextOutput((output) => (output.includes(text) ? true : undefined), {
		timeoutMs: OUTPUT_DEADLINE_MS,
		description: JSON.stringify(text),
	});
}

function waitForMatch(client: NativeSessionClient, pattern: RegExp): Promise<RegExpExecArray> {
	return client.waitForTextOutput((output) => pattern.exec(output) ?? undefined, {
		timeoutMs: OUTPUT_DEADLINE_MS,
		description: String(pattern),
	});
}

function addCheck(checks: Check[], id: string, passed: boolean, detail: string): void {
	checks.push({ id, passed, detail });
	if (!passed) throw new Error(`${id}: ${detail}`);
}

function shellVersionMatches(shell: RequiredWindowsShell, version: string | undefined): boolean {
	if (!version) return false;
	if (shell === "windows-powershell-5.1") return version.startsWith("5.1.");
	if (shell === "powershell-7") return Number(version.split(".")[0]) >= 7;
	return /Microsoft Windows/i.test(version);
}

function buildLaunch(
	shell: RequiredWindowsShell,
	executable: string,
	cwd: string,
	evidencePath: string,
): ShellLaunchSpec {
	return windowsShellLaunchSpec(shell, {
		executable,
		cwd,
		env: {
			DEV3_SHELL_MATRIX_EVIDENCE: evidencePath,
			DEV3_SHELL_MATRIX_UNICODE: UNICODE_ENV,
			DEV3_BUN_EXE: process.execPath,
			DEV3_ARG_PROBE: join(fixtureDir, "windows-shell-argv-probe.ts"),
		},
	});
}

function sendLine(client: NativeSessionClient, command: string): void {
	client.input(`${command}\r`);
}

interface InteractiveShellAdapter {
	sendArgvProbe(client: NativeSessionClient, launch: ShellLaunchSpec): void;
	setState(client: NativeSessionClient, state: string): void;
	readState(client: NativeSessionClient): void;
	childProbeCommand(scriptPath: string): string;
}

const powershellAdapter: InteractiveShellAdapter = {
	sendArgvProbe(client, launch) {
		sendLine(
			client,
			powershellArgvProbeCommand(
				launch.env.DEV3_BUN_EXE,
				launch.env.DEV3_ARG_PROBE,
				PROBE_ARGS,
			),
		);
	},
	setState(client, state) {
		sendLine(client, `$env:DEV3_SHELL_MATRIX_STATE=${powershellLiteral(state)}; Write-Output "STATE-SET[$env:DEV3_SHELL_MATRIX_STATE]"`);
	},
	readState(client) {
		sendLine(client, 'Write-Output "STATE[$env:DEV3_SHELL_MATRIX_STATE]"');
	},
	childProbeCommand(scriptPath) {
		return `& ${powershellLiteral(process.execPath)} ${powershellLiteral(scriptPath)}`;
	},
};

const shellAdapters: Record<RequiredWindowsShell, InteractiveShellAdapter> = {
	"windows-powershell-5.1": powershellAdapter,
	"powershell-7": powershellAdapter,
	cmd: {
		sendArgvProbe(client, launch) {
			const batchPath = join(launch.cwd, "argv probe.cmd");
			writeFileSync(batchPath, cmdArgvProbeBatch(PROBE_ARGS));
			sendLine(client, `"${batchPath}"`);
		},
		setState(client, state) {
			sendLine(client, `set "DEV3_SHELL_MATRIX_STATE=${state}"`);
			sendLine(client, "echo STATE-SET[%DEV3_SHELL_MATRIX_STATE%]");
		},
		readState(client) {
			sendLine(client, "echo STATE[%DEV3_SHELL_MATRIX_STATE%]");
		},
		childProbeCommand(scriptPath) {
			return `"${process.execPath}" "${scriptPath}"`;
		},
	},
};

async function proveLifecycle(
	shell: RequiredWindowsShell,
	launch: ShellLaunchSpec,
	evidencePath: string,
	checks: Check[],
): Promise<RequiredShellVerdict["pids"]> {
	const sessionId = `shell-${shell.replace(/[^a-z0-9]+/g, "-")}`;
	const adapter = shellAdapters[shell];
	let record: Awaited<ReturnType<typeof start>>["record"] | null = null;
	let ownedChildPid = -1;
	try {
		const started = await start(sessionId, { launch, timeoutMs: 20_000 });
		record = started.record;
		addCheck(checks, "launch-command", JSON.stringify(record.shell.command) === JSON.stringify(shellCommand(launch)), "recorded command equals executable plus argv entries");
		const client = new NativeSessionClient();
		await client.connect(record, readToken(sessionId) ?? "", { timeoutMs: 8000 });
		const probeReady = waitForText(client, "ARGV-PROBE-WROTE");
		adapter.sendArgvProbe(client, launch);
		addCheck(checks, "probe-ready", await probeReady, "attached argv probe wrote evidence");
		const evidence = readJson<ProbeEvidence>(evidencePath);
		addCheck(checks, "cwd", sameWindowsPath(evidence.cwd, launch.cwd), "shell observed the Unicode cwd with spaces");
		addCheck(checks, "environment", evidence.environment === UNICODE_ENV, "shell observed the exact Unicode environment value");
		const observedArguments = JSON.stringify(evidence.arguments);
		const expectedArguments = JSON.stringify(PROBE_ARGS);
		addCheck(
			checks,
			"argv",
			observedArguments === expectedArguments,
			`expected ${expectedArguments}; observed ${observedArguments}`,
		);
		addCheck(checks, "root-pid", evidence.parentPid === record.shell.pid, "argv probe was launched directly by the recorded root shell PID");
		const state = `state-${shell.replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
		const stateSet = waitForText(client, `STATE-SET[${state}]`);
		adapter.setState(client, state);
		addCheck(checks, "state-set", await stateSet, "interactive shell state was set before detach");

		const childScript = join(fixtureDir, "windows-owned-child-probe.ts");
		const childPid = waitForMatch(client, /TREEPID\[(\d+)\]/);
		sendLine(client, adapter.childProbeCommand(childScript));
		const childMatch = await childPid;
		ownedChildPid = Number(childMatch[1]);
		addCheck(checks, "owned-child", ownedChildPid > 0 && isProcessAlive(ownedChildPid), "a descendant process is alive inside the session ownership boundary");
		const beforeDetach = await client.status();
		await client.disconnect({ timeoutMs: 3000 });
		addCheck(checks, "detach-complete", true, "original client observed WebSocket close before reattach");

		const reattached = await NativeSessionClient.discover(sessionId, { timeoutMs: 8000 });
		const afterDetach = await reattached.status();
		addCheck(checks, "same-pid", afterDetach.shellPid === beforeDetach.shellPid && afterDetach.shellPid === record.shell.pid, "fresh client reattached to the same shell PID");
		const stateRetained = waitForText(reattached, `STATE[${state}]`);
		adapter.readState(reattached);
		addCheck(checks, "same-state", await stateRetained, "fresh client observed state retained by the same shell");
		reattached.close();

		const stopped = await stop(sessionId, { timeoutMs: 10_000 });
		addCheck(checks, "stop", stopped, "registry stop succeeded");
		addCheck(
			checks,
			"owned-teardown",
			!isProcessAlive(record.host.pid) && !isProcessAlive(record.shell.pid) && !isProcessAlive(ownedChildPid),
			"stop removed the host, root shell, and owned descendant tree",
		);
		return {
			host: record.host.pid,
			shell: record.shell.pid,
			reattachedShell: afterDetach.shellPid,
			ownedChild: ownedChildPid,
		};
	} finally {
		if (record) await stop(sessionId, { timeoutMs: 5000 }).catch(() => false);
	}
}

async function proveExitCode(
	shell: RequiredWindowsShell,
	launch: ShellLaunchSpec,
	checks: Check[],
): Promise<RequiredShellVerdict["exit"]> {
	const sessionId = `shell-exit-${shell.replace(/[^a-z0-9]+/g, "-")}`;
	let started: Awaited<ReturnType<typeof start>> | null = null;
	try {
		started = await start(sessionId, { launch, timeoutMs: 20_000 });
		const client = new NativeSessionClient();
		await client.connect(started.record, readToken(sessionId) ?? "", { timeoutMs: 8000 });
		addCheck(checks, "exit-probe-ready", (await client.status()).alive, "exit-code shell reached its prompt");
		const exitPromise = client.waitForExit({ timeoutMs: 10_000 });
		sendLine(client, "exit 37");
		const observed = await exitPromise;
		const verdict = shellExitVerdict(observed);
		addCheck(checks, "exit-code", verdict.kind === "shell-command-failed" && verdict.code === 37, `requested 37, observed ${String(observed)}`);
		return { ...verdict, requested: 37 };
	} finally {
		if (started) await stop(sessionId, { timeoutMs: 5000 }).catch(() => false);
	}
}

async function proveRequiredShell(
	shell: RequiredWindowsShell,
	detection: Detection,
	rawDir: string,
): Promise<RequiredShellVerdict> {
	const checks: Check[] = [];
	const verdict: RequiredShellVerdict = {
		shell,
		detected: detection.detected,
		supported: false,
		version: detection.version ?? "unknown",
		checks,
	};
	if (!detection.detected || !detection.path) {
		verdict.failure = detection.reason ?? "required executable not detected";
		return verdict;
	}

	const safeShell = shell.replace(/[^a-z0-9]+/g, "-");
	const cwd = join(rawDir, `${safeShell} cwd with spaces Живой 日本語`);
	mkdirSync(cwd, { recursive: true });
	const lifecycleEvidence = join(rawDir, `${safeShell}-lifecycle.json`);
	const exitEvidence = join(rawDir, `${safeShell}-exit.json`);
	const lifecycleLaunch = buildLaunch(shell, detection.path, cwd, lifecycleEvidence);
	const exitLaunch = buildLaunch(shell, detection.path, cwd, exitEvidence);
	verdict.launch = {
		executable: basename(detection.path),
		argvEntries: lifecycleLaunch.argv.length,
		cwdHasSpaces: /\s/.test(cwd),
		cwdHasUnicode: /[^\x00-\x7F]/.test(cwd),
	};

	try {
		addCheck(checks, "shell-version", shellVersionMatches(shell, detection.version), `runner observed ${detection.version ?? "unknown"}`);
		verdict.pids = await proveLifecycle(shell, lifecycleLaunch, lifecycleEvidence, checks);
		verdict.exit = await proveExitCode(shell, exitLaunch, checks);
		verdict.supported = checks.every((check) => check.passed);
	} catch (error) {
		verdict.failure = error instanceof Error ? error.message : String(error);
	}
	return verdict;
}

async function proveMissingExecutable(rawDir: string): Promise<Check> {
	const launch = windowsShellLaunchSpec("powershell-7", {
		executable: join(rawDir, "requested-shell-does-not-exist.exe"),
		cwd: rawDir,
		env: {},
	});
	try {
		await start("shell-missing-executable", { launch, timeoutMs: 3000 });
		return { id: "executable-not-found", passed: false, detail: "missing executable unexpectedly launched" };
	} catch (error) {
		return {
			id: "executable-not-found",
			passed: error instanceof ShellExecutableNotFoundError && error.code === "executable-not-found",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

async function main(): Promise<void> {
	const configPath = process.argv[2];
	if (!configPath) throw new Error("usage: windows-shell-matrix.ts <config.json>");
	const config = readJson<MatrixConfig>(configPath);
	if (process.platform !== "win32") throw new Error("the Windows shell matrix requires native Windows");

	const shareDir = join(config.outputDir, "share");
	const rawDir = join(config.outputDir, "raw");
	const shimDir = join(rawDir, "path-sentinel");
	const tmuxSentinel = join(rawDir, "tmux-was-invoked");
	mkdirSync(shareDir, { recursive: true });
	mkdirSync(shimDir, { recursive: true });
	writeFileSync(join(shimDir, "tmux.cmd"), `@echo off\r\necho invoked>"${tmuxSentinel}"\r\nexit /b 99\r\n`);
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(rawDir, "sessions");

	const runtime: Check = {
		id: "bun-version",
		passed: Bun.version === "1.3.14",
		detail: `native ${process.platform} ${process.arch}; Bun ${Bun.version}`,
	};
	const missingExecutable = await proveMissingExecutable(rawDir);
	const required: RequiredShellVerdict[] = [];
	for (const shell of REQUIRED_SHELLS) {
		required.push(await proveRequiredShell(shell, config.required[shell], rawDir));
	}
	const tmux: Check = {
		id: "tmux-never-invoked",
		passed: !existsSync(tmuxSentinel),
		detail: existsSync(tmuxSentinel) ? "PATH sentinel was invoked" : "PATH sentinel remained absent",
	};
	const passed = runtime.passed && missingExecutable.passed && tmux.passed && required.every((entry) => entry.supported);
	const matrix = {
		schemaVersion: 1,
		capturedAt: config.capturedAt,
		platform: `${process.platform} ${process.arch}`,
		bunVersion: Bun.version,
		passed,
		checks: [runtime, missingExecutable, tmux],
		required,
		optional: Object.fromEntries(
			Object.entries(config.optional).map(([name, detection]) => [
				name,
				{
					detected: detection.detected,
					...(detection.version ? { version: detection.version } : {}),
					...(detection.reason ? { reason: detection.reason } : {}),
				},
			]),
		),
		scope: {
			registryOnly: true,
			tmuxInvoked: !tmux.passed,
			staticGuard: "src/bun/native-terminal-registry/__tests__/isolation.test.ts",
		},
	};
	writeFileSync(join(shareDir, "windows-shell-verdict.json"), `${JSON.stringify(matrix, null, 2)}\n`);

	console.log("\nWindows shell launch verdict");
	for (const entry of required) {
		console.log(`${entry.shell.padEnd(24)} ${entry.supported ? "SUPPORTED" : `FAILED (${entry.failure ?? "check failed"})`}`);
	}
	for (const [name, detection] of Object.entries(config.optional)) {
		console.log(`${name.padEnd(24)} ${detection.detected ? "DETECTED / SKIPPED" : `NOT DETECTED / SKIPPED (${detection.reason ?? "not installed"})`}`);
	}
	console.log(`executable-not-found`.padEnd(24), missingExecutable.passed ? "SUPPORTED" : "FAILED");
	console.log(`tmux sentinel`.padEnd(24), tmux.passed ? "CLEAN" : "FAILED");
	console.log(`\nVerdict: ${passed ? "SUPPORTED" : "FAILED"}`);
	console.log(`Evidence: ${join(shareDir, "windows-shell-verdict.json")}`);
	if (!passed) process.exitCode = 1;
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
