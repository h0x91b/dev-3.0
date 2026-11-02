import type { Epic, Task } from "../../../shared/types";
import { parentTaskIdOf } from "../../../shared/types/task-origin";
import type { BoardLineageNode } from "../board-service";

/** How the Tree groups its top level: not at all, or one group per epic with lineage trees under it. */
export type TreeGroupBy = "none" | "epic";

/** What the Tree persists through `ctx.board.setLayout("builtin:tree", …)`. */
export interface TreeLayout {
	groupBy: TreeGroupBy;
	/** Keys of expanded nodes. Everything else is collapsed — the default on a fresh board. */
	expanded: string[];
	/** Hide top-level tasks that have no parent and no children. */
	lineageOnly: boolean;
	/**
	 * Epic groups the user opened or closed, by group key. Groups have their own
	 * default — open, except archived epics — so only a choice against it is stored.
	 */
	groupOpen: Record<string, boolean>;
}

export const DEFAULT_TREE_LAYOUT: TreeLayout = { groupBy: "none", expanded: [], lineageOnly: false, groupOpen: {} };

export function normalizeTreeLayout(raw: unknown): TreeLayout {
	if (typeof raw !== "object" || raw === null) return DEFAULT_TREE_LAYOUT;
	const stored = raw as { groupBy?: unknown; expanded?: unknown; lineageOnly?: unknown; groupOpen?: unknown };
	const expanded = Array.isArray(stored.expanded) ? stored.expanded.filter((k): k is string => typeof k === "string") : [];
	const groupOpen: Record<string, boolean> = {};
	if (typeof stored.groupOpen === "object" && stored.groupOpen !== null) {
		for (const [key, open] of Object.entries(stored.groupOpen)) if (typeof open === "boolean") groupOpen[key] = open;
	}
	return {
		groupBy: stored.groupBy === "epic" ? "epic" : "none",
		expanded: [...new Set(expanded)],
		lineageOnly: stored.lineageOnly === true,
		groupOpen,
	};
}

/** One task's variant group: every variant of a task shares its project and seq. */
export function unitKey(task: { projectId: string; seq: number }): string {
	return `${task.projectId}#${task.seq}`;
}

export function ghostKey(node: { projectId: string; seq: number }): string {
	return `ghost:${unitKey(node)}`;
}

export type TreeNode =
	| {
		kind: "task";
		key: string;
		/** The variants of one task, attempt order. A plain task is a group of one. */
		tasks: Task[];
		/** False for an ancestor shown only so a matching descendant has its place. */
		matches: boolean;
		children: TreeNode[];
	}
	| {
		/** A parent outside this board — another project. Shown, never opened. */
		kind: "ghost";
		key: string;
		ref: BoardLineageNode;
		matches: false;
		children: TreeNode[];
	}
	| {
		/** One epic (or "No epic", `epic: null`) holding the lineage trees of its tasks. */
		kind: "group";
		key: string;
		epic: Epic | null;
		matches: false;
		children: TreeNode[];
	};

export interface TreeInput {
	/** Scope ∩ board query. */
	tasks: readonly Task[];
	/** The whole scope, so a non-matching ancestor still has its place. */
	scopeTasks: readonly Task[];
	/** Any lineage task, any project; null when unknown or still loading. */
	lineageNode(id: string): BoardLineageNode | "deleted" | null;
}

function byAttempt(a: Task, b: Task): number {
	return (a.variantIndex ?? 0) - (b.variantIndex ?? 0);
}

/**
 * The lineage forest of a board (spec D19). A task's parent is its lineage
 * origin; variants of a task are one node; a parent on another board becomes a
 * ghost root. Tasks that do not match the query appear only as ancestors of
 * ones that do. Roots and children are newest first.
 */
export function buildTaskTree({ tasks, scopeTasks, lineageNode }: TreeInput): TreeNode[] {
	const unitsByKey = new Map<string, Task[]>();
	const unitKeyById = new Map<string, string>();
	for (const task of scopeTasks) {
		const key = unitKey(task);
		unitKeyById.set(task.id, key);
		const unit = unitsByKey.get(key);
		if (unit) unit.push(task);
		else unitsByKey.set(key, [task]);
	}
	const matching = new Set(tasks.map(unitKey));

	type Parent = { kind: "unit"; key: string } | { kind: "ghost"; key: string; ref: BoardLineageNode } | null;
	const parentCache = new Map<string, Parent>();
	const parentOf = (key: string): Parent => {
		if (parentCache.has(key)) return parentCache.get(key)!;
		let parent: Parent = null;
		for (const task of unitsByKey.get(key) ?? []) {
			const parentId = parentTaskIdOf(task);
			if (!parentId) continue;
			const inScope = unitKeyById.get(parentId);
			if (inScope) {
				if (inScope !== key) parent = { kind: "unit", key: inScope };
			} else {
				const ref = lineageNode(parentId);
				if (ref && ref !== "deleted") parent = { kind: "ghost", key: ghostKey(ref), ref };
			}
			if (parent) break;
		}
		parentCache.set(key, parent);
		return parent;
	};

	const nodes = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];
	const ensure = (key: string, ghost?: BoardLineageNode): TreeNode => {
		const existing = nodes.get(key);
		if (existing) return existing;
		const node: TreeNode = ghost
			? { kind: "ghost", key, ref: ghost, matches: false, children: [] }
			: { kind: "task", key, tasks: [...unitsByKey.get(key)!].sort(byAttempt), matches: matching.has(key), children: [] };
		nodes.set(key, node);
		if (ghost) {
			roots.push(node);
			return node;
		}
		// Walk up, guarding against a cycle a corrupt origin could form.
		const parent = parentOf(key);
		if (!parent || isAncestorCycle(key, parent.key)) roots.push(node);
		else ensure(parent.key, parent.kind === "ghost" ? parent.ref : undefined).children.push(node);
		return node;
	};
	const isAncestorCycle = (key: string, startKey: string): boolean => {
		const seen = new Set<string>([key]);
		let cursor: string | null = startKey;
		while (cursor && !cursor.startsWith("ghost:")) {
			if (seen.has(cursor)) return true;
			seen.add(cursor);
			cursor = parentOf(cursor)?.key ?? null;
		}
		return false;
	};

	for (const key of matching) if (unitsByKey.has(key)) ensure(key);

	const newestFirst = (a: TreeNode, b: TreeNode) => nodeSeq(b) - nodeSeq(a);
	const sortDeep = (list: TreeNode[]) => {
		list.sort(newestFirst);
		for (const node of list) sortDeep(node.children);
	};
	sortDeep(roots);
	return roots;
}

export function nodeSeq(node: TreeNode): number {
	if (node.kind === "group") return 0;
	return node.kind === "ghost" ? node.ref.seq : node.tasks[0].seq;
}

export const NO_EPIC_GROUP_KEY = "epic:none";

export function epicGroupKey(epicId: string | null): string {
	return epicId ? `epic:${epicId}` : NO_EPIC_GROUP_KEY;
}

/** A group opens by itself unless its epic is archived; the user's choice wins. */
export function isGroupOpen(node: Extract<TreeNode, { kind: "group" }>, groupOpen: Readonly<Record<string, boolean>>): boolean {
	return groupOpen[node.key] ?? !node.epic?.archived;
}

/**
 * The forest split by epic (spec D19): one group per epic that has a task here,
 * active epics by name, then archived ones, then "No epic". A task sits in its
 * own epic; a parent in another epic does not pull it out, so the child is a
 * root of its group. An epic id missing from the registry counts as no epic,
 * the same rule the `epic:` search token follows.
 */
export function buildEpicForest(input: TreeInput & { epics: readonly Epic[] }, opts: { lineageOnly: boolean }): TreeNode[] {
	const epicsById = new Map(input.epics.map((epic) => [epic.id, epic]));
	const groupOf = (task: Task) => (task.epicId && epicsById.has(task.epicId) ? task.epicId : null);
	// Variants follow their first attempt, so a variant group is never split.
	const leads = new Map<string, Task>();
	for (const task of [...input.scopeTasks, ...input.tasks]) {
		const key = unitKey(task);
		const lead = leads.get(key);
		if (!lead || byAttempt(task, lead) < 0) leads.set(key, task);
	}
	const unitGroup = (task: Task) => groupOf(leads.get(unitKey(task))!);
	const scopeIds = new Set(input.scopeTasks.map((task) => task.id));
	const partitions = new Map<string | null, { tasks: Task[]; scopeTasks: Task[] }>();
	const partition = (group: string | null) => {
		let part = partitions.get(group);
		if (!part) partitions.set(group, (part = { tasks: [], scopeTasks: [] }));
		return part;
	};
	for (const task of input.scopeTasks) partition(unitGroup(task)).scopeTasks.push(task);
	for (const task of input.tasks) partition(unitGroup(task)).tasks.push(task);

	const groups: TreeNode[] = [];
	for (const [epicId, part] of partitions) {
		if (part.tasks.length === 0) continue;
		const key = epicGroupKey(epicId);
		let children = buildTaskTree({
			tasks: part.tasks,
			scopeTasks: part.scopeTasks,
			// A parent on this board but in another epic is not a ghost: the child just starts its group's tree.
			lineageNode: (id) => (scopeIds.has(id) ? null : input.lineageNode(id)),
		}).map((node) => (node.kind === "ghost" ? { ...node, key: `${key}/${node.key}` } : node));
		if (opts.lineageOnly) children = children.filter((node) => !isStandalone(node));
		if (children.length === 0) continue;
		groups.push({ kind: "group", key, epic: epicId ? epicsById.get(epicId)! : null, matches: false, children });
	}
	const rank = (node: TreeNode) => (node.kind !== "group" || !node.epic ? 2 : node.epic.archived ? 1 : 0);
	const name = (node: TreeNode) => (node.kind === "group" && node.epic ? node.epic.name : "");
	return groups.sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
}

/** A root with neither parent nor children: lineage-only boards hide it. */
export function isStandalone(node: TreeNode): boolean {
	return node.kind === "task" && node.children.length === 0;
}

export interface TreeRow {
	node: TreeNode;
	depth: number;
	expanded: boolean;
	parentIndex: number;
	/** Descendants that match the query, for the collapsed count. */
	descendantCount: number;
}

function countDescendants(node: TreeNode): number {
	let count = 0;
	for (const child of node.children) count += 1 + countDescendants(child);
	return count;
}

/**
 * The rows on screen: a depth-first walk that enters a node only when it is
 * expanded. While a query is typed, a node that is only an ancestor of a match
 * opens by itself, so a hit is never buried under a collapsed parent — unless
 * the user closed it again under this query (`closed`).
 */
export function flattenTree(
	roots: readonly TreeNode[],
	expanded: ReadonlySet<string>,
	opts: { revealMatches: boolean; closed?: ReadonlySet<string> },
): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (list: readonly TreeNode[], depth: number, parentIndex: number) => {
		for (const node of list) {
			const forced = opts.revealMatches && !node.matches && !opts.closed?.has(node.key);
			const isOpen = node.children.length > 0 && (expanded.has(node.key) || forced);
			const index = rows.length;
			rows.push({ node, depth, expanded: isOpen, parentIndex, descendantCount: countDescendants(node) });
			if (isOpen) walk(node.children, depth + 1, index);
		}
	};
	walk(roots, 0, -1);
	return rows;
}

export function toggleExpanded(layout: TreeLayout, key: string, open: boolean): TreeLayout {
	const has = layout.expanded.includes(key);
	if (has === open) return layout;
	return { ...layout, expanded: open ? [...layout.expanded, key] : layout.expanded.filter((k) => k !== key) };
}

/** Every task or ghost key with children in the forest, for "Expand all". Epic groups open through `groupOpen`. */
export function expandableKeys(roots: readonly TreeNode[]): string[] {
	const keys: string[] = [];
	const walk = (list: readonly TreeNode[]) => {
		for (const node of list) {
			if (node.children.length === 0) continue;
			if (node.kind !== "group") keys.push(node.key);
			walk(node.children);
		}
	};
	walk(roots);
	return keys;
}
