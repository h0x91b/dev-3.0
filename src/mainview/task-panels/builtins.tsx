import { useLayoutEffect, useRef } from "react";
import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
import { getArtifactDock, setArtifactDock } from "../utils/artifact-dock";
import "./registry";
import type { TaskPanelProps } from "./registry";

export const TASK_PANELS_BUILTIN_ID = "builtin:task-panels";
export const ARTIFACT_PANEL_ID = "builtin:artifact";

/**
 * The artifact viewer's tab. The viewer itself is still mounted by App and
 * portals into the element published here, so a docked artifact keeps the one
 * mounted viewer it always had. Published while the task's dock is on screen —
 * hidden behind another tab included — and taken back the moment it is not, so
 * the viewer flips to its popup (narrow, immersive) or waits offscreen.
 */
function ArtifactDockTarget({ presentation }: TaskPanelProps) {
	const ref = useRef<HTMLDivElement>(null);
	const inDock = presentation === "docked" || presentation === "inactive";
	useLayoutEffect(() => {
		if (!inDock) return;
		const el = ref.current;
		setArtifactDock(el);
		return () => {
			if (getArtifactDock() === el) setArtifactDock(null);
		};
	}, [inDock]);
	return inDock ? <div ref={ref} data-testid="artifact-dock" className="min-h-0 min-w-0 flex-1 overflow-hidden" /> : null;
}

export const BUILTIN_TASK_PANELS_PLUGIN: BuiltinPlugin = {
	id: TASK_PANELS_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TASK_PANELS_BUILTIN_ID,
			inject: ["taskPanels"],
			apply(pluginCtx: Context) {
				pluginCtx.taskPanels.register({
					id: ARTIFACT_PANEL_ID,
					order: 0,
					title: (t) => t("artifactViewer.regionLabel"),
					component: ArtifactDockTarget,
					closable: false,
				});
			},
		});
	},
};
