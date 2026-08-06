import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../../electrobun.config";
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
