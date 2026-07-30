/**
 * The whole packaging path over a synthesized Electrobun bundle, per platform:
 * find the packaged runtime → derive the layout → assemble the image into the
 * bundle → discover it the way an installed app does → stage it outside the
 * install root.
 *
 * macOS is also covered for real by `scripts/package-posix-native-host.ts` on
 * every build. Linux and Windows have no build machine here, so this is where
 * their bundle shape is held to the same contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ManifestArch, ManifestOs } from "../artifact-manifest";
import {
	discoverPackagedImage,
	assemblePackagedImage,
	isInsideDirectory,
	stagePackagedImage,
	packagedHostRuntimeCarrier,
	PACKAGED_HOST_ENTRYPOINT,
	PACKAGED_HOST_IMAGE_PARENT,
} from "../packaged-image";
import { nativeHostPackageLayout, packagedRuntimePathIn, packagedRuntimeFileName } from "../package-layout";

const BUN_VERSION = "1.3.14";
const PROTOCOL_VERSION = 1;

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "dev3-package-runtime-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

interface BundleShape {
	os: ManifestOs;
	arch: ManifestArch;
	bundleName: string;
	runtimeRelativePath: string;
	entrypointRelativePath: string;
	expectedImageArchivePath: string;
}

const SHAPES: BundleShape[] = [
	{
		os: "darwin",
		arch: "arm64",
		bundleName: "dev-3.0.app",
		runtimeRelativePath: join("Contents", "MacOS", "bun"),
		entrypointRelativePath: join("Contents", "Resources", "app", "native", PACKAGED_HOST_ENTRYPOINT),
		expectedImageArchivePath: join("Contents", PACKAGED_HOST_IMAGE_PARENT),
	},
	{
		os: "linux",
		arch: "x64",
		bundleName: "dev-3.0",
		runtimeRelativePath: join("bin", "bun"),
		entrypointRelativePath: join("Resources", "app", "native", PACKAGED_HOST_ENTRYPOINT),
		expectedImageArchivePath: PACKAGED_HOST_IMAGE_PARENT,
	},
	{
		os: "win32",
		arch: "x64",
		bundleName: "dev-3.0",
		runtimeRelativePath: join("bin", "bun.exe"),
		entrypointRelativePath: join("Resources", "app", "native", PACKAGED_HOST_ENTRYPOINT),
		expectedImageArchivePath: PACKAGED_HOST_IMAGE_PARENT,
	},
];

/** A build directory holding one bundle, shaped exactly the way Electrobun emits it. */
function buildBundle(shape: BundleShape): { buildDir: string; bundleRoot: string } {
	const buildDir = join(workspace, `build-${shape.os}`);
	const bundleRoot = join(buildDir, shape.bundleName);
	for (const [relativePath, contents, mode] of [
		[shape.runtimeRelativePath, `bun-${shape.os}-${shape.arch}`, 0o755],
		[shape.entrypointRelativePath, "console.log('host');\n", 0o644],
	] as const) {
		const path = join(bundleRoot, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents, { mode });
	}
	return { buildDir, bundleRoot };
}

describe.each(SHAPES)("$os package", (shape) => {
	test("assembles, discovers, and stages the image the installed app will launch", () => {
		const { bundleRoot } = buildBundle(shape);

		const runtimePath = packagedRuntimePathIn(shape.os, bundleRoot);
		expect(runtimePath).toBe(join(bundleRoot, shape.runtimeRelativePath));
		const layout = nativeHostPackageLayout(shape.os, runtimePath!);
		expect(layout.appBundleRoot).toBe(bundleRoot);
		expect(layout.entrypointPath).toBe(join(bundleRoot, shape.entrypointRelativePath));

		const assembled = assemblePackagedImage({
			packageRoot: layout.hostImagePackageRoot,
			runtimeSourcePath: layout.runtimePath,
			entrypointSourcePath: layout.entrypointPath,
			hostVersion: "1.41.0",
			protocolVersion: PROTOCOL_VERSION,
			bunVersion: BUN_VERSION,
			runtimeFloor: BUN_VERSION,
			os: shape.os,
			arch: shape.arch,
		});
		expect(relative(bundleRoot, dirname(assembled.imageDir))).toBe(shape.expectedImageArchivePath);
		expect(assembled.manifest.runtimeCarrier).toBe(packagedHostRuntimeCarrier(shape.os));
		expect(assembled.manifest.archiveRoot).toBe(`${PACKAGED_HOST_IMAGE_PARENT}/${assembled.tag}`);

		// The installed app looks in exactly this root; anything else is unreachable.
		const expectations = { os: shape.os, arch: shape.arch, bunVersion: BUN_VERSION, protocolVersion: PROTOCOL_VERSION, archiveParent: PACKAGED_HOST_IMAGE_PARENT };
		const discovered = discoverPackagedImage(layout.hostImagePackageRoot, expectations);
		expect(discovered.status).toBe("ok");
		if (discovered.status !== "ok") return;

		const stagingRoot = join(workspace, `staging-${shape.os}`);
		const staged = stagePackagedImage({ sourceImageDir: discovered.imageDir, stagingRoot, expectations });
		expect(staged.status).toBe("staged");
		if (staged.status !== "staged") return;
		expect(isInsideDirectory(layout.appBundleRoot, staged.imageDir)).toBe(false);
		expect(readFileSync(staged.runtimeCarrierPath, "utf8")).toBe(`bun-${shape.os}-${shape.arch}`);
		expect(statSync(staged.runtimeCarrierPath).mode & 0o111).not.toBe(0);
	});

	test("names the runtime and its carrier the way this platform can execute them", () => {
		expect(packagedRuntimeFileName(shape.os)).toBe(shape.os === "win32" ? "bun.exe" : "bun");
		expect(packagedHostRuntimeCarrier(shape.os)).toBe(shape.os === "win32" ? "dev3-terminal-host.exe" : "dev3-terminal-host");
	});

	test("a bundle built without `bun run build:native` has no host to package", () => {
		const { bundleRoot } = buildBundle(shape);
		rmSync(join(bundleRoot, shape.entrypointRelativePath));

		const layout = nativeHostPackageLayout(shape.os, packagedRuntimePathIn(shape.os, bundleRoot)!);
		expect(() =>
			assemblePackagedImage({
				packageRoot: layout.hostImagePackageRoot,
				runtimeSourcePath: layout.runtimePath,
				entrypointSourcePath: layout.entrypointPath,
				hostVersion: "1.41.0",
				protocolVersion: PROTOCOL_VERSION,
				bunVersion: BUN_VERSION,
				runtimeFloor: BUN_VERSION,
				os: shape.os,
				arch: shape.arch,
			}),
		).toThrow();
		expect(discoverPackagedImage(layout.hostImagePackageRoot, {}).status).not.toBe("ok");
	});
});
