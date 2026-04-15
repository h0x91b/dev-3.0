import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { TEST_HOME } = vi.hoisted(() => ({
	TEST_HOME: require("node:fs").mkdtempSync(
		require("node:path").join(require("node:os").tmpdir(), "dev3-settings-test-"),
	),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

import { saveSettings, type GlobalSettings } from "../settings";

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
	return {
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-default",
		taskDropPosition: "top",
		updateChannel: "stable",
		...overrides,
	};
}

describe("saveSettings", () => {
	const settingsPath = join(TEST_HOME, "settings.json");

	beforeEach(() => {
		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(TEST_HOME, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(TEST_HOME, { recursive: true, force: true });
	});

	it("does not corrupt the existing settings file if a write crashes mid-save", async () => {
		const previousSettings = makeSettings({ updateChannel: "canary" });
		writeFileSync(settingsPath, JSON.stringify(previousSettings, null, 2), "utf-8");

		vi.spyOn(Bun, "write").mockImplementation(async (target) => {
			writeFileSync(String(target), '{"defaultAgentId":"broken', "utf-8");
			throw new Error("simulated crash");
		});

		await expect(
			saveSettings(makeSettings({ defaultAgentId: "builtin-codex" })),
		).rejects.toThrow("simulated crash");

		expect(() => JSON.parse(readFileSync(settingsPath, "utf-8"))).not.toThrow();
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(previousSettings);
	});

	it("creates the settings directory before writing the file", async () => {
		// Remove the directory so saveSettings must create it from scratch
		rmSync(TEST_HOME, { recursive: true, force: true });

		vi.spyOn(Bun, "write").mockImplementation(async (target, data) => {
			writeFileSync(String(target), String(data), "utf-8");
			return 0;
		});

		await saveSettings(makeSettings({ defaultAgentId: "builtin-codex" }));

		expect(existsSync(settingsPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(
			makeSettings({ defaultAgentId: "builtin-codex" }),
		);
	});
});
