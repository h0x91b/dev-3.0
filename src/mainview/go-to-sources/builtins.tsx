import type { Context, Fiber } from "cordis";
import type { Project, Space, Task } from "../../shared/types";
import { getTaskTitle, isBuiltinOpsProject, projectDisplayName } from "../../shared/types";
import type { TranslationKey } from "../i18n";
import type { BuiltinPlugin } from "../plugins/runtime";
import { fuzzyScore } from "../utils/fuzzyMatch";
import { projectSearchHaystack } from "../utils/projectSearchHaystack";
import { matchesTaskQuery } from "../utils/taskSearch";
// Defines the slot before the plugin injects it.
import "./registry";
import type { GoToData, GoToSourceItem, GoToView } from "./registry";

function lockGlyph(view: GoToView, ariaKey: TranslationKey) {
	return (
		<span aria-label={view.t(ariaKey)} className="text-fg-muted text-xs flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
			{"\u{F033E}"}
		</span>
	);
}

/** Starts with the display name, so fuzzy indices stay aligned with the highlighted text. */
function projectHaystack(project: Project, data: GoToData): string {
	return isBuiltinOpsProject(project) ? projectDisplayName(project, data.t("ops.boardName")) : projectSearchHaystack(project.name, data.spaces as Space[], project.id);
}

export const PROJECT_GO_TO_SOURCE: GoToSourceItem<Project> = {
	id: "builtin:projects",
	order: 10,
	modes: ["project", "combined"],
	rows: (data) => data.projects.map((project) => ({ id: `p:${project.id}`, text: projectDisplayName(project, data.t("ops.boardName")), value: project })),
	// A project has no facets: a task-only token excludes it.
	matches: ({ value }, query, data) => !query.hasTaskFacet && (query.free === "" || fuzzyScore(query.free, projectHaystack(value, data)).matched),
	rankText: ({ value }, data) => projectHaystack(value, data),
	textClassName: ({ value }, view) => view.privacy.maskClass(value),
	right: ({ value: p }, q, view) => {
		if (view.privacy.isLocked(p)) return lockGlyph(view, "streamer.projectLocked");
		if (q.length === 0 && isBuiltinOpsProject(p)) return <span className="text-fg-3 text-xs flex-shrink-0">⌘0</span>;
		const idx = view.shortcutIndexById?.[p.id];
		return idx !== undefined && idx < 9 && q.length === 0 ? <span className="text-fg-3 text-xs flex-shrink-0">⌘{idx + 1}</span> : null;
	},
	select: ({ value }, view) => view.openProject(value.id),
};

export const TASK_GO_TO_SOURCE: GoToSourceItem<Task> = {
	id: "builtin:tasks",
	order: 20,
	modes: ["task", "combined"],
	rows: (data) => data.tasks.map((task) => ({ id: `t:${task.id}`, text: getTaskTitle(task), value: task })),
	matches: ({ value }, query, data) => matchesTaskQuery(value, query.raw, data.taskContext(value)),
	textClassName: ({ value }, view) => {
		const proj = view.projectById.get(value.projectId);
		return proj ? view.privacy.maskClass(proj) : "";
	},
	right: ({ value: task }, _q, view) => {
		const proj = view.projectById.get(task.projectId);
		return (
			<span className="flex items-center gap-2 flex-shrink-0 min-w-0 max-w-[45%] text-xs">
				{proj && view.privacy.isLocked(proj) && lockGlyph(view, "streamer.projectLocked")}
				<span className={`text-fg-3 truncate ${proj ? view.privacy.maskClass(proj) : ""}`}>
					{proj ? projectDisplayName(proj, view.t("ops.boardName")) : ""} · #{task.seq}
				</span>
				{task.hidden && <span className="text-fg-muted">{view.t("coordinatorFinder.state.hidden")}</span>}
			</span>
		);
	},
	select: ({ value }, view) => view.openTask(value),
};

export const SPACE_GO_TO_SOURCE: GoToSourceItem<Space> = {
	id: "builtin:spaces",
	order: 30,
	modes: ["project", "combined"],
	rows: (data) => data.spaces.map((space) => ({ id: `space:${space.id}`, text: space.name, value: space })),
	matches: ({ value }, query) => !query.hasTaskFacet && (query.free === "" || fuzzyScore(query.free, value.name).matched),
	right: ({ value: space }, q, view) => {
		const idx = view.shortcutIndexById?.[space.id];
		return (
			<span className="flex items-center gap-2 text-fg-3 text-xs flex-shrink-0">
				{view.t("spaces.boardSubtitle")}
				{idx !== undefined && idx < 9 && q.length === 0 ? <span>⌘{idx + 1}</span> : null}
			</span>
		);
	},
	select: ({ value }, view) => view.openSpace(value.id),
};

const GO_TO_SOURCES_BUILTIN_ID = "builtin:go-to-sources";

/** Required: projects, tasks and spaces are what the Go-to palette is for. */
export const BUILTIN_GO_TO_SOURCES_PLUGIN: BuiltinPlugin = {
	id: GO_TO_SOURCES_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: GO_TO_SOURCES_BUILTIN_ID,
			inject: ["goToSources"],
			apply(pluginCtx: Context) {
				for (const source of [PROJECT_GO_TO_SOURCE, TASK_GO_TO_SOURCE, SPACE_GO_TO_SOURCE]) pluginCtx.goToSources.register(source);
			},
		});
	},
};
