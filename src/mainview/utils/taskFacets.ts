import type { CodingAgent, Label, Task, TaskStatus } from "../../shared/types";
import type { FacetKey, TaskQueryContext } from "./taskSearch";
import { getTaskAgentMeta } from "./taskAgentMeta";

/**
 * Facet-pool builders shared by the Kanban filter bar and the Active Tasks
 * sidebar. Each surface supplies a `FacetResolver` (built from data it already
 * holds) and its own status-option candidates; this module turns that into the
 * per-task `TaskQueryContext` for matching and the grouped, present-values-only
 * option list the funnel renders. See `taskSearch.ts` for the DSL semantics.
 */

/** The funnel groups. FLAGS bundles the boolean `is:`/`has:` facets. */
export type FilterGroupId = "priority" | "status" | "labels" | "agents" | "flags";

export interface FilterFunnelOption {
	facet: FacetKey;
	/** Token value inserted/removed (auto-quoted by the DSL when it has spaces). */
	value: string;
	/** Display label. */
	label: string;
	/** Optional dot color (labels, custom-column statuses). */
	color?: string;
}

export interface FilterFunnelGroup {
	id: FilterGroupId;
	options: FilterFunnelOption[];
}

/** Statuses that, on their own, mean a task is waiting on the user. */
const ATTENTION_STATUSES: TaskStatus[] = ["user-questions", "review-by-user"];

/**
 * A task needs attention when it is in an attention status, OR it is a PR-review
 * (`review-by-colleague`) task that currently has a live bell. Single source of
 * truth for both the sidebar attention scope and the `is:attention` facet.
 */
export function isAttentionTask(task: Task, bellCounts: Map<string, number>): boolean {
	return (
		ATTENTION_STATUSES.includes(task.status) ||
		(task.status === "review-by-colleague" && (bellCounts.get(task.id) ?? 0) > 0)
	);
}

export interface FacetResolver {
	agents: CodingAgent[];
	labelsFor: (task: Task) => Label[];
	/** Match targets for `status:`; canonical (funnel) value FIRST. */
	statusValuesFor: (task: Task) => string[];
	/** The task's effective priority level (e.g. "P2"). */
	priorityFor: (task: Task) => string;
	hasPortFor: (task: Task) => boolean;
	isAttentionFor: (task: Task) => boolean;
	prNumberFor?: (task: Task) => number | null;
}

/** Resolve the display agent name for a task, or null when unassigned. */
export function taskAgentName(task: Task, agents: CodingAgent[]): string | null {
	return getTaskAgentMeta(task, agents).agent?.name ?? null;
}

/** Build the pure per-task facet context the matcher consumes. */
export function taskQueryContext(task: Task, resolver: FacetResolver): TaskQueryContext {
	return {
		labelNames: resolver.labelsFor(task).map((l) => l.name),
		agentName: taskAgentName(task, resolver.agents),
		statusValues: resolver.statusValuesFor(task),
		priorityValue: resolver.priorityFor(task).toLowerCase(),
		hasPort: resolver.hasPortFor(task),
		isAttention: resolver.isAttentionFor(task),
		prNumber: resolver.prNumberFor?.(task) ?? null,
	};
}

export interface FilterFunnelCandidates {
	/** Full ordered priority vocabulary (P0…P4) with display labels. */
	priorityCandidates: FilterFunnelOption[];
	/** Full ordered status vocabulary (built-in statuses + custom columns). */
	statusCandidates: FilterFunnelOption[];
	flagLabels: { attention: string; port: string };
}

/**
 * Build the funnel's grouped options from the visible task pool: only values
 * actually present, empty groups dropped. PRIORITY leads (it is the most
 * important quick filter), then STATUS, LABELS, AGENTS, FLAGS. Candidate
 * vocabularies (priority, status) keep their given order; LABELS/AGENTS sort
 * alphabetically for stable display.
 */
export function buildFilterGroups(
	tasks: Task[],
	resolver: FacetResolver,
	{ priorityCandidates, statusCandidates, flagLabels }: FilterFunnelCandidates,
): FilterFunnelGroup[] {
	const labelByValue = new Map<string, FilterFunnelOption>();
	const agentByValue = new Map<string, FilterFunnelOption>();
	const presentStatus = new Set<string>();
	const presentPriority = new Set<string>();
	let anyAttention = false;
	let anyPort = false;

	for (const task of tasks) {
		for (const label of resolver.labelsFor(task)) {
			const key = label.name.toLowerCase();
			if (!labelByValue.has(key)) {
				labelByValue.set(key, { facet: "label", value: label.name, label: label.name, color: label.color });
			}
		}
		const agentName = taskAgentName(task, resolver.agents);
		if (agentName) {
			const key = agentName.toLowerCase();
			if (!agentByValue.has(key)) {
				agentByValue.set(key, { facet: "agent", value: agentName, label: agentName });
			}
		}
		const canonicalStatus = resolver.statusValuesFor(task)[0];
		if (canonicalStatus) presentStatus.add(canonicalStatus.toLowerCase());
		presentPriority.add(resolver.priorityFor(task).toLowerCase());
		if (resolver.isAttentionFor(task)) anyAttention = true;
		if (resolver.hasPortFor(task)) anyPort = true;
	}

	const priorityOptions = priorityCandidates.filter((c) => presentPriority.has(c.value.toLowerCase()));
	const statusOptions = statusCandidates.filter((c) => presentStatus.has(c.value.toLowerCase()));
	const byLabel = (a: FilterFunnelOption, b: FilterFunnelOption) => a.label.localeCompare(b.label);
	const labelOptions = [...labelByValue.values()].sort(byLabel);
	const agentOptions = [...agentByValue.values()].sort(byLabel);
	const flagOptions: FilterFunnelOption[] = [];
	if (anyAttention) flagOptions.push({ facet: "is", value: "attention", label: flagLabels.attention });
	if (anyPort) flagOptions.push({ facet: "has", value: "port", label: flagLabels.port });

	const groups: FilterFunnelGroup[] = [
		{ id: "priority", options: priorityOptions },
		{ id: "status", options: statusOptions },
		{ id: "labels", options: labelOptions },
		{ id: "agents", options: agentOptions },
		{ id: "flags", options: flagOptions },
	];
	return groups.filter((g) => g.options.length > 0);
}
