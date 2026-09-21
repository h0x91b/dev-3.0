import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIMPLIFY_VIEW_PRESET_IDS } from "../hideable-controls";
import {
	HIDDEN_CONTROLS_CHANGED_EVENT,
	applySimplifyViewPreset,
	getHiddenControls,
	hideControl,
	isControlHidden,
	isSimplifyViewApplied,
	restoreControl,
	setHiddenControlsForTests,
	showAllControls,
	syncHiddenControlsFromGlobalSettings,
	unapplySimplifyViewPreset,
} from "../hidden-controls";
import { syncGlobalSettingsCache } from "../global-settings-cache";
import { DEFAULT_GLOBAL_SETTINGS } from "../components/global-settings/utils";

const saveGlobalSettings = vi.fn().mockResolvedValue(undefined);
vi.mock("../rpc", () => ({ api: { request: { saveGlobalSettings: (...args: unknown[]) => saveGlobalSettings(...args) } } }));

beforeEach(() => {
	saveGlobalSettings.mockClear();
	setHiddenControlsForTests([]);
	syncGlobalSettingsCache({ ...DEFAULT_GLOBAL_SETTINGS });
});

describe("hidden-controls registry", () => {
	it("starts empty — an id never listed is always visible", () => {
		expect(isControlHidden("bug-hunters")).toBe(false);
		expect(getHiddenControls().size).toBe(0);
	});

	it("round-trips through a GlobalSettings sync", () => {
		syncHiddenControlsFromGlobalSettings({ hiddenControls: ["bug-hunters", "stats-nav"] });
		expect(isControlHidden("bug-hunters")).toBe(true);
		expect(isControlHidden("stats-nav")).toBe(true);
		expect(isControlHidden("hibernate")).toBe(false);
	});

	it("announces only on an actual change", () => {
		const seen: unknown[] = [];
		const listener = (e: Event) => seen.push((e as CustomEvent).detail);
		window.addEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, listener);

		syncHiddenControlsFromGlobalSettings({ hiddenControls: ["bug-hunters"] });
		syncHiddenControlsFromGlobalSettings({ hiddenControls: ["bug-hunters"] }); // same set, no event
		syncHiddenControlsFromGlobalSettings({ hiddenControls: [] });

		window.removeEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, listener);
		expect(seen).toEqual([["bug-hunters"], []]);
	});

	it("hideControl persists into the cached GlobalSettings object", () => {
		hideControl("scripts-runner");
		expect(isControlHidden("scripts-runner")).toBe(true);
		expect(saveGlobalSettings).toHaveBeenCalledWith(
			expect.objectContaining({ hiddenControls: ["scripts-runner"] }),
		);
	});

	it("is a no-op before the settings cache has ever synced", () => {
		syncGlobalSettingsCache(null as never); // simulate "never synced" without touching module internals
		hideControl("scripts-runner");
		// The id still lands in the reactive set (announce runs regardless);
		// only the RPC persistence is skipped when there is nothing to merge into.
		expect(saveGlobalSettings).not.toHaveBeenCalled();
	});

	it("restoreControl removes exactly that id and nothing else", () => {
		setHiddenControlsForTests(["bug-hunters", "hibernate"]);
		restoreControl("bug-hunters");
		expect(getHiddenControls().has("bug-hunters")).toBe(false);
		expect(getHiddenControls().has("hibernate")).toBe(true);
	});

	it("restoreControl on an id that isn't hidden is a no-op", () => {
		setHiddenControlsForTests(["hibernate"]);
		restoreControl("bug-hunters");
		expect(getHiddenControls()).toEqual(new Set(["hibernate"]));
	});
});

describe("Simplify View preset", () => {
	it("is not applied when the set is empty", () => {
		expect(isSimplifyViewApplied()).toBe(false);
	});

	it("applying unions every preset id into whatever is already hidden", () => {
		setHiddenControlsForTests(["some-future-id-not-in-the-preset"]);
		applySimplifyViewPreset();
		for (const id of SIMPLIFY_VIEW_PRESET_IDS) expect(isControlHidden(id)).toBe(true);
		expect(isControlHidden("some-future-id-not-in-the-preset" as never)).toBe(true);
		expect(isSimplifyViewApplied()).toBe(true);
	});

	it("un-hiding a single preset control breaks the applied reading", () => {
		applySimplifyViewPreset();
		restoreControl(SIMPLIFY_VIEW_PRESET_IDS[0]);
		expect(isSimplifyViewApplied()).toBe(false);
	});

	it("unapplying removes exactly the preset's ids, keeping any other manual hide", () => {
		setHiddenControlsForTests(["some-other-manual-hide"]);
		applySimplifyViewPreset();
		unapplySimplifyViewPreset();
		for (const id of SIMPLIFY_VIEW_PRESET_IDS) expect(isControlHidden(id)).toBe(false);
		expect(getHiddenControls().has("some-other-manual-hide")).toBe(true);
	});

	it("showAllControls clears everything, preset or manual alike", () => {
		applySimplifyViewPreset();
		hideControl("project-terminal-button");
		showAllControls();
		expect(getHiddenControls().size).toBe(0);
	});
});

describe("personal choices across interface modes", () => {
	it("preserves a personal preset hide across repeated switches and restart sync", async () => {
		await hideControl("bug-hunters");
		await applySimplifyViewPreset();
		await unapplySimplifyViewPreset();
		expect(getHiddenControls()).toEqual(new Set(["bug-hunters"]));
		const saved = saveGlobalSettings.mock.calls[saveGlobalSettings.mock.calls.length - 1]![0];
		syncHiddenControlsFromGlobalSettings(saved);
		await applySimplifyViewPreset();
		await unapplySimplifyViewPreset();
		expect(getHiddenControls()).toEqual(new Set(["bug-hunters"]));
	});

	it("does not invent personal hides when a fresh preset is removed", async () => {
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: true, personalHiddenControls: [], hiddenControls: [...SIMPLIFY_VIEW_PRESET_IDS] });
		await unapplySimplifyViewPreset();
		expect(getHiddenControls().size).toBe(0);
	});

	it("retains ambiguous existing hides during upgrade", async () => {
		syncHiddenControlsFromGlobalSettings({ hiddenControls: [...SIMPLIFY_VIEW_PRESET_IDS] });
		expect(isSimplifyViewApplied()).toBe(true);
		await unapplySimplifyViewPreset();
		expect(getHiddenControls()).toEqual(new Set(SIMPLIFY_VIEW_PRESET_IDS));
		expect(isSimplifyViewApplied()).toBe(false);
	});

	it("announces mode changes even when personal choices keep every preset control hidden", async () => {
		syncHiddenControlsFromGlobalSettings({ simplifiedMode: false, personalHiddenControls: [...SIMPLIFY_VIEW_PRESET_IDS] });
		const listener = vi.fn();
		window.addEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, listener);
		await applySimplifyViewPreset();
		expect(isSimplifyViewApplied()).toBe(true);
		expect(listener).toHaveBeenCalledOnce();
		window.removeEventListener(HIDDEN_CONTROLS_CHANGED_EVENT, listener);
	});

	it("rolls back a rejected mode save and reports failure to the caller", async () => {
		saveGlobalSettings.mockRejectedValueOnce(new Error("offline"));
		expect(await applySimplifyViewPreset()).toBe(false);
		expect(isSimplifyViewApplied()).toBe(false);
		expect(getHiddenControls().size).toBe(0);
	});
});
