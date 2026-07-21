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
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import {
	NATIVE_TERMINAL_HOST_READY_MARKER,
	assertPackagedConptyRuntime,
	sameNativeTerminalPath,
	type NativeTerminalHostIdentity,
	type NativeTerminalHostProofState,
} from "../src/shared/native-terminal-runtime";

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

interface PackageSource {
	root: string;
	proofDir: string;
	archivePath: string | null;
	cleanupDir: string | null;
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

function pathIsWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(resolve(root), resolve(candidate));
	return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function tasklistImageForPid(output: string, pid: number): string | null {
	for (const line of output.split(/\r?\n/)) {
		const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
		if (match && Number(match[2]) === pid) return match[1];
	}
	return null;
}

function resolvePackageSource(buildDir: string, system32: string): PackageSource {
	if (process.env.DEV3_VERIFY_UPDATE_ARCHIVE !== "1") {
		return { root: buildDir, proofDir: buildDir, archivePath: null, cleanupDir: null };
	}

	const artifactDir = process.env.ELECTROBUN_ARTIFACT_DIR;
	const buildEnvironment = process.env.ELECTROBUN_BUILD_ENV;
	const targetOS = process.env.ELECTROBUN_OS;
	const targetArch = process.env.ELECTROBUN_ARCH;
	const appName = process.env.ELECTROBUN_APP_NAME;
	if (!artifactDir || !buildEnvironment || targetOS !== "win" || !targetArch || !appName) {
		throw new Error(
			"Final Electrobun archive proof requires ELECTROBUN_ARTIFACT_DIR, ELECTROBUN_BUILD_ENV, " +
				"ELECTROBUN_OS=win, ELECTROBUN_ARCH, and ELECTROBUN_APP_NAME.",
		);
	}
	const archivePath = resolve(artifactDir, `${buildEnvironment}-${targetOS}-${targetArch}-${appName}.tar.zst`);
	if (!existsSync(archivePath)) {
		throw new Error(`Electrobun did not emit the expected Windows update archive: ${archivePath}`);
	}

	const zstdPath = resolve(import.meta.dir, `../node_modules/electrobun/dist-win-${targetArch}/zig-zstd.exe`);
	const tarPath = join(system32, "tar.exe");
	if (!existsSync(zstdPath)) throw new Error(`Electrobun archive verifier cannot find zig-zstd at ${zstdPath}.`);
	if (!existsSync(tarPath)) throw new Error(`Electrobun archive verifier cannot find Windows tar at ${tarPath}.`);

	const cleanupDir = mkdtempSync(join(tmpdir(), "dev3-conpty-archive-"));
	const unpackedDir = join(cleanupDir, "unpacked");
	mkdirSync(unpackedDir, { recursive: true });
	try {
		requireSuccess(
			run(zstdPath, ["decompress", "-i", archivePath, "-o", "package.tar"], cleanupDir, process.env, 120_000),
			"Electrobun update archive decompression",
		);
		requireSuccess(
			run(tarPath, ["-xf", "package.tar", "-C", "unpacked"], cleanupDir, process.env, 120_000),
			"Electrobun update archive extraction",
		);
		return { root: unpackedDir, proofDir: artifactDir, archivePath, cleanupDir };
	} catch (error) {
		rmSync(cleanupDir, { recursive: true, force: true });
		throw error;
	}
}

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir || !existsSync(buildDir)) {
	throw new Error(`Electrobun did not provide a valid ELECTROBUN_BUILD_DIR (${buildDir ?? "missing"}).`);
}
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
if (!systemRoot) throw new Error("Packaged ConPTY verification cannot resolve SystemRoot.");
const system32 = join(systemRoot, "System32");
const packageSource = resolvePackageSource(buildDir, system32);
const cleanDir = mkdtempSync(join(tmpdir(), "dev3-packaged-conpty-"));
const keepProofFiles = process.env.DEV3_KEEP_CONPTY_PROOF_FILES === "1";
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
	const appRuntimes = findFiles(packageSource.root, "bun.exe");
	if (appRuntimes.length !== 1) {
		throw new Error(
			`Expected exactly one Electrobun app runtime under ${packageSource.root}; found ${appRuntimes.length} bun.exe files.`,
		);
	}
	const packagedAppRuntime = resolve(appRuntimes[0]);

	const terminalEntrypoints = findFiles(packageSource.root, "dev3-terminal-host.js");
	if (terminalEntrypoints.length !== 1) {
		throw new Error(
			`Expected exactly one packaged dev3-terminal-host.js under ${packageSource.root}; found ${terminalEntrypoints.length}. ` +
				"Run bun run build:native before Electrobun packaging.",
		);
	}
	const packagedEntrypoint = resolve(terminalEntrypoints[0]);

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
	const buildConfigs = findFiles(packageSource.root, "build.json");
	if (buildConfigs.length > 1 || (packageSource.archivePath !== null && buildConfigs.length !== 1)) {
		throw new Error(
			`Expected ${packageSource.archivePath ? "exactly one" : "at most one"} packaged build.json ` +
				`under ${packageSource.root}; found ${buildConfigs.length}.`,
		);
	}
	const buildJsonBunVersion = buildConfigs[0]
		? String(JSON.parse(readFileSync(buildConfigs[0], "utf8")).bunVersion ?? "")
		: null;
	if (buildJsonBunVersion !== null && appRuntimeVersion !== buildJsonBunVersion) {
		throw new Error(
			`Electrobun copied Bun ${appRuntimeVersion}, but packaged build.json declares ${buildJsonBunVersion || "no version"}.`,
		);
	}

	const packagedVersionOutput = requireSuccess(
		run(packagedAppRuntime, [packagedEntrypoint, "version"], cleanDir, cleanEnv),
		"Packaged terminal host version probe",
	);
	const packagedVersion = parseLastJson<NativeTerminalHostIdentity>(
		packagedVersionOutput,
		"Packaged terminal host version probe",
	);
	if (assertPackagedConptyRuntime(packagedVersion.bunVersion) !== appRuntimeVersion) {
		throw new Error(`Packaged terminal host reports Bun ${packagedVersion.bunVersion}; expected ${appRuntimeVersion}.`);
	}
	if (
		packagedVersion.carrier !== "bun-runtime-script" ||
		!sameNativeTerminalPath(packagedVersion.executable, packagedAppRuntime) ||
		!sameNativeTerminalPath(packagedVersion.entrypoint, packagedEntrypoint)
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
	if (pathIsWithin(packageSource.root, stagedRuntime) || pathIsWithin(packageSource.root, stagedEntrypoint)) {
		throw new Error(`Terminal host staging must be outside the replaceable package root ${packageSource.root}.`);
	}
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
	const stagedVersion = parseLastJson<NativeTerminalHostIdentity>(stagedVersionOutput, "Staged terminal host version probe");
	if (
		stagedVersion.bunVersion !== appRuntimeVersion ||
		stagedVersion.carrier !== "bun-runtime-script" ||
		!sameNativeTerminalPath(stagedVersion.executable, stagedRuntime) ||
		!sameNativeTerminalPath(stagedVersion.entrypoint, stagedEntrypoint)
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
	const state = parseLastJson<NativeTerminalHostProofState>(startOutput, "Detached packaged terminal host re-entry");
	if (
		state.marker !== NATIVE_TERMINAL_HOST_READY_MARKER ||
		state.bunVersion !== appRuntimeVersion ||
		state.hostPid <= 0 ||
		state.shellPid <= 0 ||
		state.hostPid === state.shellPid ||
		!sameNativeTerminalPath(state.executable, stagedRuntime) ||
		!sameNativeTerminalPath(state.entrypoint, stagedEntrypoint)
	) {
		throw new Error(`Detached packaged terminal host returned invalid state: ${JSON.stringify(state)}`);
	}
	const reattachOutput = requireSuccess(
		run(stagedRuntime, [stagedEntrypoint, "reattach"], cleanDir, hostEnv, 15_000),
		"Detached packaged terminal host reattach",
	);
	const reattachedState = parseLastJson<NativeTerminalHostProofState>(
		reattachOutput,
		"Detached packaged terminal host reattach",
	);
	const reattachSamePids =
		reattachedState.hostPid === state.hostPid && reattachedState.shellPid === state.shellPid;
	if (
		!reattachSamePids ||
		reattachedState.marker !== state.marker ||
		reattachedState.bunVersion !== state.bunVersion ||
		!sameNativeTerminalPath(reattachedState.executable, state.executable) ||
		!sameNativeTerminalPath(reattachedState.entrypoint, state.entrypoint)
	) {
		throw new Error(
			`Detached terminal host reattach changed process identity: started ${JSON.stringify(state)}, ` +
				`reattached ${JSON.stringify(reattachedState)}.`,
		);
	}

	const hostTasklist = requireSuccess(
		run(join(system32, "tasklist.exe"), ["/FI", `PID eq ${state.hostPid}`, "/FO", "CSV", "/NH"], cleanDir, hostEnv),
		"Detached terminal host image-name probe",
	);
	const hostImageName = tasklistImageForPid(hostTasklist, state.hostPid);
	if (hostImageName?.toLowerCase() !== "dev3-terminal-host.exe") {
		throw new Error(`Detached host is not running under the updater-safe image name: ${hostTasklist}`);
	}
	const powershellTasklist = requireSuccess(
		run(join(system32, "tasklist.exe"), ["/FI", `PID eq ${state.shellPid}`, "/FO", "CSV", "/NH"], cleanDir, hostEnv),
		"PowerShell image-name probe",
	);
	const powershellImageName = tasklistImageForPid(powershellTasklist, state.shellPid);
	if (powershellImageName?.toLowerCase() !== "powershell.exe") {
		throw new Error(`Bun.Terminal child is not the expected PowerShell process: ${powershellTasklist}`);
	}

	const stopOutput = requireSuccess(
		run(stagedRuntime, [stagedEntrypoint, "stop"], cleanDir, hostEnv, 15_000),
		"Detached packaged terminal host stop",
	);
	const stopped = parseLastJson<{ stopped: boolean; hostPid: number; shellPid: number }>(
		stopOutput,
		"Detached packaged terminal host stop",
	);
	if (!stopped.stopped || stopped.hostPid !== state.hostPid || stopped.shellPid !== state.shellPid) {
		throw new Error(`Detached terminal host returned invalid stop state: ${JSON.stringify(stopped)}`);
	}
	hostStopped = true;
	const hostAfterStop = requireSuccess(
		run(join(system32, "tasklist.exe"), ["/FI", `PID eq ${state.hostPid}`, "/FO", "CSV", "/NH"], cleanDir, hostEnv),
		"Stopped terminal host process probe",
	);
	const powershellAfterStop = requireSuccess(
		run(join(system32, "tasklist.exe"), ["/FI", `PID eq ${state.shellPid}`, "/FO", "CSV", "/NH"], cleanDir, hostEnv),
		"Stopped PowerShell process probe",
	);
	if (tasklistImageForPid(hostAfterStop, state.hostPid) || tasklistImageForPid(powershellAfterStop, state.shellPid)) {
		throw new Error(
			`Detached terminal processes survived stop. Host: ${hostAfterStop}; PowerShell: ${powershellAfterStop}`,
		);
	}

	const proof = {
		marker: state.marker,
		rawPty: true,
		systemBunOnPath: false,
		packageSource: packageSource.archivePath ? "update-archive" : "build-tree",
		proofFilesRetained: keepProofFiles,
		proofWorkspacePath: cleanDir,
		extractedPackageRoot: packageSource.root,
		archiveExtractionWorkspacePath: packageSource.cleanupDir,
		updateArchivePath: packageSource.archivePath,
		updateArchiveBytes: packageSource.archivePath ? statSync(packageSource.archivePath).size : null,
		updateArchiveSha256: packageSource.archivePath ? sha256(packageSource.archivePath) : null,
		electrobunAppBunVersion: appRuntimeVersion,
		packagedBuildJsonBunVersion: buildJsonBunVersion,
		runtimeMatchesBuildMetadata: buildJsonBunVersion === null || buildJsonBunVersion === appRuntimeVersion,
		terminalHostBunVersion: state.bunVersion,
		packagedRuntimeBytes: statSync(packagedAppRuntime).size,
		packagedEntrypointBytes: statSync(packagedEntrypoint).size,
		packagedRuntimeSha256: runtimeHash,
		packagedEntrypointSha256: entrypointHash,
		hostArtifactId,
		packagedRuntimePath: packagedAppRuntime,
		packagedEntrypointPath: packagedEntrypoint,
		packagedRuntimeArchiveEntry: packageSource.archivePath
			? relative(packageSource.root, packagedAppRuntime)
			: null,
		packagedEntrypointArchiveEntry: packageSource.archivePath
			? relative(packageSource.root, packagedEntrypoint)
			: null,
		stagedRuntimePath: stagedRuntime,
		stagedEntrypointPath: stagedEntrypoint,
		stagedOutsideInstallationDirectory: true,
		detachedHostImageName: hostImageName,
		detachedHostTasklist: hostTasklist,
		powershellImageName,
		powershellTasklist,
		hostPid: state.hostPid,
		powershellPid: state.shellPid,
		reattachSamePids,
		reattachedHostPid: reattachedState.hostPid,
		reattachedPowershellPid: reattachedState.shellPid,
		hostStopped: true,
		powershellStopped: true,
		ffiModuleAvailable: state.ffiModuleAvailable,
	};
	writeFileSync(join(packageSource.proofDir, "windows-conpty-package-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
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
	if (keepProofFiles) {
		console.log(`[native-terminal-runtime] retained manual proof files under ${cleanDir}`);
	} else {
		rmSync(cleanDir, { recursive: true, force: true });
		if (packageSource.cleanupDir) rmSync(packageSource.cleanupDir, { recursive: true, force: true });
	}
}
