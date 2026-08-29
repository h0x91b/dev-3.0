import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config, { publicAssetCopyEntries } from "../../../electrobun.config";
import { assertPackagedConptyRuntime } from "../../shared/native-terminal-runtime";

describe("electrobun macOS entitlements", () => {
	it("includes microphone access with a usage description for voice mode", () => {
		const macBuild = config.build.mac;

		expect(macBuild.entitlements["com.apple.security.device.audio-input"]).toBe(
			"Required for voice dictation in AI coding assistants",
		);
	});
});

describe("electrobun bundled resources", () => {
	it("ships the canonical artifact starter beside the app resources", () => {
		expect(config.build.copy["src/assets/artifact-template"]).toBe("artifact-template");
	});

	// The copy map is an allow-list, so a public asset absent from it is served as
	// the SPA index.html instead of itself. That shipped twice: the favicons, then
	// sw.js + manifest.webmanifest, which silently killed Web Push in every
	// packaged build. This fails on the next asset dropped into public/.
	it("copies every src/mainview/public asset into the packaged views root", () => {
		const publicDir = fileURLToPath(new URL("../../mainview/public/", import.meta.url));
		const assets = readdirSync(publicDir).filter((name) => !name.startsWith("."));

		expect(assets).toContain("sw.js");
		expect(assets).toContain("manifest.webmanifest");
		const copy = config.build.copy as Record<string, string>;
		for (const name of assets) {
			expect(copy[`dist/${name}`]).toBe(`views/mainview/${name}`);
		}
	});

	// This module is bundled INTO the app (src/bun/index.ts imports it for the
	// version and the CLI binary name), so it is evaluated again at app boot,
	// where there is no src/. An unguarded scan threw ENOENT and killed the boot.
	it("returns an empty map instead of throwing where src/ does not exist", () => {
		expect(publicAssetCopyEntries("/dev3-no-such-public-dir")).toEqual({});
	});
});

describe("electrobun packaged Bun runtime", () => {
	it("pins the global app runtime at or above the ConPTY floor and packages a native host on every platform", () => {
		expect(config.build).toHaveProperty("bunVersion");
		expect(assertPackagedConptyRuntime(config.build.bunVersion)).toBe(config.build.bunVersion);
		// This used to assert preBuild was ABSENT. The invariant it protected is that
		// host packaging and its proof stay in postBuild/postPackage — so preBuild is
		// pinned to the one thing it may do: clearing the build folder before
		// electrobun's own un-retried wipe of it (Windows EBUSY, decision
		// 217-windows-build-folder-freed-before-electrobun-wipes-it).
		expect(config.scripts.preBuild).toBe("./scripts/free-build-folder.ts");
		expect(config.scripts.postBuild).toBe("./scripts/package-native-host.ts");
		expect(config.build.copy["dist/native"]).toBe("native");
	});

	it("does not make the production build depend on the removable detached-PTY prototype", () => {
		const source = readFileSync(fileURLToPath(new URL("../../../electrobun.config.ts", import.meta.url)), "utf8");
		expect(source).not.toContain("prototypes/detached-pty");
	});
});
