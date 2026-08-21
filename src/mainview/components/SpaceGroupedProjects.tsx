import { useState, type DragEvent, type ReactNode } from "react";
import { isSpaceSensitive, type Project, type Space } from "../../shared/types";
import type { DashboardGroup } from "../utils/spaceGroups";
import { MASK_CLASS } from "../sensitive-projects";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import SpaceHeaderMenu from "./SpaceHeaderMenu";

const LS_COLLAPSED_SPACES = "dev3-collapsed-spaces";

/**
 * A group's own rows are 8px from its header and 16px from each other; the next
 * group starts 40px away (24px here plus the list's own 16px). Proximity is the
 * only thing that says which rows belong to which space — with one 16px gap
 * everywhere, a header read as another row in a flat list (§9a.6: the gap
 * between groups must be at least twice the gap inside one).
 */
const GROUP_CLASS = "pt-6 space-y-2";
/**
 * The rows hang off their header: indented, with a hairline running down from
 * it. Spacing alone did not say "these belong to that" — the rows are full-width
 * cards with their own borders, so a gap between them read as a flat list with
 * headings dropped in. A box around the group would have put a second border
 * around cards that already have one; a rule and an indent are the same
 * statement without the frame (§9a.6).
 */
const ROWS_CLASS = "space-y-4 ml-2 pl-4 border-l border-edge";

function readCollapsed(): Set<string> {
	try {
		const raw = localStorage.getItem(LS_COLLAPSED_SPACES);
		if (raw) return new Set(JSON.parse(raw) as string[]);
	} catch { /* ignore */ }
	return new Set();
}

function writeCollapsed(ids: Set<string>) {
	try {
		localStorage.setItem(LS_COLLAPSED_SPACES, JSON.stringify([...ids]));
	} catch { /* ignore */ }
}

/** Per-row reorder wiring, injected so one row renderer serves every context. */
export interface RowReorderCtx {
	/** False when the group holds one project — nothing to reorder, so the whole
	 *  grip + up/down cluster is hidden rather than shown inert. */
	showReorder: boolean;
	isDragged: boolean;
	/** A row in THIS group is being dragged, so every row here collapses to one
	 *  line. Scoped to the group because only this group accepts the drop. */
	groupDragActive: boolean;
	dragEnabled: boolean;
	onDragStart: (event: DragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
	onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	onDragLeave: () => void;
	onDrop: (event: DragEvent<HTMLDivElement>) => void;
	showDropBefore: boolean;
	showDropAfter: boolean;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
}

interface SpaceGroupedProjectsProps {
	groups: DashboardGroup[];
	sensitiveProjectIds: ReadonlySet<string>;
	/** Split header counts: tasks waiting on the user vs. tasks in flight. */
	needsYouCountOf: (projectId: string) => number;
	workingCountOf: (projectId: string) => number;
	renderProject: (project: Project, reorder: RowReorderCtx, groupSpaceId: string | null) => ReactNode;
	/** The bottom block still owns global order — same callback as the flat path. */
	renderBottomBlockProject: (project: Project, blockProjects: Project[]) => ReactNode;
	/** Opens the membership editor for this space (the menu's `Edit projects…`). */
	onEditProjects?: (space: Space) => void;
	onRenameSpace?: (space: Space, name: string) => void;
	onDeleteSpace?: (space: Space) => void;
	/** Step this space one position in the app-wide space order. */
	onMoveSpace?: (space: Space, delta: -1 | 1) => void;
	/** Every space id in order — the visible groups are a filtered subset, so the
	 *  edges of `Move up` / `Move down` cannot be read off `groups`. */
	spaceOrder?: string[];
}

/**
 * Space headers around the dashboard's existing project rows. Owns collapse
 * state and within-space project drag (that space's projectIds). Drag never
 * crosses groups and never changes membership. Space order is dragged in the
 * rail; this header only carries the stepwise `Move up` / `Move down` for
 * pointers that cannot drag.
 */
function SpaceGroupedProjects({
	groups,
	sensitiveProjectIds,
	needsYouCountOf,
	workingCountOf,
	renderProject,
	renderBottomBlockProject,
	onEditProjects,
	onRenameSpace,
	onDeleteSpace,
	onMoveSpace,
	spaceOrder,
}: SpaceGroupedProjectsProps) {
	const t = useT();
	const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
	const [dragged, setDragged] = useState<{ spaceId: string; projectId: string } | null>(null);
	const [dropTarget, setDropTarget] = useState<{ spaceId: string; projectId: string; side: "before" | "after" } | null>(null);

	function toggleCollapsed(spaceId: string) {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(spaceId)) next.delete(spaceId);
			else next.add(spaceId);
			writeCollapsed(next);
			return next;
		});
	}

	async function reorderWithinSpace(spaceId: string, members: Project[], sourceId: string, targetId: string, side: "before" | "after") {
		if (sourceId === targetId) return;
		const ids = members.map((p) => p.id);
		ids.splice(ids.indexOf(sourceId), 1);
		const targetIdx = ids.indexOf(targetId);
		if (targetIdx === -1) return;
		ids.splice(side === "after" ? targetIdx + 1 : targetIdx, 0, sourceId);
		try {
			await api.request.reorderSpaceProjects({ spaceId, projectIds: ids });
		} catch (err) {
			toast.error(t("spaces.failedUpdate", { error: String(err) }));
		}
	}

	function rowCtx(spaceId: string, members: Project[], project: Project, index: number): RowReorderCtx {
		const isTarget = dropTarget?.spaceId === spaceId && dropTarget.projectId === project.id;
		const canReorder = members.length > 1;
		return {
			showReorder: canReorder,
			isDragged: dragged?.spaceId === spaceId && dragged.projectId === project.id,
			groupDragActive: dragged?.spaceId === spaceId,
			dragEnabled: canReorder,
			onDragStart: (event) => {
				setDragged({ spaceId, projectId: project.id });
				event.dataTransfer.setData("text/plain", `space-project:${spaceId}:${project.id}`);
				event.dataTransfer.effectAllowed = "move";
			},
			onDragEnd: () => {
				setDragged(null);
				setDropTarget(null);
			},
			onDragOver: (event) => {
				// Cross-group drops are a no-op: membership is not drag's job.
				if (!dragged || dragged.spaceId !== spaceId || dragged.projectId === project.id) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				const rect = event.currentTarget.getBoundingClientRect();
				const side = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
				setDropTarget({ spaceId, projectId: project.id, side });
			},
			onDragLeave: () => {
				setDropTarget((cur) => (cur?.spaceId === spaceId && cur.projectId === project.id ? null : cur));
			},
			onDrop: (event) => {
				event.preventDefault();
				if (!dragged || dragged.spaceId !== spaceId) return;
				const side = isTarget ? dropTarget.side : "before";
				const source = dragged.projectId;
				setDragged(null);
				setDropTarget(null);
				void reorderWithinSpace(spaceId, members, source, project.id, side);
			},
			showDropBefore: !!isTarget && dropTarget.side === "before",
			showDropAfter: !!isTarget && dropTarget.side === "after",
			canMoveUp: index > 0,
			canMoveDown: index < members.length - 1,
			onMoveUp: () => {
				const target = members[index - 1];
				if (target) void reorderWithinSpace(spaceId, members, project.id, target.id, "before");
			},
			onMoveDown: () => {
				const target = members[index + 1];
				if (target) void reorderWithinSpace(spaceId, members, project.id, target.id, "after");
			},
		};
	}

	return (
		<>
			{groups.map((group) => {
				if (group.space === null) {
					if (group.projects.length === 0) return null;
					return (
						<div key="no-space" className={GROUP_CLASS} data-testid="space-group-rest">
							<div className="flex items-center gap-2">
								<span className="text-fg-3 text-xs font-semibold uppercase tracking-wider">
									{t("spaces.homeGroup")}
								</span>
								<span className="text-fg-muted text-xs tabular-nums">{group.projects.length}</span>
							</div>
							<div className={ROWS_CLASS}>
								{group.projects.map((project) => renderBottomBlockProject(project, group.projects))}
							</div>
						</div>
					);
				}

				const space = group.space;
				const isCollapsed = collapsed.has(space.id);
				const masked = isSpaceSensitive(space, sensitiveProjectIds);
				const needsYou = group.projects.reduce((sum, p) => sum + needsYouCountOf(p.id), 0);
				const working = group.projects.reduce((sum, p) => sum + workingCountOf(p.id), 0);

				return (
					<div key={space.id} className={`relative ${GROUP_CLASS}`} data-testid={`space-group-${space.id}`}>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => toggleCollapsed(space.id)}
								aria-expanded={!isCollapsed}
								className="flex items-center gap-2 min-w-0 text-left group"
								data-testid={`space-header-${space.id}`}
							>
								<svg
									aria-hidden="true"
									focusable="false"
									className={`w-3.5 h-3.5 text-fg-muted group-hover:text-fg-3 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
								<span className={`text-fg-2 text-sm font-semibold truncate ${masked ? MASK_CLASS : ""}`}>
									{space.name}
								</span>
								<span className={`text-fg-muted text-xs tabular-nums flex-shrink-0 ${masked ? MASK_CLASS : ""}`}>
									{t.plural("spaces.projectCount", group.projects.length)}
								</span>
								{/* Words, no colour marker: a dot needs a legend, and the
								    only legend was this same line saying it out loud. */}
								{needsYou > 0 && (
									<span className={`flex-shrink-0 text-xs text-fg-3 ${masked ? MASK_CLASS : ""}`}>
										{t("spaces.needYou", { count: String(needsYou) })}
									</span>
								)}
								{working > 0 && (
									<span className={`flex-shrink-0 text-xs text-fg-3 ${masked ? MASK_CLASS : ""}`}>
										{t("spaces.working", { count: String(working) })}
									</span>
								)}
							</button>
							{/* One control for the whole space, sitting against its name and
							    not pushed to the far right of a 1024px column (§9a.6 — group
							    with proximity). Membership lives inside it: a bare `+` could
							    only add, so removing a project was reachable nowhere near
							    the space it belonged to. */}
							{onRenameSpace && onDeleteSpace && (
								<SpaceHeaderMenu
									space={space}
									onRename={onRenameSpace}
									onDelete={onDeleteSpace}
									onEditProjects={onEditProjects}
									onMove={onMoveSpace && (spaceOrder?.length ?? 0) > 1 ? onMoveSpace : undefined}
									canMoveUp={(spaceOrder?.indexOf(space.id) ?? 0) > 0}
									canMoveDown={
										spaceOrder ? spaceOrder.indexOf(space.id) < spaceOrder.length - 1 : false
									}
								/>
							)}
						</div>
						{!isCollapsed && (
							<div className={ROWS_CLASS}>
								{group.projects.map((project, index) => (
									<div key={`${space.id}:${project.id}`}>
										{renderProject(project, rowCtx(space.id, group.projects, project, index), space.id)}
									</div>
								))}
							</div>
						)}
					</div>
				);
			})}
		</>
	);
}

export default SpaceGroupedProjects;
