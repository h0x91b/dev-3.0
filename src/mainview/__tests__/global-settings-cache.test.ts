import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../shared/types";
import { DEFAULT_AGENTS, DEPRECATED_DEFAULT_CONFIG_REMAP } from "../../shared/types";
import { DEFAULT_GLOBAL_SETTINGS } from "../components/global-settings/utils";

const getGlobalSettings = vi.fn();
const saveGlobalSettings = vi.fn();
vi.mock("../rpc", () => ({
	api: {
		request: {
			getGlobalSettings: (...args: unknown[]) => getGlobalSettings(...args),
			saveGlobalSettings: (...args: unknown[]) => saveGlobalSettings(...args),
		},
	},
}));
vi.mock("../toast", () => ({ toast: { error: vi.fn() } }));

const stored: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-auto-opus55-medium",
	taskSortOrder: "newest-first",
	updateChannel: "stable",
	theme: "light",
	tipsDisabled: true,
};

beforeEach(() => {
	vi.resetModules();
	getGlobalSettings.mockReset().mockResolvedValue(stored);
	saveGlobalSettings.mockReset().mockResolvedValue(undefined);
});

describe("patchGlobalSettings", () => {
	it("merges a patch fired before the first sync into the host's settings", async () => {
		const { patchGlobalSettings } = await import("../global-settings-cache");

		await expect(patchGlobalSettings({ hiddenControls: ["bug-hunters"] })).resolves.toBe(true);

		expect(saveGlobalSettings).toHaveBeenCalledWith({ ...stored, hiddenControls: ["bug-hunters"] });
	});

	it("merges into the synced settings without re-reading the host", async () => {
		const { patchGlobalSettings, syncGlobalSettingsCache } = await import("../global-settings-cache");
		syncGlobalSettingsCache(stored);

		await patchGlobalSettings({ tipsDisabled: undefined });

		expect(getGlobalSettings).not.toHaveBeenCalled();
		expect(saveGlobalSettings).toHaveBeenCalledWith({ ...stored, tipsDisabled: undefined });
	});
});

describe("DEFAULT_GLOBAL_SETTINGS placeholder", () => {
	// A retired id here is remapped on load to some other preset — "claude-auto"
	// became Fable 5 X-High for every user whose placeholder reached disk.
	it("names a live built-in preset that no remap rewrites", () => {
		expect(DEPRECATED_DEFAULT_CONFIG_REMAP[DEFAULT_GLOBAL_SETTINGS.defaultConfigId]).toBeUndefined();
		const builtinIds = DEFAULT_AGENTS.flatMap((a) => a.configurations.map((c) => c.id));
		expect(builtinIds).toContain(DEFAULT_GLOBAL_SETTINGS.defaultConfigId);
	});
});
