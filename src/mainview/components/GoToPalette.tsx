import { useEffect, useMemo, useState } from "react";
import { useEpics } from "../hooks/useEpics";
import type { Project, Space, Task } from "../../shared/types";
import { getTaskTitle, isBuiltinOpsProject, projectDisplayName } from "../../shared/types";
import { useT, type TranslationKey } from "../i18n";
import { useAgents } from "../hooks/useAgents";
import { api } from "../rpc";
import { useProjectPrivacy } from "../sensitive-projects";
import { useSpaces } from "../useSpaces";
import { buildFacetResolver } from "../utils/facetResolver";
import { useTaskLineage } from "../hooks/useTaskLineage";
import { fuzzyScore } from "../utils/fuzzyMatch";
import { projectSearchHaystack } from "../utils/projectSearchHaystack";
import { getRecentTaskIds } from "../utils/recentTasks";
import { orderByRecency } from "../utils/recentProjects";
import { orderByNavRecency } from "../utils/recentNav";
import { taskQueryContext } from "../utils/taskFacets";
import { FACET_KEYS, matchesTaskQuery, parseTaskQuery, type TaskQueryContext } from "../utils/taskSearch";
import { PaletteShell } from "./PaletteShell";

/** The three modes of the "Go to" palette. ⇧⌘K/J/L open each; Tab cycles them. */
export type GoToMode = "project" | "task" | "combined";
// Display / Tab-cycle order on the strip — "All" (combined) leads.
export const GO_TO_MODES: GoToMode[] = ["combined", "project", "task"];

const MODE_LABEL_KEY: Record<GoToMode, TranslationKey> = {
	project: "goTo.mode.project",
	task: "goTo.mode.task",
	combined: "goTo.mode.combined",
};

const NO_RESULTS_KEY: Record<GoToMode, TranslationKey> = {
	project: "goTo.noResults.project",
	task: "goTo.noResults.task",
	combined: "goTo.noResults.combined",
};

/** A palette row: a project board, a space board, or a task. */
type GoItem =
	| { kind: "project"; id: string; project: Project }
	| { kind: "space"; id: string; space: Space }
	| { kind: "task"; id: string; task: Task };

interface GoToPaletteProps {
	mode: GoToMode;
	onModeChange: (mode: GoToMode) => void;
	/** Non-deleted projects in display order (recency-first) — the project rows. */
	projects: Project[];
	/** Project id → 0-based BOARD index, for the ⌘N badge (stable, board-order). */
	shortcutIndexById?: Record<string, number>;
	/** Every project by id (carries labels + custom columns) — resolver & task rows. */
	projectById: Map<string, Project>;
	/** Task id → allocated ports, for the `has:port` facet. */
	taskPorts: ReadonlyMap<string, readonly unknown[]>;
	/** The task on screen right now. It sinks to the bottom: it is where the user already is. */
	currentTaskId?: string | null;
	onSelectProject: (projectId: string) => void;
	onSelectSpace: (spaceId: string) => void;
	onSelectTask: (task: Task) => void;
	onClose: () => void;
}

/**
 * The unified "Go to" palette. One shell, three modes on a Tab-switchable strip:
 * Projects (fuzzy, like the old quick-switch), Tasks (the sidebar/board token-DSL
 * matcher — `label:` `status:` `agent:` … + free text — ordered most-recently-
 * VIEWED first), and Combined (both). ⇧⌘K/J/L each open it pre-set to a mode; Tab
 * or the strip switches without closing. Reuses the search ENGINE, never the
 * filter-funnel chrome, so the palette stays type-to-find (UX bible §5).
 */
function GoToPalette({
	mode,
	onModeChange,
	projects,
	shortcutIndexById,
	projectById,
	taskPorts,
	currentTaskId,
	onSelectProject,
	onSelectSpace,
	onSelectTask,
	onClose,
}: GoToPaletteProps) {
	const t = useT();
	const agents = useAgents();
	const privacy = useProjectPrivacy();
	const { spaces } = useSpaces();
	const [query, setQuery] = useState("");
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);

	const needsTasks = mode === "task" || mode === "combined";

	// Load the cross-project task pool once, lazily, the first time a task-bearing
	// mode is shown — a projects-only session never pays for it.
	useEffect(() => {
		if (!needsTasks || tasks !== null) return;
		let cancelled = false;
		api.request
			.getAllProjectTasks()
			.then((results) => {
				if (!cancelled) setTasks(results.flatMap((r) => r.tasks));
			})
			.catch((err) => {
				console.error("GoToPalette: getAllProjectTasks failed", err);
				if (cancelled) return;
				setLoadFailed(true);
				setTasks([]);
			});
		return () => {
			cancelled = true;
		};
	}, [needsTasks, tasks]);

	const lineage = useTaskLineage();
	const { byId: epicsById } = useEpics();
	const resolver = useMemo(
		() => buildFacetResolver({ agents, projectById, taskPorts, spaces, t, lineage, epicsById }),
		[agents, projectById, taskPorts, spaces, t, lineage, epicsById],
	);
	const ctxByTask = useMemo(() => {
		const map = new Map<string, TaskQueryContext>();
		for (const task of tasks ?? []) map.set(task.id, taskQueryContext(task, resolver));
		return map;
	}, [tasks, resolver]);

	// Newest seq first, then floated to the top by recency (persisted, survives reload).
	const orderedTasks = useMemo(
		() => orderByRecency([...(tasks ?? [])].sort((a, b) => b.seq - a.seq), getRecentTaskIds()),
		[tasks],
	);

	// The current task is always the most recent visit, so leaving it on top would
	// make Enter on an empty query a no-op. Sink it instead (VS Code's Ctrl+P does the same).
	const currentKey = currentTaskId ? `t:${currentTaskId}` : null;
	const sinkCurrent = (list: GoItem[]): GoItem[] =>
		currentKey ? [...list.filter((it) => it.id !== currentKey), ...list.filter((it) => it.id === currentKey)] : list;

	const items = useMemo<GoItem[]>(() => {
		const projectItems: GoItem[] = projects.map((p) => ({ kind: "project", id: `p:${p.id}`, project: p }));
		const spaceItems: GoItem[] = spaces.map((s) => ({ kind: "space", id: `space:${s.id}`, space: s }));
		const taskItems: GoItem[] = orderedTasks.map((task) => ({ kind: "task", id: `t:${task.id}`, task }));
		if (mode === "project") return [...projectItems, ...spaceItems];
		if (mode === "task") return sinkCurrent(taskItems);
		// Combined ("All"): interleave projects and tasks by one visit timeline
		// (e.g. Project1 · Task4 · Project3), then spaces/never-visited at the tail.
		return sinkCurrent(orderByNavRecency([...projectItems, ...taskItems, ...spaceItems]));
	}, [mode, projects, spaces, orderedTasks, currentKey]);

	const displayText = (it: GoItem): string =>
		it.kind === "space"
			? it.space.name
			: it.kind === "project"
				? projectDisplayName(it.project, t("ops.boardName"))
				: getTaskTitle(it.task);

	// Project haystack starts with the display name, so fuzzy indices stay aligned
	// with `displayText` (the one highlighted). Tasks rank/highlight on the title.
	const projectHaystack = (project: Project): string =>
		isBuiltinOpsProject(project)
			? projectDisplayName(project, t("ops.boardName"))
			: projectSearchHaystack(project.name, spaces, project.id);

	const filterRank = useMemo(
		() => (q: string, list: GoItem[]) => {
			const parsed = parseTaskQuery(q);
			const hasTaskFacet = FACET_KEYS.some((f) => parsed.facets[f].length > 0);
			const free = parsed.freeText.trim();

			const kept = list.filter((it) => {
				if (it.kind === "task") {
					return matchesTaskQuery(it.task, q, ctxByTask.get(it.task.id) ?? taskQueryContext(it.task, resolver));
				}
				// A project/space has no facets: a task-only token (label:, status:, …)
				// excludes it. Otherwise it is a plain fuzzy match on its name.
				if (hasTaskFacet) return false;
				return free === "" || fuzzyScore(free, it.kind === "project" ? projectHaystack(it.project) : it.space.name).matched;
			});

			// Empty free text keeps the input (recency) order.
			if (free === "") return kept.map((item) => ({ item, indices: [] }));

			// Rank by the free-text match on the highlighted display text; a row kept
			// by a non-title match (description, #seq, PR) stays, just below, via the
			// stable sort on an equal −1 score.
			return kept
				.map((item) => {
					const target = item.kind === "task" ? getTaskTitle(item.task) : item.kind === "project" ? projectHaystack(item.project) : item.space.name;
					const m = fuzzyScore(free, target);
					return { item, score: m.matched ? m.score : -1, indices: m.matched ? m.indices : [] };
				})
				.sort((a, b) => b.score - a.score)
				.map(({ item, indices }) => ({ item, indices }));
		},
		[ctxByTask, resolver, spaces, t],
	);

	const loading = needsTasks && tasks === null;
	const noResults = loading
		? t("goTo.loading")
		: loadFailed && mode === "task"
			? t("goTo.loadFailed")
			: t(NO_RESULTS_KEY[mode]);
	const placeholder = mode === "project" ? t("goTo.placeholder.project") : mode === "task" ? t("goTo.placeholder.task") : t("goTo.placeholder.combined");

	const cycle = (dir: 1 | -1) => {
		const i = GO_TO_MODES.indexOf(mode);
		onModeChange(GO_TO_MODES[(i + dir + GO_TO_MODES.length) % GO_TO_MODES.length]);
	};

	// Tab cycles on desktop; the strip is a real tap target so touch (no Tab, no
	// native menu in remote) can switch modes too — the touch-reachability rule.
	const header = (
		<div role="tablist" aria-label={t("goTo.title")} className="flex gap-1 mb-3">
			{GO_TO_MODES.map((m) => (
				<button
					key={m}
					type="button"
					role="tab"
					aria-selected={m === mode}
					onClick={() => onModeChange(m)}
					className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${m === mode ? "bg-accent/15 text-accent" : "text-fg-3 hover:bg-overlay-hover"}`}
					data-testid={`go-to-mode-${m}`}
				>
					{t(MODE_LABEL_KEY[m])}
				</button>
			))}
		</div>
	);

	const lockGlyph = (ariaKey: TranslationKey) => (
		<span aria-label={t(ariaKey)} className="text-fg-muted text-xs flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
			{"\u{F033E}"}
		</span>
	);

	return (
		<PaletteShell<GoItem>
			key={mode}
			items={items}
			getKey={(it) => it.id}
			getText={displayText}
			filterRank={filterRank}
			query={query}
			onQueryChange={setQuery}
			onTab={cycle}
			header={header}
			getTextClassName={(it) => {
				if (it.kind === "project") return privacy.maskClass(it.project);
				if (it.kind === "task") {
					const proj = projectById.get(it.task.projectId);
					return proj ? privacy.maskClass(proj) : "";
				}
				return "";
			}}
			onSelect={(it) => {
				if (it.kind === "project") onSelectProject(it.project.id);
				else if (it.kind === "space") onSelectSpace(it.space.id);
				else onSelectTask(it.task);
			}}
			onClose={onClose}
			placeholder={placeholder}
			ariaLabel={t("goTo.title")}
			hint={t("goTo.hint")}
			noResults={noResults}
			testId="go-to-palette"
			renderItemRight={(it, _i, q) => {
				if (it.kind === "space") {
					return <span className="text-fg-3 text-xs flex-shrink-0">{t("spaces.boardSubtitle")}</span>;
				}
				if (it.kind === "project") {
					const p = it.project;
					if (privacy.isLocked(p)) return lockGlyph("streamer.projectLocked");
					if (q.length === 0 && isBuiltinOpsProject(p)) return <span className="text-fg-3 text-xs flex-shrink-0">⌘0</span>;
					const idx = shortcutIndexById?.[p.id];
					return idx !== undefined && idx < 9 && q.length === 0 ? <span className="text-fg-3 text-xs flex-shrink-0">⌘{idx + 1}</span> : null;
				}
				const proj = projectById.get(it.task.projectId);
				return (
					<span className="flex items-center gap-2 flex-shrink-0 min-w-0 max-w-[45%] text-xs">
						{proj && privacy.isLocked(proj) && lockGlyph("streamer.projectLocked")}
						<span className={`text-fg-3 truncate ${proj ? privacy.maskClass(proj) : ""}`}>
							{proj ? projectDisplayName(proj, t("ops.boardName")) : ""} · #{it.task.seq}
						</span>
						{it.task.hidden && <span className="text-fg-muted">{t("coordinatorFinder.state.hidden")}</span>}
					</span>
				);
			}}
		/>
	);
}

export default GoToPalette;
