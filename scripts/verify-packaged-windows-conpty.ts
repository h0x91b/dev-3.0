import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertPackagedConptyRuntime } from "../src/shared/native-terminal-runtime";

if (process.platform !== "win32") {
	console.log("[native-terminal-runtime] packaged ConPTY proof skipped outside Windows");
	process.exit(0);
}

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

interface HostVersion {
	bunVersion: string;
	executable: string;
	entrypoint: string;
	carrier: "bun-runtime-script" | "compiled";
}

interface HostState {
	marker: "DEV3_PACKAGED_DETACHED_HOST_OK";
	bunVersion: string;
	hostPid: number;
	shellPid: number;
	executable: string;
	entrypoint: string;
	ffiModuleAvailable: boolean;
}

function findFiles(root: string, name: string): string[] {
	const matches: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) matches.push(...findFiles(path, name));
		else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) matches.push(path);
	}
	return matches;
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 20_000): CommandResult {
	const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

function requireSuccess(result: CommandResult, description: string): string {
	if (result.status !== 0 || result.error) {
		throw new Error(
			`${description} failed (exit ${result.status ?? "none"}${result.error ? `, ${result.error.message}` : ""}).` +
				`\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	return result.stdout.trim();
}

function parseLastJson<T>(output: string, description: string): T {
	const line = output.trim().split(/\r?\n/).at(-1);
	if (!line) throw new Error(`${description} returned no JSON output.`);
	try {
		return JSON.parse(line) as T;
	} catch (cause) {
		throw new Error(`${description} returned invalid JSON: ${line}`, { cause });
	}
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function samePath(left: string, right: string): boolean {
	return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir || !existsSync(buildDir)) {
	throw new Error(`Electrobun postBuild did not provide a valid ELECTROBUN_BUILD_DIR (${buildDir ?? "missing"}).`);
}

const appRuntimes = findFiles(buildDir, "bun.exe");
if (appRuntimes.length !== 1) {
	throw new Error(`Expected exactly one Electrobun app runtime under ${buildDir}; found ${appRuntimes.length} bun.exe files.`);
}
const packagedAppRuntime = resolve(appRuntimes[0]);

const terminalEntrypoints = findFiles(buildDir, "dev3-terminal-host.js");
if (terminalEntrypoints.length !== 1) {
	throw new Error(
		`Expected exactly one packaged dev3-terminal-host.js under ${buildDir}; found ${terminalEntrypoints.length}. ` +
			"Run bun run build:native before Electrobun packaging.",
	);
}
const packagedEntrypoint = resolve(terminalEntrypoints[0]);

const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
if (!systemRoot) throw new Error("Packaged ConPTY verification cannot resolve SystemRoot.");
const system32 = join(systemRoot, "System32");
const cleanDir = mkdtempSync(join(tmpdir(), "dev3-packaged-conpty-"));
const sessionDir = join(cleanDir, "session");
const cleanEnv: NodeJS.ProcessEnv = {
	SystemRoot: systemRoot,
	WINDIR: process.env.WINDIR ?? systemRoot,
	ComSpec: process.env.ComSpec ?? join(system32, "cmd.exe"),
	PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
	TEMP: process.env.TEMP ?? tmpdir(),
	TMP: process.env.TMP ?? tmpdir(),
	LOCALAPPDATA: process.env.LOCALAPPDATA,
	USERPROFILE: process.env.USERPROFILE,
	PATH: [system32, join(system32, "WindowsPowerShell", "v1.0")].join(delimiter),
};

let hostStopped = false;
try {
	const where = run(join(system32, "where.exe"), ["bun.exe"], cleanDir, cleanEnv);
	if (where.error) throw new Error(`Could not inspect sanitized PATH: ${where.error.message}`);
	if (where.status === 0) {
		throw new Error(`System Bun unexpectedly remains available on sanitized PATH: ${where.stdout.trim()}`);
	}
	if (where.status !== 1) throw new Error(`where.exe bun.exe returned unexpected exit ${where.status}: ${where.stderr}`);

	const appRuntimeVersion = assertPackagedConptyRuntime(
		requireSuccess(
			run(packagedAppRuntime, ["--version"], cleanDir, cleanEnv),
			"Electrobun app runtime version probe",
		),
	);
	const buildConfigs = findFiles(buildDir, "build.json");
	if (buildConfigs.length !== 1) {
		throw new Error(`Expected exactly one packaged build.json under ${buildDir}; found ${buildConfigs.length}.`);
	}
	const configuredAppVersion = String(JSON.parse(readFileSync(buildConfigs[0], "utf8")).bunVersion ?? "");
	if (appRuntimeVersion !== configuredAppVersion) {
		throw new Error(
			`Electrobun copied Bun ${appRuntimeVersion}, but packaged build.json declares ${configuredAppVersion || "no version"}.`,
		);
	}

	const packagedVersionOutput = requireSuccess(
		run(packagedAppRuntime, [packagedEntrypoint, "version"], cleanDir, cleanEnv),
		"Packaged terminal host version probe",
	);
	const packagedVersion = parseLastJson<HostVersion>(packagedVersionOutput, "Packaged terminal host version probe");
	if (assertPackagedConptyRuntime(packagedVersion.bunVersion) !== appRuntimeVersion) {
		throw new Error(`Packaged terminal host reports Bun ${packagedVersion.bunVersion}; expected ${appRuntimeVersion}.`);
	}
	if (
		packagedVersion.carrier !== "bun-runtime-script" ||
		!samePath(packagedVersion.executable, packagedAppRuntime) ||
		!samePath(packagedVersion.entrypoint, packagedEntrypoint)
	) {
		throw new Error(`Packaged terminal host identity mismatch: ${JSON.stringify(packagedVersion)}`);
	}

	const runtimeHash = sha256(packagedAppRuntime);
	const entrypointHash = sha256(packagedEntrypoint);
	const hostArtifactId = `${appRuntimeVersion}-${entrypointHash.slice(0, 12)}`;
	const stagedDir = join(cleanDir, "terminal-host", hostArtifactId);
	mkdirSync(stagedDir, { recursive: true });
	const stagedRuntime = resolve(stagedDir, "dev3-terminal-host.exe");
	const stagedEntrypoint = resolve(stagedDir, "dev3-terminal-host.js");
	copyFileSync(packagedAppRuntime, stagedRuntime);
	copyFileSync(packagedEntrypoint, stagedEntrypoint);
	if (sha256(stagedRuntime) !== runtimeHash || sha256(stagedEntrypoint) !== entrypointHash) {
		throw new Error("Staged terminal host files differ from the packaged runtime and entrypoint.");
	}

	const hostEnv: NodeJS.ProcessEnv = {
		...cleanEnv,
		DEV3_EXPECT_HOST_EXECUTABLE: stagedRuntime,
		DEV3_TERMINAL_HOST_ENTRYPOINT: stagedEntrypoint,
		DEV3_TERMINAL_HOST_PROOF_DIR: sessionDir,
	};
	const stagedVersionOutput = requireSuccess(
		run(stagedRuntime, [stagedEntrypoint, "version"], cleanDir, hostEnv),
		"Staged terminal host version probe",
	);
	const stagedVersion = parseLastJson<HostVersion>(stagedVersionOutput, "Staged terminal host version probe");
	if (
		stagedVersion.bunVersion !== appRuntimeVersion ||
		stagedVersion.carrier !== "bun-runtime-script" ||
		!samePath(stagedVersion.executable, stagedRuntime) ||
		!samePath(stagedVersion.entrypoint, stagedEntrypoint)
	) {
		throw new Error(
			`Staged terminal host identity mismatch: expected ${stagedRuntime} with Bun ${appRuntimeVersion}, ` +
				`got ${JSON.stringify(stagedVersion)}.`,
		);
	}

	const startOutput = requireSuccess(
		run(stagedRuntime, [stagedEntrypoint, "start"], cleanDir, hostEnv, 25_000),
		"Detached packaged terminal host re-entry",
	);
	const state = parseLastJson<HostState>(startOutput, "Detached packaged terminal host re-entry");
	if (
		state.marker !== "DEV3_PACKAGED_DETACHED_HOST_OK" ||
		state.bunVersion !== appRuntimeVersion ||
		state.hostPid <= 0 ||
		state.shellPid <= 0 ||
		state.hostPid === state.shellPid ||
		!samePath(state.executable, stagedRuntime) ||
		!samePath(state.entrypoint, stagedEntrypoint)
	) {
		throw new Error(`Detached packaged terminal host returned invalid state: ${JSON.stringify(state)}`);
	}
	const task = requireSuccess(
		run(join(system32, "tasklist.exe"), ["/FI", `PID eq ${state.hostPid}`, "/FO", "CSV", "/NH"], cleanDir, hostEnv),
		"Detached terminal host image-name probe",
	);
	if (!task.toLowerCase().includes('"dev3-terminal-host.exe"')) {
		throw new Error(`Detached host is not running under the updater-safe image name: ${task}`);
	}

	requireSuccess(
		run(stagedRuntime, [stagedEntrypoint, "stop"], cleanDir, hostEnv, 15_000),
		"Detached packaged terminal host stop",
	);
	hostStopped = true;

	const proof = {
		marker: state.marker,
		rawPty: true,
		systemBunOnPath: false,
		electrobunAppBunVersion: appRuntimeVersion,
		terminalHostBunVersion: state.bunVersion,
		packagedRuntimeBytes: statSync(packagedAppRuntime).size,
		packagedEntrypointBytes: statSync(packagedEntrypoint).size,
		packagedRuntimeSha256: runtimeHash,
		packagedEntrypointSha256: entrypointHash,
		hostArtifactId,
		packagedRuntimePath: packagedAppRuntime,
		packagedEntrypointPath: packagedEntrypoint,
		stagedRuntimePath: stagedRuntime,
		stagedEntrypointPath: stagedEntrypoint,
		detachedHostImageName: "dev3-terminal-host.exe",
		hostPid: state.hostPid,
		powershellPid: state.shellPid,
		ffiModuleAvailable: state.ffiModuleAvailable,
	};
	writeFileSync(join(buildDir, "windows-conpty-package-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
	console.log(`[native-terminal-runtime] ${JSON.stringify(proof)}`);
	console.log("[native-terminal-runtime] verified packaged detached re-entry with no Bun available on PATH");
} finally {
	if (!hostStopped && existsSync(join(sessionDir, "state.json"))) {
		const stagedHosts = findFiles(cleanDir, "dev3-terminal-host.exe");
		const stagedHost = stagedHosts[0];
		const stagedEntrypoints = findFiles(cleanDir, "dev3-terminal-host.js");
		if (stagedHost && stagedEntrypoints[0]) {
			const cleanup = run(stagedHost, [stagedEntrypoints[0], "stop"], cleanDir, {
				...cleanEnv,
				DEV3_TERMINAL_HOST_PROOF_DIR: sessionDir,
			}, 15_000);
			if (cleanup.status !== 0) {
				console.error(`[native-terminal-runtime] cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
			}
		}
	}
	rmSync(cleanDir, { recursive: true, force: true });
}
