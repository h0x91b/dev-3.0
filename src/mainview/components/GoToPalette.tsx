import { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { useEpics } from "../hooks/useEpics";
import type { Project, Task } from "../../shared/types";
import { useT, type TranslationKey } from "../i18n";
import { useAgents } from "../hooks/useAgents";
import { api } from "../rpc";
import { useProjectPrivacy } from "../sensitive-projects";
import { useSpaces } from "../useSpaces";
import { buildFacetResolver } from "../utils/facetResolver";
import { useTaskLineage } from "../hooks/useTaskLineage";
import { fuzzyScore } from "../utils/fuzzyMatch";
import { getRecentTaskIds } from "../utils/recentTasks";
import { orderByRecency } from "../utils/recentProjects";
import { orderByNavRecency } from "../utils/recentNav";
import { taskQueryContext } from "../utils/taskFacets";
import { FACET_KEYS, parseTaskQuery, type TaskQueryContext } from "../utils/taskSearch";
import { getGoToSourceRegistry, guardGoToSource, reportGoToSourceFailure, type AnyGoToSource, type GoToData, type GoToQuery, type GoToRow, type GoToView } from "../go-to-sources/registry";
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

/** A palette row and the `goToSources` item that produced it. */
interface GoItem {
	id: string;
	text: string;
	row: GoToRow;
	source: AnyGoToSource;
}

/** A row whose trailing content crashes on render loses only that content. */
class RightBoundary extends Component<{ source: AnyGoToSource; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(error: Error, _info: ErrorInfo) {
		reportGoToSourceFailure(this.props.source, "render", error);
	}
	render() {
		return this.state.failed ? null : this.props.children;
	}
}

interface GoToPaletteProps {
	mode: GoToMode;
	onModeChange: (mode: GoToMode) => void;
	/** Non-deleted projects in display order (recency-first) — the project rows. */
	projects: Project[];
	/** Project or space id → 0-based digit index, for the ⌘N badge (stable, not the display order). */
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

	const registry = getGoToSourceRegistry();
	const sources = useSyncExternalStore(registry.subscribe, registry.list);

	const data = useMemo<GoToData>(
		() => ({
			projects,
			spaces,
			tasks: orderedTasks,
			projectById,
			t,
			taskContext: (task) => ctxByTask.get(task.id) ?? taskQueryContext(task, resolver),
		}),
		[projects, spaces, orderedTasks, projectById, t, ctxByTask, resolver],
	);

	// The open callbacks change with every App render; reading them through a ref keeps rows stable.
	const open = useRef({ onSelectProject, onSelectSpace, onSelectTask });
	open.current = { onSelectProject, onSelectSpace, onSelectTask };
	const view: GoToView = {
		...data,
		privacy,
		shortcutIndexById,
		openProject: (id) => open.current.onSelectProject(id),
		openSpace: (id) => open.current.onSelectSpace(id),
		openTask: (task) => open.current.onSelectTask(task),
	};

	// The current task is always the most recent visit, so leaving it on top would
	// make Enter on an empty query a no-op. Sink it instead (VS Code's Ctrl+P does the same).
	const currentKey = currentTaskId ? `t:${currentTaskId}` : null;

	// Rows come from the slot snapshot, rebuilt when a source or its data changes — never per keystroke.
	const items = useMemo<GoItem[]>(() => {
		const merged = sources
			.filter(({ def }) => def.modes.includes(mode))
			.flatMap(({ def }) => guardGoToSource(def, "rows", () => def.rows(data), []).map((row) => ({ id: row.id, text: row.text, row, source: def })));
		// "All" interleaves every source by one visit timeline (e.g. Project1 · Task4 · Project3).
		const ordered = mode === "combined" ? orderByNavRecency(merged) : merged;
		return currentKey ? [...ordered.filter((it) => it.id !== currentKey), ...ordered.filter((it) => it.id === currentKey)] : ordered;
	}, [sources, mode, data, currentKey]);

	const filterRank = useMemo(
		() => (q: string, list: GoItem[]) => {
			const parsed = parseTaskQuery(q);
			const query: GoToQuery = { raw: q, free: parsed.freeText.trim(), hasTaskFacet: FACET_KEYS.some((f) => parsed.facets[f].length > 0) };
			const kept = list.filter((it) => guardGoToSource(it.source, "matches", () => it.source.matches(it.row, query, data), false));

			// Empty free text keeps the input (recency) order.
			if (query.free === "") return kept.map((item) => ({ item, indices: [] }));

			// Rank by the free-text match on the highlighted display text; a row kept
			// by a non-title match (description, #seq, PR) stays, just below, via the
			// stable sort on an equal −1 score.
			return kept
				.map((item) => {
					const { source, row } = item;
					const target = source.rankText ? guardGoToSource(source, "rankText", () => source.rankText!(row, data), row.text) : row.text;
					const m = fuzzyScore(query.free, target);
					return { item, score: m.matched ? m.score : -1, indices: m.matched ? m.indices : [] };
				})
				.sort((a, b) => b.score - a.score)
				.map(({ item, indices }) => ({ item, indices }));
		},
		[data],
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

	return (
		<PaletteShell<GoItem>
			key={mode}
			items={items}
			getKey={(it) => it.id}
			getText={(it) => it.text}
			filterRank={filterRank}
			query={query}
			onQueryChange={setQuery}
			onTab={cycle}
			header={header}
			getTextClassName={(it) => (it.source.textClassName ? guardGoToSource(it.source, "textClassName", () => it.source.textClassName!(it.row, view), "") : "")}
			onSelect={(it) => guardGoToSource(it.source, "select", () => it.source.select(it.row, view), undefined)}
			onClose={onClose}
			placeholder={placeholder}
			ariaLabel={t("goTo.title")}
			hint={t("goTo.hint")}
			noResults={noResults}
			testId="go-to-palette"
			renderItemRight={(it, _i, q) => {
				const { source } = it;
				if (!source.right) return null;
				const right = guardGoToSource(source, "right", () => source.right!(it.row, q, view), null);
				return right === null ? null : <RightBoundary source={source}>{right}</RightBoundary>;
			}}
		/>
	);
}

export default GoToPalette;
