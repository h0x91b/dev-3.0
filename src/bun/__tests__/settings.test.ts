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

import { saveSettings, loadSettings, loadSettingsSync, type GlobalSettings } from "../settings";

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

	it("defaults importShellEnv to on (undefined) and only stores it when explicitly disabled", async () => {
		// No file → default: undefined means "on" (consumers gate with `!== false`).
		expect((await loadSettings()).importShellEnv).toBeUndefined();

		// Explicit false is preserved so users can opt into an isolated environment.
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ importShellEnv: false }), null, 2), "utf-8");
		expect((await loadSettings()).importShellEnv).toBe(false);

		// Explicit true normalizes back to undefined (the default-on representation).
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ importShellEnv: true }), null, 2), "utf-8");
		expect((await loadSettings()).importShellEnv).toBeUndefined();
	});

	it("defaults terminalKeymap to iTerm2 (undefined) and preserves an explicit opt-out", async () => {
		// No file → undefined means "iTerm2 on" (the renderer treats a missing
		// preset as the iterm2 default).
		expect((await loadSettings()).terminalKeymap).toBeUndefined();

		// Explicit "default" is a real opt-out and must survive a round-trip —
		// collapsing it to undefined would silently re-enable the hotkeys.
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ terminalKeymap: "default" }), null, 2), "utf-8");
		expect((await loadSettings()).terminalKeymap).toBe("default");
		expect(loadSettingsSync().terminalKeymap).toBe("default");

		// Explicit "iterm2" is preserved as well.
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ terminalKeymap: "iterm2" }), null, 2), "utf-8");
		expect((await loadSettings()).terminalKeymap).toBe("iterm2");
	});

	it("reads tipsDisabled back from disk (async + sync)", async () => {
		// User toggled "Disable feature tips" → the flag lives in settings.json.
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ tipsDisabled: true }), null, 2), "utf-8");
		expect((await loadSettings()).tipsDisabled).toBe(true);
		expect(loadSettingsSync().tipsDisabled).toBe(true);
	});

	it("does not erase tipsDisabled on the next settings save", async () => {
		// Reproduces the erase-on-next-save path: load the flag, persist the full
		// object back (as the renderer does on ANY setting change), reload.
		vi.spyOn(Bun, "write").mockImplementation(async (target, data) => {
			writeFileSync(String(target), String(data), "utf-8");
			return 0;
		});
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ tipsDisabled: true }), null, 2), "utf-8");

		const loaded = await loadSettings();
		await saveSettings(loaded);

		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).tipsDisabled).toBe(true);
		expect((await loadSettings()).tipsDisabled).toBe(true);
	});

	it("upgrade-safe: an older settings.json without tipsDisabled loads with the flag absent", async () => {
		writeFileSync(settingsPath, JSON.stringify(makeSettings(), null, 2), "utf-8");
		expect((await loadSettings()).tipsDisabled).toBeUndefined();
	});

	it("remaps a stored defaultConfigId that was removed in a preset cleanup", async () => {
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ defaultConfigId: "claude-bypass-opus48" }), null, 2), "utf-8");
		expect((await loadSettings()).defaultConfigId).toBe("claude-bypass-opus48-xhigh");
	});

	it("falls back to the current default for a dangling builtin-looking id with no remap entry", async () => {
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ defaultConfigId: "claude-some-preset-that-never-existed" }), null, 2), "utf-8");
		expect((await loadSettings()).defaultConfigId).toBe("claude-auto-opus48-xhigh");
	});

	it("leaves a non-builtin (custom) defaultConfigId untouched", async () => {
		writeFileSync(settingsPath, JSON.stringify(makeSettings({ defaultConfigId: "my-custom-config" }), null, 2), "utf-8");
		expect((await loadSettings()).defaultConfigId).toBe("my-custom-config");
	});

	it("preserves every GlobalSettings field across a save→load round-trip (drift guard + downgrade safety)", async () => {
		// `Required<>` forces this object to enumerate EVERY field of the shared
		// GlobalSettings type. Adding a field to the type without handling it in
		// loadSettings breaks compilation here (missing key) or this test at
		// runtime (dropped value) — so the tipsDisabled class of bug cannot recur.
		// Values are chosen so each one survives loadSettings normalization as-is.
		vi.spyOn(Bun, "write").mockImplementation(async (target, data) => {
			writeFileSync(String(target), String(data), "utf-8");
			return 0;
		});
		const full: Required<GlobalSettings> = {
			defaultAgentId: "builtin-codex",
			defaultConfigId: "codex-default",
			taskDropPosition: "bottom",
			updateChannel: "canary",
			theme: "light",
			resolvedTheme: "light",
			cloneBaseDirectory: "/tmp/clones",
			customBinaryPaths: { git: "/usr/bin/git" },
			agentBinaryPaths: { "builtin-codex": "/usr/bin/codex" },
			terminalKeymap: "iterm2",
			playSoundOnTaskComplete: false,
			externalApps: [{ id: "x", name: "X", macAppName: "X" }],
			tipsDisabled: true,
			taskOpenMode: "fullscreen",
			defaultDiffViewMode: "unified",
			preventSleepWhileRunning: true,
			skipQuitDialog: true,
			importShellEnv: false,
			focusMode: true,
			agentRateLimitTracking: false,
			watchByDefault: true,
			agentsLayoutRevision: 1,
			pxpipeProxyEnabled: true,
			favorites: [{ agentId: "builtin-codex", configId: "codex-default", uses: 3, lastUsedAt: 123 }],
		};

		await saveSettings(full);

		// Downgrade safety: the file is a plain JSON superset of all pre-existing keys.
		const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
		for (const key of Object.keys(full) as (keyof GlobalSettings)[]) {
			expect(onDisk[key], `field "${key}" was not written to disk`).toEqual(full[key]);
		}

		const loaded = await loadSettings();
		for (const key of Object.keys(full) as (keyof GlobalSettings)[]) {
			expect(loaded[key], `field "${key}" was dropped by loadSettings`).toEqual(full[key]);
		}
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
