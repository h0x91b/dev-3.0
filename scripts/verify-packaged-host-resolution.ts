/**
 * Prove an already-built package resolves its OWN native host image — the exact
 * thing seq 1311 could not do on macOS.
 *
 * Run after `bun run build` (or against any build directory):
 *
 *   bun scripts/verify-packaged-host-resolution.ts [buildDir]
 *
 * It bundles the resolution probe with `bun build --target=bun` so the resolver
 * cannot fall back to a source checkout, then runs that bundle under the
 * PACKAGED Bun runtime with a sanitized environment: no `DEV3_NATIVE_HOST_ENTRYPOINT`,
 * no Bun on PATH, and a throwaway staging root. A `packaged-image` verdict is
 * therefore only reachable through the image the package actually ships.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { discoverPackagedImage } from "../src/bun/native-terminal-registry/host-images/packaged-image";
import {
	hostImageRootForPackagedCli,
	nativeHostPackageLayout,
	packagedRuntimePathIn,
} from "../src/bun/native-terminal-registry/host-images/package-layout";
import type { ManifestOs } from "../src/bun/native-terminal-registry/host-images/artifact-manifest";

const PROBE_MARKER = "DEV3_RESOLUTION_PROBE ";

interface ResolvedRuntimeReport {
	execPath: string;
	kind: string;
	runtimePath: string;
	entrypointPath: string;
	imageTag?: string;
	origin: string;
}

function currentManifestOs(): ManifestOs {
	if (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") return process.platform;
	throw new Error(`No packaged host image is defined for ${process.platform}.`);
}

function singleBundleRuntime(buildDir: string, os: ManifestOs): string {
	const runtimes = readdirSync(buildDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => packagedRuntimePathIn(os, join(buildDir, entry.name)))
		.filter((path): path is string => path !== null);
	if (runtimes.length !== 1) {
		throw new Error(`Expected exactly one built app bundle under ${buildDir}; found ${runtimes.length}.`);
	}
	return runtimes[0];
}

function defaultBuildDir(): string {
	const buildRoot = resolve(import.meta.dir, "../build");
	if (!existsSync(buildRoot)) throw new Error(`No build directory at ${buildRoot}; run \`bun run build\` first.`);
	const candidates = readdirSync(buildRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	if (candidates.length !== 1) {
		throw new Error(`${buildRoot} holds ${candidates.length} build directories; pass the one to verify as an argument.`);
	}
	return join(buildRoot, candidates[0].name);
}

const buildDir = resolve(process.argv[2] ?? defaultBuildDir());
const os = currentManifestOs();
const layout = nativeHostPackageLayout(os, singleBundleRuntime(buildDir, os));

const shipped = discoverPackagedImage(layout.hostImagePackageRoot);
if (shipped.status !== "ok") {
	throw new Error(`This package ships no usable native host image: ${JSON.stringify(shipped)}`);
}

const workspace = mkdtempSync(join(tmpdir(), "dev3-host-resolution-"));
const probeSource = resolve(import.meta.dir, "native-host-resolution-probe.ts");
/** The bundled `dev3` CLI's directory — what `dev3 remote` / headless mode runs from. */
const bundledCliDir = join(layout.hostImagePackageRoot, "Resources", "app", "cli");

function probeEnv(stagingRoot: string): NodeJS.ProcessEnv {
	return {
		PATH: process.platform === "win32" ? (process.env.PATH ?? "") : ["/usr/bin", "/bin"].join(delimiter),
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		SystemRoot: process.env.SystemRoot,
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		DEV3_NATIVE_HOST_IMAGES_DIR: stagingRoot,
	};
}

/** Run one probe process and hold its verdict to the packaged-image contract. */
function checkResolution(label: string, executable: string, args: string[], stagingRoot: string): ResolvedRuntimeReport {
	const probe = spawnSync(executable, args, { cwd: workspace, encoding: "utf8", timeout: 120_000, env: probeEnv(stagingRoot) });
	const reportLine = (probe.stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.startsWith(PROBE_MARKER));
	if (!reportLine) {
		throw new Error(
			`${label} could not resolve a native host (exit ${probe.status ?? "none"}).\n` +
				`stdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
		);
	}
	const resolved = JSON.parse(reportLine.slice(PROBE_MARKER.length)) as ResolvedRuntimeReport;
	if (resolved.kind !== "packaged-image") {
		throw new Error(`${label} resolved a ${resolved.kind} host, not the packaged image: ${JSON.stringify(resolved)}`);
	}
	if (resolved.imageTag !== shipped.tag) {
		throw new Error(`${label} launched image ${resolved.imageTag}, but this package ships ${shipped.tag}.`);
	}
	if (!resolved.entrypointPath.startsWith(stagingRoot)) {
		throw new Error(`${label} must run from the staged copy under ${stagingRoot}, not ${resolved.entrypointPath}.`);
	}
	return resolved;
}

try {
	// 1. Desktop app: the packaged Bun runs a bundled script.
	const probeBundle = join(workspace, "resolution-probe.js");
	const build = spawnSync(
		process.execPath,
		["build", probeSource, "--target=bun", "--outfile", probeBundle],
		{ cwd: resolve(import.meta.dir, ".."), env: process.env, encoding: "utf8" },
	);
	if (build.status !== 0) throw new Error(`Failed to bundle the resolution probe.\n${build.stdout}\n${build.stderr}`);

	const desktopStagingRoot = join(workspace, "native-host-images-desktop");
	const resolved = checkResolution("The packaged desktop runtime", layout.runtimePath, [probeBundle], desktopStagingRoot);

	// 2. Bundled CLI: `dev3 remote` / headless mode, several levels deeper. A
	// compiled binary dropped into the real cli/ directory reproduces its
	// process.execPath exactly; nothing else in the bundle is touched.
	if (!existsSync(bundledCliDir)) throw new Error(`This package ships no bundled CLI directory at ${bundledCliDir}.`);
	if (hostImageRootForPackagedCli(bundledCliDir) !== layout.hostImagePackageRoot) {
		throw new Error(
			`The bundled CLI at ${bundledCliDir} derives image root ` +
				`${hostImageRootForPackagedCli(bundledCliDir)}, but the image was assembled into ${layout.hostImagePackageRoot}.`,
		);
	}
	const cliProbePath = join(bundledCliDir, process.platform === "win32" ? "dev3-host-probe.exe" : "dev3-host-probe");
	const cliStagingRoot = join(workspace, "native-host-images-cli");
	let cliResolved: ResolvedRuntimeReport;
	try {
		const compile = spawnSync(
			process.execPath,
			["build", probeSource, "--compile", "--outfile", cliProbePath],
			{ cwd: resolve(import.meta.dir, ".."), env: process.env, encoding: "utf8" },
		);
		if (compile.status !== 0) throw new Error(`Failed to compile the CLI-layout probe.\n${compile.stdout}\n${compile.stderr}`);
		cliResolved = checkResolution("The bundled dev3 CLI", cliProbePath, [], cliStagingRoot);
	} finally {
		rmSync(cliProbePath, { force: true });
	}

	const proof = {
		platform: os,
		buildDir,
		appBundleRoot: layout.appBundleRoot,
		hostImagePackageRoot: layout.hostImagePackageRoot,
		shippedImageTag: shipped.tag,
		shippedImageDir: shipped.imageDir,
		resolvedKind: resolved.kind,
		resolvedImageTag: resolved.imageTag,
		resolvedRuntimePath: resolved.runtimePath,
		resolvedEntrypointPath: resolved.entrypointPath,
		resolvedFromStagedCopy: true,
		probeWasBundled: true,
		environmentOverrideUsed: false,
		packagedRuntimeExecPath: resolved.execPath,
		bundledCliDir,
		bundledCliResolvedKind: cliResolved.kind,
		bundledCliResolvedImageTag: cliResolved.imageTag,
		bundledCliResolvedEntrypointPath: cliResolved.entrypointPath,
		bundledCliExecPath: cliResolved.execPath,
	};
	writeFileSync(join(buildDir, "native-host-resolution-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
	console.log(
		`[native-terminal-runtime] packaged ${os} app resolved host image ${shipped.tag} from both the desktop runtime ` +
			`and the bundled CLI layout (${bundledCliDir})`,
	);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
