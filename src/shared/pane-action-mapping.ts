/**
 * Single source of truth for the product↔tmux/SplitTree name mapping.
 * The product names the DIVIDER; tmux/SplitTree name the split AXIS.
 *
 * splitH → horizontal divider → new pane BELOW → tmux -v → SplitTree "vertical"
 * splitV → vertical divider   → new pane RIGHT → tmux -h → SplitTree "horizontal"
 */
import type { SplitOrientation } from "./split-tree";
import type { SplitLayoutPreset } from "./split-tree-layouts";
import type { TaskPaneLayoutPreset } from "./task-panes";

/** Product splitH/splitV → SplitTree/tmux orientation. */
export function paneActionToSplitOrientation(action: "splitH" | "splitV"): SplitOrientation {
	return action === "splitH" ? "vertical" : "horizontal";
}

/** Product layout preset → SplitTree geometric preset. */
export function paneLayoutPresetToSplitPreset(preset: TaskPaneLayoutPreset): SplitLayoutPreset {
	const map: Record<TaskPaneLayoutPreset, SplitLayoutPreset> = {
		tiled: "tiled",
		evenH: "even-vertical",
		evenV: "even-horizontal",
		mainH: "main-horizontal",
		mainV: "main-vertical",
	};
	return map[preset];
}

/** SplitTree geometric preset → product layout preset. */
export function splitPresetToPaneLayoutPreset(preset: SplitLayoutPreset): TaskPaneLayoutPreset {
	const map: Record<SplitLayoutPreset, TaskPaneLayoutPreset> = {
		tiled: "tiled",
		"even-vertical": "evenH",
		"even-horizontal": "evenV",
		"main-horizontal": "mainH",
		"main-vertical": "mainV",
	};
	return map[preset];
}
