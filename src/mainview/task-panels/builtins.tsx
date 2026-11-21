import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
import { ARTIFACT_PANEL_ID, ArtifactPanel } from "./artifact-panel";
import "./registry";

export const TASK_PANELS_BUILTIN_ID = "builtin:task-panels";

export const BUILTIN_TASK_PANELS_PLUGIN: BuiltinPlugin = {
	id: TASK_PANELS_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TASK_PANELS_BUILTIN_ID,
			inject: ["taskPanels"],
			apply(pluginCtx: Context) {
				// The viewer closes itself (its own Close), so its tab has no ✕.
				pluginCtx.taskPanels.register({
					id: ARTIFACT_PANEL_ID,
					order: 0,
					title: (t) => t("artifactViewer.regionLabel"),
					component: ArtifactPanel,
					closable: false,
				});
			},
		});
	},
};
