/**
 * macOS + Linux packaged-host proof, the sibling of the Windows one.
 *
 * Runs as Electrobun `postBuild` and does the same two jobs the Windows script
 * does for its own package:
 *
 *   1. ASSEMBLE the versioned native host image into the app bundle, so it ships
 *      inside the final update archive.
 *   2. PROVE it: version identity from the packaged runtime with no Bun on PATH,
 *      additive staging outside the replaceable install directory, and a full
 *      detached host start / reattach / stop cycle from the staged image.
 *
 * Before this existed, `bun run build:native` no-opped outside Windows and no
 * package carried an image, so an explicitly-native task on macOS sat in
 * Preparing behind an honest NativeHostRuntimeError (seq 1311).
 *
 * Everything it asserts lands in `native-host-package-proof.json` beside the
 * build. No-ops on Windows, which has its own richer proof.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
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
	stagePackagedImage,
	PACKAGED_HOST_IMAGE_PARENT,
} from "../src/bun/native-terminal-registry/host-images/packaged-image";
import {
	manifestArchForElectrobunArch,
	manifestOsForElectrobunOs,
	nativeHostPackageLayout,
	packagedRuntimePathIn,
} from "../src/bun/native-terminal-registry/host-images/package-layout";

if (process.platform === "win32") {
	console.log("[native-terminal-runtime] POSIX packaged-host proof skipped on Windows");
	process.exit(0);
}

/** No Bun, no Homebrew — the packaged runtime has to carry the host on its own. */
const CLEAN_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 25_000): string {
	const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout });
	if (result.status !== 0 || result.error) {
		throw new Error(
			`${executable} ${args.join(" ")} failed (exit ${result.status ?? "none"}` +
				`${result.error ? `, ${result.error.message}` : ""}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	return (result.stdout ?? "").trim();
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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
if (!buildDir || !existsSync(buildDir)) {
	throw new Error(`Electrobun did not provide a valid ELECTROBUN_BUILD_DIR (${buildDir ?? "missing"}).`);
}
const appVersion = process.env.ELECTROBUN_APP_VERSION;
if (!appVersion) throw new Error("Packaged host image assembly requires ELECTROBUN_APP_VERSION from the Electrobun hook.");

const targetOs = manifestOsForElectrobunOs(process.env.ELECTROBUN_OS);
const targetArch = manifestArchForElectrobunArch(process.env.ELECTROBUN_ARCH);

const bundleRuntimes = readdirSync(buildDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => packagedRuntimePathIn(targetOs, join(buildDir, entry.name)))
	.filter((path): path is string => path !== null);
if (bundleRuntimes.length !== 1) {
	throw new Error(
		`Expected exactly one Electrobun app bundle carrying a packaged Bun runtime under ${buildDir}; found ${bundleRuntimes.length}.`,
	);
}

const layout = nativeHostPackageLayout(targetOs, bundleRuntimes[0]);
if (!existsSync(layout.entrypointPath)) {
	throw new Error(
		`This package ships no native terminal host at ${layout.entrypointPath}. ` +
			"Run `bun run build:native` before Electrobun packaging.",
	);
}

const cleanDir = mkdtempSync(join(tmpdir(), "dev3-packaged-native-host-"));
const sessionDir = join(cleanDir, "session");
const stagingRoot = join(cleanDir, "native-host-images");
const cleanEnv: NodeJS.ProcessEnv = {
	PATH: CLEAN_PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR ?? tmpdir(),
	TERM: "xterm-256color",
};
const keepProofFiles = process.env.DEV3_KEEP_CONPTY_PROOF_FILES === "1";

let hostStopped = false;
let stagedEntrypointForCleanup: { runtime: string; entrypoint: string } | null = null;
try {
	const appRuntimeVersion = assertPackagedConptyRuntime(run(layout.runtimePath, ["--version"], cleanDir, cleanEnv));

	const packagedVersion = parseLastJson<NativeTerminalHostIdentity>(
		run(layout.runtimePath, [layout.entrypointPath, "version"], cleanDir, cleanEnv),
		"Packaged terminal host version probe",
	);
	if (
		assertPackagedConptyRuntime(packagedVersion.bunVersion) !== appRuntimeVersion ||
		packagedVersion.carrier !== "bun-runtime-script" ||
		!sameNativeTerminalPath(packagedVersion.executable, layout.runtimePath) ||
		!sameNativeTerminalPath(packagedVersion.entrypoint, layout.entrypointPath)
	) {
		throw new Error(`Packaged terminal host identity mismatch: ${JSON.stringify(packagedVersion)}`);
	}

	const expectations = {
		os: targetOs,
		arch: targetArch,
		bunVersion: appRuntimeVersion,
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		archiveParent: PACKAGED_HOST_IMAGE_PARENT,
	};
	const assembled = assemblePackagedImage({
		packageRoot: layout.hostImagePackageRoot,
		runtimeSourcePath: layout.runtimePath,
		entrypointSourcePath: layout.entrypointPath,
		hostVersion: appVersion,
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		bunVersion: appRuntimeVersion,
		runtimeFloor: appRuntimeVersion,
		os: targetOs,
		arch: targetArch,
	});
	const discovered = discoverPackagedImage(layout.hostImagePackageRoot, expectations);
	if (discovered.status !== "ok" || discovered.tag !== assembled.tag) {
		throw new Error(`Assembled native host image did not validate inside the bundle: ${JSON.stringify(discovered)}`);
	}

	// Additive staging OUTSIDE the replaceable installation directory: an update
	// swaps the bundle out from under a live host, the staged copy survives it.
	const staged = stagePackagedImage({ sourceImageDir: discovered.imageDir, stagingRoot, expectations });
	if (staged.status !== "staged") throw new Error(`Staging the packaged host image failed: ${JSON.stringify(staged)}`);
	if (isInsideDirectory(layout.appBundleRoot, staged.imageDir)) {
		throw new Error(`Host image staging must be outside the replaceable bundle ${layout.appBundleRoot}.`);
	}
	if (sha256(staged.runtimeCarrierPath) !== sha256(layout.runtimePath) || sha256(staged.entrypointPath) !== sha256(layout.entrypointPath)) {
		throw new Error("Staged host image files differ from the packaged runtime and entrypoint.");
	}
	if ((statSync(staged.runtimeCarrierPath).mode & 0o111) === 0) {
		throw new Error(`Staged runtime carrier ${staged.runtimeCarrierPath} lost its executable bit.`);
	}
	const stagedFingerprint = fingerprintPackagedImage(staged.imageDir);
	const restaged = stagePackagedImage({ sourceImageDir: discovered.imageDir, stagingRoot, expectations });
	if (restaged.status !== "already-staged" || fingerprintPackagedImage(staged.imageDir) !== stagedFingerprint) {
		throw new Error(`Re-staging an existing host image must be a no-op: ${JSON.stringify(restaged)}`);
	}

	const hostEnv: NodeJS.ProcessEnv = {
		...cleanEnv,
		DEV3_EXPECT_HOST_EXECUTABLE: staged.runtimeCarrierPath,
		DEV3_TERMINAL_HOST_ENTRYPOINT: staged.entrypointPath,
		DEV3_TERMINAL_HOST_PROOF_DIR: sessionDir,
	};
	stagedEntrypointForCleanup = { runtime: staged.runtimeCarrierPath, entrypoint: staged.entrypointPath };

	const stagedVersion = parseLastJson<NativeTerminalHostIdentity>(
		run(staged.runtimeCarrierPath, [staged.entrypointPath, "version"], cleanDir, hostEnv),
		"Staged terminal host version probe",
	);
	if (
		stagedVersion.bunVersion !== appRuntimeVersion ||
		stagedVersion.carrier !== "bun-runtime-script" ||
		!sameNativeTerminalPath(stagedVersion.executable, staged.runtimeCarrierPath) ||
		!sameNativeTerminalPath(stagedVersion.entrypoint, staged.entrypointPath)
	) {
		throw new Error(`Staged terminal host identity mismatch: ${JSON.stringify(stagedVersion)}`);
	}

	const state = parseLastJson<NativeTerminalHostProofState>(
		run(staged.runtimeCarrierPath, [staged.entrypointPath, "start"], cleanDir, hostEnv),
		"Detached packaged terminal host re-entry",
	);
	if (
		state.marker !== NATIVE_TERMINAL_HOST_READY_MARKER ||
		state.bunVersion !== appRuntimeVersion ||
		state.hostPid <= 0 ||
		state.shellPid <= 0 ||
		state.hostPid === state.shellPid ||
		!sameNativeTerminalPath(state.executable, staged.runtimeCarrierPath) ||
		!sameNativeTerminalPath(state.entrypoint, staged.entrypointPath)
	) {
		throw new Error(`Detached packaged terminal host returned invalid state: ${JSON.stringify(state)}`);
	}
	const hostLogRedirected = existsSync(join(sessionDir, "host.log"));

	const reattached = parseLastJson<NativeTerminalHostProofState>(
		run(staged.runtimeCarrierPath, [staged.entrypointPath, "reattach"], cleanDir, hostEnv, 15_000),
		"Detached packaged terminal host reattach",
	);
	const reattachSamePids = reattached.hostPid === state.hostPid && reattached.shellPid === state.shellPid;
	if (!reattachSamePids || reattached.marker !== state.marker || reattached.bunVersion !== state.bunVersion) {
		throw new Error(
			`Detached terminal host reattach changed process identity: started ${JSON.stringify(state)}, reattached ${JSON.stringify(reattached)}.`,
		);
	}

	const stopped = parseLastJson<{ stopped: boolean; hostPid: number; shellPid: number }>(
		run(staged.runtimeCarrierPath, [staged.entrypointPath, "stop"], cleanDir, hostEnv, 15_000),
		"Detached packaged terminal host stop",
	);
	if (!stopped.stopped || stopped.hostPid !== state.hostPid || stopped.shellPid !== state.shellPid) {
		throw new Error(`Detached terminal host returned invalid stop state: ${JSON.stringify(stopped)}`);
	}
	hostStopped = true;
	if (isProcessAlive(state.hostPid) || isProcessAlive(state.shellPid)) {
		throw new Error(`Detached terminal processes survived stop (host ${state.hostPid}, shell ${state.shellPid}).`);
	}

	const proof = {
		marker: state.marker,
		platform: targetOs,
		arch: targetArch,
		appBundleRoot: layout.appBundleRoot,
		hostImagePackageRoot: layout.hostImagePackageRoot,
		systemBunOnPath: false,
		packagedRuntimePath: layout.runtimePath,
		packagedEntrypointPath: layout.entrypointPath,
		packagedRuntimeSha256: sha256(layout.runtimePath),
		packagedEntrypointSha256: sha256(layout.entrypointPath),
		electrobunAppBunVersion: appRuntimeVersion,
		terminalHostBunVersion: state.bunVersion,
		hostImageReusedExisting: assembled.reused,
		hostImageTag: assembled.tag,
		hostImageDir: assembled.imageDir,
		hostImageArchivePath: relative(resolve(layout.appBundleRoot), resolve(assembled.imageDir)),
		hostImageDeclaredArchiveRoot: assembled.manifest.archiveRoot,
		hostImageRuntimeCarrier: assembled.manifest.runtimeCarrier,
		hostImageProtocolVersion: assembled.manifest.artifact.protocolVersion,
		hostImageRuntimeFloor: assembled.manifest.runtimeFloor,
		hostImageFiles: assembled.manifest.artifact.files,
		hostImageFingerprint: stagedFingerprint,
		stagedImageDir: staged.imageDir,
		stagedOutsideInstallationDirectory: true,
		restagingExistingImageWasNoOp: true,
		detachedHostLogRedirected: hostLogRedirected,
		hostPid: state.hostPid,
		shellPid: state.shellPid,
		reattachSamePids,
		hostStopped: true,
		ffiModuleAvailable: state.ffiModuleAvailable,
	};
	writeFileSync(join(buildDir, "native-host-package-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
	console.log(
		`[native-terminal-runtime] verified the ${targetOs} host image ${assembled.tag} at ${proof.hostImageArchivePath}: ` +
			"staged outside the install root, detached re-entry with no Bun on PATH",
	);
} finally {
	if (!hostStopped && stagedEntrypointForCleanup && existsSync(join(sessionDir, "state.json"))) {
		const cleanup = spawnSync(
			stagedEntrypointForCleanup.runtime,
			[stagedEntrypointForCleanup.entrypoint, "stop"],
			{ cwd: cleanDir, env: { ...cleanEnv, DEV3_TERMINAL_HOST_PROOF_DIR: sessionDir }, encoding: "utf8", timeout: 15_000 },
		);
		if (cleanup.status !== 0) console.error(`[native-terminal-runtime] cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
	}
	if (keepProofFiles) console.log(`[native-terminal-runtime] retained manual proof files under ${cleanDir}`);
	else rmSync(cleanDir, { recursive: true, force: true });
}
