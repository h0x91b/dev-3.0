/**
 * Where the packaged host image lands per platform, and the invariant that ties
 * it to runtime discovery: the image root must be the packaged runtime's own
 * directory or its parent, because those are the only two roots
 * `packagedHostImageRoots()` probes.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	manifestArchForElectrobunArch,
	manifestOsForElectrobunOs,
	nativeHostPackageLayout,
	packagedRuntimePathIn,
	packagedRuntimeFileName,
} from "../package-layout";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "dev3-package-layout-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe("Electrobun target tokens", () => {
	test("maps every supported OS token onto a manifest OS", () => {
		expect(manifestOsForElectrobunOs("macos")).toBe("darwin");
		expect(manifestOsForElectrobunOs("linux")).toBe("linux");
		expect(manifestOsForElectrobunOs("win")).toBe("win32");
	});

	test("refuses an unknown or missing OS token instead of guessing", () => {
		expect(() => manifestOsForElectrobunOs(undefined)).toThrow(/Unsupported ELECTROBUN_OS/);
		expect(() => manifestOsForElectrobunOs("darwin")).toThrow(/Unsupported ELECTROBUN_OS/);
	});

	test("treats anything that is not arm64 as x64", () => {
		expect(manifestArchForElectrobunArch("arm64")).toBe("arm64");
		expect(manifestArchForElectrobunArch("x64")).toBe("x64");
		expect(manifestArchForElectrobunArch(undefined)).toBe("x64");
	});
});

describe("nativeHostPackageLayout", () => {
	test("puts the macOS image under Contents/, beside MacOS/ and Resources/", () => {
		const layout = nativeHostPackageLayout("darwin", "/b/dev-3.0.app/Contents/MacOS/bun");

		expect(layout.appBundleRoot).toBe("/b/dev-3.0.app");
		expect(layout.hostImagePackageRoot).toBe("/b/dev-3.0.app/Contents");
		expect(layout.entrypointPath).toBe("/b/dev-3.0.app/Contents/Resources/app/native/dev3-terminal-host.js");
	});

	test.each([
		["linux", "/b/dev-3.0/bin/bun"],
		["win32", "/b/dev-3.0/bin/bun.exe"],
	] as const)("puts the %s image at the bundle root, one level above bin/", (os, runtimePath) => {
		const layout = nativeHostPackageLayout(os, runtimePath);

		expect(layout.appBundleRoot).toBe("/b/dev-3.0");
		expect(layout.hostImagePackageRoot).toBe("/b/dev-3.0");
		expect(layout.entrypointPath).toBe("/b/dev-3.0/Resources/app/native/dev3-terminal-host.js");
	});

	test.each([
		["darwin", "/b/dev-3.0.app/Contents/MacOS/bun"],
		["linux", "/b/dev-3.0/bin/bun"],
		["win32", "/b/dev-3.0/bin/bun.exe"],
	] as const)("keeps the %s image root reachable from the runtime's directory or its parent", (os, runtimePath) => {
		const layout = nativeHostPackageLayout(os, runtimePath);
		const runtimeDir = dirname(runtimePath);

		// Mirrors packagedHostImageRoots(): beside the runtime, then one level up.
		expect([runtimeDir, dirname(runtimeDir)]).toContain(layout.hostImagePackageRoot);
	});
});

describe("packagedRuntimePathIn", () => {
	function bundleWithRuntime(name: string, relativeRuntime: string): string {
		const bundleRoot = join(workspace, name);
		const runtimePath = join(bundleRoot, relativeRuntime);
		mkdirSync(dirname(runtimePath), { recursive: true });
		writeFileSync(runtimePath, "bun");
		return bundleRoot;
	}

	test("finds the macOS runtime inside Contents/MacOS", () => {
		const bundleRoot = bundleWithRuntime("dev-3.0.app", join("Contents", "MacOS", "bun"));
		expect(packagedRuntimePathIn("darwin", bundleRoot)).toBe(join(bundleRoot, "Contents", "MacOS", "bun"));
	});

	test("finds the Linux runtime inside bin/", () => {
		const bundleRoot = bundleWithRuntime("dev-3.0", join("bin", "bun"));
		expect(packagedRuntimePathIn("linux", bundleRoot)).toBe(join(bundleRoot, "bin", "bun"));
	});

	test("reports a miss instead of searching a second location", () => {
		const bundleRoot = bundleWithRuntime("dev-3.0", join("bin", "bun"));
		expect(packagedRuntimePathIn("darwin", bundleRoot)).toBeNull();
	});

	test("names the runtime binary the way each platform ships it", () => {
		expect(packagedRuntimeFileName("win32")).toBe("bun.exe");
		expect(packagedRuntimeFileName("darwin")).toBe("bun");
		expect(packagedRuntimeFileName("linux")).toBe("bun");
	});
});
