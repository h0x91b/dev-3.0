/**
 * Where a packaged native host image lives inside an Electrobun bundle, per OS.
 *
 * Electrobun emits three different shapes, and the packaged-image contract has
 * exactly one hard constraint: the directory the image is written under must be
 * one of the roots {@link packagedHostImageRoots} probes at runtime — the
 * directory holding the packaged Bun runtime, or its parent.
 *
 *   macOS    <bundle>.app/Contents/MacOS/bun      → image root <bundle>.app/Contents
 *   Linux    <bundle>/bin/bun                     → image root <bundle>
 *   Windows  <bundle>\bin\bun.exe                 → image root <bundle>
 *
 * On macOS that deliberately puts `native-host-image/` beside `MacOS/` and
 * `Resources/` rather than inside `Resources/app/`: the app directory is what
 * Electrobun would pack into an asar, and an image inside an archive cannot be
 * executed. `Contents/` is also the only place the runtime resolver can reach
 * without a darwin-specific probe.
 *
 * `appBundleRoot` is the single top-level entry Electrobun puts into the
 * `.tar.zst` update archive; on macOS it is NOT the image root, which is why the
 * two are separate fields.
 *
 * Pure node:path except for one small `existsSync` probe, so it unit-tests
 * without a build.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ManifestArch, ManifestOs } from "./artifact-manifest";
import { PACKAGED_HOST_ENTRYPOINT } from "./packaged-image";

/** Electrobun's own OS token (`ELECTROBUN_OS`) → the manifest's `ManifestOs`. */
export function manifestOsForElectrobunOs(electrobunOs: string | undefined): ManifestOs {
	if (electrobunOs === "macos") return "darwin";
	if (electrobunOs === "linux") return "linux";
	if (electrobunOs === "win") return "win32";
	throw new Error(`Unsupported ELECTROBUN_OS ${JSON.stringify(electrobunOs ?? "")}; expected macos, linux, or win.`);
}

/** `ELECTROBUN_ARCH` → the manifest's `ManifestArch`; anything unknown is x64. */
export function manifestArchForElectrobunArch(electrobunArch: string | undefined): ManifestArch {
	return electrobunArch === "arm64" ? "arm64" : "x64";
}

/** Filename of the Bun runtime Electrobun copies into the bundle. */
export function packagedRuntimeFileName(os: ManifestOs): string {
	return os === "win32" ? "bun.exe" : "bun";
}

export interface NativeHostPackageLayout {
	/** Top-level directory Electrobun puts into the update archive. */
	appBundleRoot: string;
	/** Directory whose `native-host-image/` the image is assembled into. */
	hostImagePackageRoot: string;
	/** Packaged Bun runtime, copied into the image as its runtime carrier. */
	runtimePath: string;
	/** Bundled host entrypoint, copied from `dist/native/` by the Electrobun copy rules. */
	entrypointPath: string;
}

/**
 * Derive the whole layout from the packaged runtime's own path. Everything else
 * in the bundle is at a fixed offset from it, so there is nothing to search for
 * and nothing to guess.
 */
export function nativeHostPackageLayout(os: ManifestOs, runtimePath: string): NativeHostPackageLayout {
	const runtime = resolve(runtimePath);
	const runtimeDir = dirname(runtime);
	if (os === "darwin") {
		const contentsDir = dirname(runtimeDir); // <bundle>.app/Contents
		return {
			appBundleRoot: dirname(contentsDir),
			hostImagePackageRoot: contentsDir,
			runtimePath: runtime,
			entrypointPath: join(contentsDir, "Resources", "app", "native", PACKAGED_HOST_ENTRYPOINT),
		};
	}
	const bundleRoot = dirname(runtimeDir); // <bundle>/bin → <bundle>
	return {
		appBundleRoot: bundleRoot,
		hostImagePackageRoot: bundleRoot,
		runtimePath: runtime,
		entrypointPath: join(bundleRoot, "Resources", "app", "native", PACKAGED_HOST_ENTRYPOINT),
	};
}

/**
 * Path segments Electrobun's copy rules put between the package root and the
 * bundled `dev3` CLI (`cliCopyEntry()` in electrobun.config.ts writes
 * `cli/dev3`, and every copy lands under `Resources/app/`).
 */
const PACKAGED_CLI_SEGMENTS = ["Resources", "app", "cli"] as const;

/**
 * The host-image root for a process running as the BUNDLED `dev3` CLI —
 * `dev3 remote` / headless mode, where `process.execPath` is the packaged CLI
 * binary rather than the desktop app's Bun.
 *
 * Seq 1352 found this the hard way: from `Contents/Resources/app/cli/dev3` the
 * two roots beside and above the executable are `.../app/cli` and `.../app`,
 * while the image sits at `Contents/native-host-image`. The gate failed
 * honestly and never touched tmux, but packaged remote mode could not run a
 * native task at all.
 *
 * Anchored on the three NAMED segments, so it matches the one layout Electrobun
 * actually emits and nothing else — no walking up until something is found.
 * Stripping them lands on `Contents/` on macOS (`Resources` sits inside it) and
 * on the bundle root on Linux and Windows, which are exactly the image roots
 * {@link nativeHostPackageLayout} assembles into.
 */
export function hostImageRootForPackagedCli(executableDir: string): string | null {
	let candidate = resolve(executableDir);
	for (const segment of [...PACKAGED_CLI_SEGMENTS].reverse()) {
		if (basename(candidate) !== segment) return null;
		candidate = dirname(candidate);
	}
	return candidate;
}

/**
 * The packaged runtime inside `bundleRoot`, or `null` when this build shape does
 * not carry one. Callers report the miss; guessing a second location is how the
 * Windows image ended up unreachable once already.
 */
export function packagedRuntimePathIn(os: ManifestOs, bundleRoot: string): string | null {
	const relativePath =
		os === "darwin" ? join("Contents", "MacOS", packagedRuntimeFileName(os)) : join("bin", packagedRuntimeFileName(os));
	const candidate = join(resolve(bundleRoot), relativePath);
	return existsSync(candidate) ? candidate : null;
}
