import type { Project, Task, TaskLineageIndex, TaskLineageNode } from "../../shared/types";
import { taskOrigin } from "../../shared/types";

/**
 * The board's view of task lineage (see Task.origin): who a task's parent is and
 * which tasks a parent's variant group created, across every project. Built once
 * from the backend's `getTaskLineage` index; everything here is pure.
 */
export interface TaskLineage {
	/** False until the first index arrives — nothing is "deleted" before that. */
	loaded: boolean;
	nodeById: ReadonlyMap<string, TaskLineageNode>;
	/** Direct children keyed by the parent's {@link groupKey} — a variant group is one parent. */
	childrenByGroup: ReadonlyMap<string, readonly TaskLineageNode[]>;
}

export const EMPTY_LINEAGE: TaskLineage = { loaded: false, nodeById: new Map(), childrenByGroup: new Map() };

/** A variant group's identity: every variant of one task shares project and seq. */
export function groupKey(node: { projectId: string; seq: number }): string {
	return `${node.projectId}#${node.seq}`;
}

export function buildTaskLineage(index: TaskLineageIndex): TaskLineage {
	const nodeById = new Map(index.nodes.map((node) => [node.id, node]));
	const childrenByGroup = new Map<string, TaskLineageNode[]>();
	for (const { childId, parentId } of index.edges) {
		const parent = nodeById.get(parentId);
		const child = nodeById.get(childId);
		if (!parent || !child) continue;
		const key = groupKey(parent);
		const list = childrenByGroup.get(key);
		if (list) list.push(child);
		else childrenByGroup.set(key, [child]);
	}
	return { loaded: true, nodeById, childrenByGroup };
}

/**
 * The task's parent: the node, `"deleted"` when it no longer exists, or null for
 * a task no other task created (or while the index is still loading).
 */
export function lineageParent(task: Task, lineage: TaskLineage): TaskLineageNode | "deleted" | null {
	const origin = taskOrigin(task);
	if (origin.kind !== "task" || !lineage.loaded) return null;
	return lineage.nodeById.get(origin.taskId) ?? "deleted";
}

/** Direct children of the task's variant group, from every project. */
export function lineageChildren(task: Pick<Task, "projectId" | "seq">, lineage: TaskLineage): readonly TaskLineageNode[] {
	return lineage.childrenByGroup.get(groupKey(task)) ?? [];
}

// ---- `children:` search token ----

type ProjectRef = Pick<Project, "id" | "name">;

function projectsNamed(name: string, projects: readonly ProjectRef[]): ProjectRef[] {
	const wanted = name.toLowerCase();
	return projects.filter((p) => p.name.toLowerCase() === wanted);
}

/**
 * Every `children:` value (lowercased) that names this group: bare `seq` in the
 * surface's own project, `name/seq` when the name is unique, and `id/seq` by
 * full id or 8-character prefix. An ambiguous name yields no `name/seq` value,
 * so it matches nothing rather than a mix of projects.
 */
function groupRefs(projectId: string, seq: number, projects: readonly ProjectRef[], currentProjectId: string | null): string[] {
	const refs = [`${projectId.toLowerCase()}/${seq}`, `${projectId.slice(0, 8).toLowerCase()}/${seq}`];
	if (projectId === currentProjectId) refs.push(String(seq));
	const project = projects.find((p) => p.id === projectId);
	if (project && projectsNamed(project.name, projects).length === 1) refs.push(`${project.name.toLowerCase()}/${seq}`);
	return refs;
}

/**
 * The values a `children:` token can take to select this task: its own group
 * (the parent appears in its own filter) and its parent's group (one level only).
 */
export function childrenTokenRefs(
	task: Task,
	lineage: TaskLineage,
	projects: readonly ProjectRef[],
	currentProjectId: string | null,
): string[] {
	const refs = groupRefs(task.projectId, task.seq, projects, currentProjectId);
	const parent = lineageParent(task, lineage);
	if (parent && parent !== "deleted") refs.push(...groupRefs(parent.projectId, parent.seq, projects, currentProjectId));
	return refs;
}

/** Canonical form of a typed `children:` value: trimmed, lowercased, `#` before the seq dropped. */
export function normalizeChildrenValue(value: string): string {
	return value.trim().toLowerCase().replace(/(^|\/)#(?=\d+$)/, "$1");
}

/**
 * The shortest `children:` token that names a parent's group from this surface:
 * the bare seq in the surface's own project, else `name/seq` (quoted when the
 * name has spaces), else the 8-character project id when the name is ambiguous.
 */
export function childrenFilterToken(
	parent: { projectId: string; seq: number },
	projects: readonly ProjectRef[],
	currentProjectId: string | null,
): string {
	if (parent.projectId === currentProjectId) return `children:${parent.seq}`;
	const project = projects.find((p) => p.id === parent.projectId);
	if (!project || projectsNamed(project.name, projects).length !== 1) {
		return `children:${parent.projectId.slice(0, 8)}/${parent.seq}`;
	}
	const name = /[\s"\\]/.test(project.name) ? `"${project.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : project.name;
	return `children:${name}/${parent.seq}`;
}

/** Replace any `children:` token in the query with `token`, keeping every other facet. */
export function withChildrenToken(query: string, token: string): string {
	const rest = query
		.replace(/(^|\s)children:(?:"(?:\\.|[^"\\])*"\S*|\S+)/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return rest ? `${rest} ${token}` : token;
}

/** What a `children:` value in the query resolves to on this surface. */
export type ChildrenTokenResolution =
	| { kind: "group"; projectId: string; seq: number }
	| { kind: "ambiguous"; name: string; projectIds: string[]; seq: number }
	| { kind: "unknown" };

export function resolveChildrenValue(
	value: string,
	projects: readonly ProjectRef[],
	currentProjectId: string | null,
): ChildrenTokenResolution {
	const normalized = normalizeChildrenValue(value);
	const slash = normalized.lastIndexOf("/");
	const seqText = slash === -1 ? normalized : normalized.slice(slash + 1);
	if (!/^\d+$/.test(seqText)) return { kind: "unknown" };
	const seq = Number(seqText);
	if (slash === -1) return currentProjectId ? { kind: "group", projectId: currentProjectId, seq } : { kind: "unknown" };
	const projectPart = normalized.slice(0, slash);
	const byId = projects.filter((p) => p.id.toLowerCase() === projectPart || (projectPart.length >= 8 && p.id.toLowerCase().startsWith(projectPart)));
	if (byId.length === 1) return { kind: "group", projectId: byId[0].id, seq };
	const named = projectsNamed(projectPart, projects);
	if (named.length === 1) return { kind: "group", projectId: named[0].id, seq };
	if (named.length > 1) return { kind: "ambiguous", name: named[0].name, projectIds: named.map((p) => p.id), seq };
	return { kind: "unknown" };
}

/** What a card needs to draw its lineage cluster; null halves render nothing. */
export interface CardLineage {
	/** The parent's `#seq` label (`#1801`, `#42-2`); `"deleted"` once it is gone. */
	parentLabel: string | "deleted" | null;
	parentTitle: string | null;
	childCount: number;
	onFilterByParent: (() => void) | null;
	onFilterByChildren: (() => void) | null;
}

export function parentSeqLabel(node: Pick<TaskLineageNode, "seq" | "variantIndex">): string {
	return node.variantIndex !== null ? `#${node.seq}-${node.variantIndex}` : `#${node.seq}`;
}
