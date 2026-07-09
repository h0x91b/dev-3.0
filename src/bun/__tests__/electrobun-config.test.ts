import { describe, expect, it } from "vitest";
import config from "../../../electrobun.config";

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
