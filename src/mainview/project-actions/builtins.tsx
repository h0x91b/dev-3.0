import type { Context, Fiber } from "cordis";
import { isBuiltinOpsProject } from "../../shared/types";
import type { BuiltinPlugin } from "../plugins/runtime";
import { api } from "../rpc";
// Defines the slot before the plugin injects it.
import "./registry";
import type { ProjectActionItem } from "./registry";

const hasFolder = ({ project }: { project: { kind?: string } }) => project.kind !== "virtual";

export const BUILTIN_PROJECT_ACTIONS: ProjectActionItem[] = [
	{
		id: "builtin:open-board",
		order: 10,
		region: "actions",
		placements: ["sheet"],
		glyph: "\uF054",
		label: ({ t }) => t("activity.openBoard"),
		run: ({ project, navigate }) => navigate({ screen: "project", projectId: project.id }),
	},
	{
		// Virtual boards have no folder, so nothing to group by space either.
		id: "builtin:spaces",
		order: 20,
		region: "actions",
		placements: ["row"],
		glyph: "\u{F0E76}",
		testIdPrefix: "project-spaces-action",
		when: (scope) => !!scope.openSpaces && hasFolder(scope),
		label: ({ t }) => t("spaces.rowAction"),
		run: ({ openSpaces, anchor }) => {
			if (anchor) openSpaces?.(anchor);
		},
	},
	{
		id: "builtin:settings",
		order: 30,
		region: "actions",
		placements: ["row", "sheet"],
		glyph: "\u{F0493}",
		label: ({ t }) => t("header.projectSettings"),
		run: ({ project, navigate }) => navigate({ screen: "project-settings", projectId: project.id }),
	},
	{
		// A virtual board's synthetic path is created lazily per task: Finder would no-op.
		id: "builtin:finder",
		order: 40,
		region: "actions",
		placements: ["row", "sheet"],
		glyph: "\u{F115}",
		when: hasFolder,
		label: ({ t }) => t("dashboard.openInFinder"),
		run: ({ project }) => {
			api.request.openFolder({ path: project.path }).catch(() => {});
		},
	},
	{
		// ...and a project terminal would throw "Project path does not exist".
		id: "builtin:terminal",
		order: 50,
		region: "actions",
		placements: ["row", "sheet"],
		glyph: "\uF489",
		when: hasFolder,
		label: ({ t, placement }) => t(placement === "row" ? "projectTerminal.tooltip" : "activity.openTerminal"),
		run: ({ project, navigate }) => navigate({ screen: "project-terminal", projectId: project.id }),
	},
	{
		// The built-in Operations board is pinned: removing it dead-ends ⌘0 and orphans its tasks.
		id: "builtin:remove",
		order: 900,
		region: "danger",
		placements: ["row", "sheet"],
		glyph: "\u{F0A79}",
		when: ({ project, removeProject }) => !!removeProject && !isBuiltinOpsProject(project),
		label: ({ t }) => t("dashboard.remove"),
		run: ({ removeProject }) => removeProject?.(),
	},
];

const PROJECT_ACTIONS_BUILTIN_ID = "builtin:project-actions";

/** Required: the dashboard has no other way to reach a project's settings, terminal or removal. */
export const BUILTIN_PROJECT_ACTIONS_PLUGIN: BuiltinPlugin = {
	id: PROJECT_ACTIONS_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: PROJECT_ACTIONS_BUILTIN_ID,
			inject: ["projectActions"],
			apply(pluginCtx: Context) {
				for (const item of BUILTIN_PROJECT_ACTIONS) pluginCtx.projectActions.register(item);
			},
		});
	},
};
