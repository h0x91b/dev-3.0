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
	hostImageRootForPackagedCli,
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

describe("hostImageRootForPackagedCli", () => {
	// Every row is a REAL Electrobun output path. `hostImagePackageRoot` in the
	// same bundle must come out identical, or `dev3 remote` looks in the wrong
	// place while the desktop app looks in the right one.
	test.each([
		["darwin", "/b/dev-3.0.app/Contents/MacOS/bun", "/b/dev-3.0.app/Contents/Resources/app/cli"],
		["linux", "/b/dev-3.0/bin/bun", "/b/dev-3.0/Resources/app/cli"],
		["win32", "/b/dev-3.0/bin/bun.exe", "/b/dev-3.0/Resources/app/cli"],
	] as const)("on %s the bundled CLI resolves the same image root as the desktop app", (os, runtimePath, cliDir) => {
		expect(hostImageRootForPackagedCli(cliDir)).toBe(nativeHostPackageLayout(os, runtimePath).hostImagePackageRoot);
	});

	test("rejects any directory that is not Electrobun's Resources/app/cli", () => {
		for (const wrong of [
			"/b/dev-3.0.app/Contents/MacOS", // desktop runtime dir
			"/b/dev-3.0.app/Contents/Resources/app", // one segment short
			"/b/dev-3.0.app/Contents/Resources/app/cli/extra", // one segment too deep
			"/b/dev-3.0/Resources/cli", // missing app/
			"/usr/local/bin", // a CLI installed outside any package
			"/",
		]) {
			expect(hostImageRootForPackagedCli(wrong)).toBeNull();
		}
	});

	test("does not walk up looking for a match", () => {
		// A `cli` directory nested under an unrelated tree must not resolve to
		// some ancestor that happens to exist.
		expect(hostImageRootForPackagedCli("/home/me/projects/cli")).toBeNull();
	});
});
