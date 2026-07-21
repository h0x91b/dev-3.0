import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../../electrobun.config";
import {
	MINIMUM_WINDOWS_CONPTY_BUN_VERSION,
	assertPackagedConptyRuntime,
} from "../../shared/native-terminal-runtime";

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
	it("pins the global app runtime to the ConPTY floor and verifies the packaged Windows host", () => {
		expect(config.build.bunVersion).toBe(MINIMUM_WINDOWS_CONPTY_BUN_VERSION);
		expect(config.scripts).not.toHaveProperty("preBuild");
		expect(config.scripts.postBuild).toBe("./scripts/verify-packaged-windows-conpty.ts");
		expect(config.build.copy["dist/native"]).toBe("native");
		expect(() => assertPackagedConptyRuntime(MINIMUM_WINDOWS_CONPTY_BUN_VERSION)).not.toThrow();
	});

	it("does not make the production build depend on the removable detached-PTY prototype", () => {
		const source = readFileSync(fileURLToPath(new URL("../../../electrobun.config.ts", import.meta.url)), "utf8");
		expect(source).not.toContain("prototypes/detached-pty");
	});
});
