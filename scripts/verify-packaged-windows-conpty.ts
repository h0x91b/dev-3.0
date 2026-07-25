/**
 * Windows packaged-host proof. Runs twice per build:
 *
 *   postBuild    — ASSEMBLES the versioned native host image into the app bundle
 *                  (so it ships inside the final update archive) and proves the
 *                  packaged runtime + entrypoint identity.
 *   postPackage  — re-enters with DEV3_VERIFY_UPDATE_ARCHIVE=1, extracts the FINAL
 *                  `.tar.zst`, DISCOVERS the shipped image, validates its merged
 *                  manifest against the archive paths, stages it outside the
 *                  replaceable installation directory, and drives the detached
 *                  host lifecycle from the staged image with no Bun on PATH.
 *
 * Everything it asserts is written to `windows-conpty-package-proof.json` beside
 * the artifacts. No-ops outside Windows.
 */

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
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	NATIVE_TERMINAL_HOST_READY_MARKER,
	assertPackagedConptyRuntime,
	sameNativeTerminalPath,
	type NativeTerminalHostIdentity,
	type NativeTerminalHostProofState,
} from "../src/shared/native-terminal-runtime";
import { NATIVE_SESSION_PROTOCOL_VERSION } from "../src/bun/native-terminal-registry/protocol";
import {
	assemblePackagedImage,
	discoverPackagedImage,
	fingerprintPackagedImage,
	isInsideDirectory,
	listPackagedImages,
	selectPackagedImage,
	stagePackagedImage,
	PACKAGED_HOST_ENTRYPOINT,
	PACKAGED_HOST_IMAGE_PARENT,
} from "../src/bun/native-terminal-registry/host-images/packaged-image";
import type { PackagedHostImageManifest } from "../src/bun/native-terminal-registry/host-images/packaged-image-manifest";

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

/** The bundle directory that becomes the archive's top-level entry; image paths are relative to it. */
function appBundleRootFor(packageRoot: string, pathInsideBundle: string): string {
	const segments = relative(resolve(packageRoot), resolve(pathInsideBundle)).split(/[\\/]/);
	return segments.length > 1 ? join(resolve(packageRoot), segments[0]) : resolve(packageRoot);
}

function toPosix(path: string): string {
	return path.split(/[\\/]/).join("/");
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
const appVersion = process.env.ELECTROBUN_APP_VERSION;
if (!appVersion) throw new Error("Packaged host image assembly requires ELECTROBUN_APP_VERSION from the Electrobun hook.");
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
if (!systemRoot) throw new Error("Packaged ConPTY verification cannot resolve SystemRoot.");
const system32 = join(systemRoot, "System32");
const packageSource = resolvePackageSource(buildDir, system32);
const verifyingArchive = packageSource.archivePath !== null;
const cleanDir = mkdtempSync(join(tmpdir(), "dev3-packaged-conpty-"));
const keepProofFiles = process.env.DEV3_KEEP_CONPTY_PROOF_FILES === "1";
const sessionDir = join(cleanDir, "session");
const stagingRoot = join(cleanDir, "native-host-images");
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
	const appBundleRoot = appBundleRootFor(packageSource.root, packagedAppRuntime);

	const terminalEntrypoints = findFiles(packageSource.root, PACKAGED_HOST_ENTRYPOINT).filter(
		(path) => !path.split(/[\\/]/).includes(PACKAGED_HOST_IMAGE_PARENT),
	);
	if (terminalEntrypoints.length !== 1) {
		throw new Error(
			`Expected exactly one packaged ${PACKAGED_HOST_ENTRYPOINT} outside ${PACKAGED_HOST_IMAGE_PARENT}/ under ${packageSource.root}; ` +
				`found ${terminalEntrypoints.length}. Run bun run build:native before Electrobun packaging.`,
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
	if (buildConfigs.length > 1 || (verifyingArchive && buildConfigs.length !== 1)) {
		throw new Error(
			`Expected ${verifyingArchive ? "exactly one" : "at most one"} packaged build.json ` +
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
	const imageExpectations = {
		os: "win32" as const,
		arch: process.arch === "arm64" ? ("arm64" as const) : ("x64" as const),
		bunVersion: appRuntimeVersion,
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		archiveParent: PACKAGED_HOST_IMAGE_PARENT,
	};

	// postBuild assembles the image into the bundle so it ships in the archive;
	// postPackage must FIND that same image already inside the extracted archive.
	let imageDir: string;
	let imageManifest: PackagedHostImageManifest;
	let imageReused = false;
	if (verifyingArchive) {
		const discovered = discoverPackagedImage(appBundleRoot, imageExpectations);
		if (discovered.status !== "ok") {
			throw new Error(`Final Windows update archive does not ship a usable native host image: ${JSON.stringify(discovered)}`);
		}
		imageDir = discovered.imageDir;
		imageManifest = discovered.manifest;
	} else {
		const assembled = assemblePackagedImage({
			packageRoot: appBundleRoot,
			runtimeSourcePath: packagedAppRuntime,
			entrypointSourcePath: packagedEntrypoint,
			hostVersion: appVersion,
			protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
			bunVersion: appRuntimeVersion,
			runtimeFloor: appRuntimeVersion,
			os: "win32",
			arch: imageExpectations.arch,
		});
		imageDir = assembled.imageDir;
		imageManifest = assembled.manifest;
		imageReused = assembled.reused;
		const verified = discoverPackagedImage(appBundleRoot, imageExpectations);
		if (verified.status !== "ok" || verified.tag !== assembled.tag) {
			throw new Error(`Assembled native host image did not validate inside the bundle: ${JSON.stringify(verified)}`);
		}
	}
	const imageArchivePath = toPosix(relative(appBundleRoot, imageDir));
	if (imageArchivePath !== imageManifest.archiveRoot) {
		throw new Error(`Host image sits at ${imageArchivePath} but its manifest declares ${imageManifest.archiveRoot}.`);
	}

	// Additive staging OUTSIDE the replaceable installation directory.
	const staged = stagePackagedImage({ sourceImageDir: imageDir, stagingRoot, expectations: imageExpectations });
	if (staged.status !== "staged") {
		throw new Error(`Staging the packaged host image failed: ${JSON.stringify(staged)}`);
	}
	if (pathIsWithin(packageSource.root, staged.imageDir) || isInsideDirectory(appBundleRoot, staged.imageDir)) {
		throw new Error(`Host image staging must be outside the replaceable package root ${packageSource.root}.`);
	}
	const stagedRuntime = staged.runtimeCarrierPath;
	const stagedEntrypoint = staged.entrypointPath;
	if (sha256(stagedRuntime) !== runtimeHash || sha256(stagedEntrypoint) !== entrypointHash) {
		throw new Error("Staged host image files differ from the packaged runtime and entrypoint.");
	}
	const stagedFingerprint = fingerprintPackagedImage(staged.imageDir);
	const restagedSameImage = stagePackagedImage({ sourceImageDir: imageDir, stagingRoot, expectations: imageExpectations });
	if (restagedSameImage.status !== "already-staged" || fingerprintPackagedImage(staged.imageDir) !== stagedFingerprint) {
		throw new Error(`Re-staging an existing host image must be a no-op: ${JSON.stringify(restagedSameImage)}`);
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
	// The detached host keeps writing to its own log file rather than a console,
	// which is what keeps the background launch invisible to the user.
	const hostLogRedirected = existsSync(join(sessionDir, "host.log"));

	// Stage a DIFFERENT image beside the running one and prove the old image is
	// untouched, still selectable, and still serving the live host.
	const rollbackPackageRoot = join(cleanDir, "next-package");
	mkdirSync(rollbackPackageRoot, { recursive: true });
	const nextEntrypointSource = join(cleanDir, "next-dev3-terminal-host.js");
	copyFileSync(packagedEntrypoint, nextEntrypointSource);
	writeFileSync(nextEntrypointSource, `${readFileSync(nextEntrypointSource, "utf8")}\n// staged-beside proof\n`);
	const nextImage = assemblePackagedImage({
		packageRoot: rollbackPackageRoot,
		runtimeSourcePath: packagedAppRuntime,
		entrypointSourcePath: nextEntrypointSource,
		hostVersion: appVersion,
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		bunVersion: appRuntimeVersion,
		runtimeFloor: appRuntimeVersion,
		os: "win32",
		arch: imageExpectations.arch,
	});
	if (nextImage.tag === staged.tag) throw new Error("A changed host entrypoint must produce a different image tag.");
	const stagedNext = stagePackagedImage({ sourceImageDir: nextImage.imageDir, stagingRoot, expectations: imageExpectations });
	if (stagedNext.status !== "staged") throw new Error(`Staging a second host image failed: ${JSON.stringify(stagedNext)}`);
	if (fingerprintPackagedImage(staged.imageDir) !== stagedFingerprint) {
		throw new Error("Staging a new host image rewrote the older image the live host was launched from.");
	}
	const rollbackSelection = selectPackagedImage(stagingRoot, { tag: staged.tag });
	if (rollbackSelection.status !== "selected" || rollbackSelection.entrypointPath !== stagedEntrypoint) {
		throw new Error(`Explicit rollback did not select the older staged image: ${JSON.stringify(rollbackSelection)}`);
	}
	const stagedTags = listPackagedImages(stagingRoot).ok.map((entry) => entry.tag).sort();

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
		packageSource: verifyingArchive ? "update-archive" : "build-tree",
		proofFilesRetained: keepProofFiles,
		proofWorkspacePath: cleanDir,
		extractedPackageRoot: packageSource.root,
		appBundleRoot,
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
		packagedRuntimePath: packagedAppRuntime,
		packagedEntrypointPath: packagedEntrypoint,
		hostImageAssembled: !verifyingArchive,
		hostImageReusedExisting: imageReused,
		hostImageTag: staged.tag,
		hostImageDir: imageDir,
		hostImageArchivePath: imageArchivePath,
		hostImageDeclaredArchiveRoot: imageManifest.archiveRoot,
		hostImageProtocolVersion: imageManifest.artifact.protocolVersion,
		hostImageRuntimeFloor: imageManifest.runtimeFloor,
		hostImageOs: imageManifest.artifact.os,
		hostImageArch: imageManifest.artifact.arch,
		hostImageHostVersion: imageManifest.artifact.hostVersion,
		hostImageFiles: imageManifest.artifact.files,
		hostImageFingerprint: stagedFingerprint,
		stagingRoot,
		stagedImageDir: staged.imageDir,
		stagedRuntimePath: stagedRuntime,
		stagedEntrypointPath: stagedEntrypoint,
		stagedOutsideInstallationDirectory: true,
		restagingExistingImageWasNoOp: true,
		stagedBesideImageTag: stagedNext.tag,
		stagedBesideImageDir: stagedNext.imageDir,
		olderImageUnchangedAfterStagingNewOne: true,
		rollbackSelectedTag: rollbackSelection.tag,
		stagedImageTags: stagedTags,
		detachedHostLogRedirected: hostLogRedirected,
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
	console.log(
		`[native-terminal-runtime] verified the ${proof.packageSource} host image ${staged.tag}: ` +
			"staged outside the install root, detached re-entry with no Bun on PATH, old image intact beside the new one",
	);
} finally {
	if (!hostStopped && existsSync(join(sessionDir, "state.json")) && existsSync(stagingRoot)) {
		const stagedHosts = findFiles(stagingRoot, "dev3-terminal-host.exe");
		const stagedHost = stagedHosts[0];
		const stagedEntrypoints = stagedHost ? [join(dirname(stagedHost), PACKAGED_HOST_ENTRYPOINT)] : [];
		if (stagedHost && stagedEntrypoints[0] && existsSync(stagedEntrypoints[0])) {
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
