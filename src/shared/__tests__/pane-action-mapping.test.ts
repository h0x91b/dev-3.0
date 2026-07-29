import { describe, it, expect } from "vitest";
import {
	paneActionToSplitOrientation,
	paneLayoutPresetToSplitPreset,
	splitPresetToPaneLayoutPreset,
} from "../pane-action-mapping";
import { SPLIT_LAYOUT_PRESETS } from "../split-tree-layouts";
import { TASK_PANE_LAYOUT_PRESETS } from "../task-panes";

describe("paneActionToSplitOrientation", () => {
	it("splitH → vertical (new pane below)", () => {
		expect(paneActionToSplitOrientation("splitH")).toBe("vertical");
	});
	it("splitV → horizontal (new pane right)", () => {
		expect(paneActionToSplitOrientation("splitV")).toBe("horizontal");
	});
});

describe("paneLayoutPresetToSplitPreset", () => {
	it("tiled → tiled", () => expect(paneLayoutPresetToSplitPreset("tiled")).toBe("tiled"));
	it("evenH → even-vertical", () => expect(paneLayoutPresetToSplitPreset("evenH")).toBe("even-vertical"));
	it("evenV → even-horizontal", () => expect(paneLayoutPresetToSplitPreset("evenV")).toBe("even-horizontal"));
	it("mainH → main-horizontal", () => expect(paneLayoutPresetToSplitPreset("mainH")).toBe("main-horizontal"));
	it("mainV → main-vertical", () => expect(paneLayoutPresetToSplitPreset("mainV")).toBe("main-vertical"));

	it("covers every TaskPaneLayoutPreset", () => {
		for (const preset of TASK_PANE_LAYOUT_PRESETS) {
			expect(SPLIT_LAYOUT_PRESETS).toContain(paneLayoutPresetToSplitPreset(preset));
		}
	});
});

describe("splitPresetToPaneLayoutPreset", () => {
	it("tiled → tiled", () => expect(splitPresetToPaneLayoutPreset("tiled")).toBe("tiled"));
	it("even-vertical → evenH", () => expect(splitPresetToPaneLayoutPreset("even-vertical")).toBe("evenH"));
	it("even-horizontal → evenV", () => expect(splitPresetToPaneLayoutPreset("even-horizontal")).toBe("evenV"));
	it("main-horizontal → mainH", () => expect(splitPresetToPaneLayoutPreset("main-horizontal")).toBe("mainH"));
	it("main-vertical → mainV", () => expect(splitPresetToPaneLayoutPreset("main-vertical")).toBe("mainV"));

	it("round-trips with paneLayoutPresetToSplitPreset", () => {
		for (const preset of TASK_PANE_LAYOUT_PRESETS) {
			const split = paneLayoutPresetToSplitPreset(preset);
			const back = splitPresetToPaneLayoutPreset(split);
			expect(back).toBe(preset);
		}
	});
});
