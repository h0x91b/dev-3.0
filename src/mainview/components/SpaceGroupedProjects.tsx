import { Fragment, useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { isSpaceSensitive, type Project, type Space } from "../../shared/types";
import { HOME_GROUP_ID, type DashboardGroup } from "../utils/spaceGroups";
import { digitBadgeById, mixedEntryId, type MixedEntry } from "../utils/digitOrder";
import { MASK_CLASS } from "../sensitive-projects";
import { api } from "../rpc";
import { toast } from "../toast";
import { useT } from "../i18n";
import SpaceHeaderMenu from "./SpaceHeaderMenu";
import SpaceIcon from "./SpaceIcon";
import type { ReorderScope, useReorderDrag } from "../hooks/useReorderDrag";

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
	dragEnabled: boolean;
	/** The rows a drag from this row moves among — this space's members only. */
	scope: ReorderScope;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
	/** ⌘N digit this row answers to (mixed order only), shown beside its name. */
	digitHint?: string;
}

/** Scope key of the mixed top-level list: spaces and standalone projects together. */
export const MIXED_SCOPE_KEY = "mixed";

/** The ⌘N badge — same markup as the header switcher's. */
export function DigitHint({ digit }: { digit: string }) {
	return (
		<kbd className="flex-shrink-0 inline-flex items-center gap-0.5 text-dense text-fg-muted/60 font-mono">
			<span className="text-micro">⌘</span>{digit}
		</kbd>
	);
}

/** One top-level list in the user's order: spaces and standalone projects interleaved. */
export interface MixedOrderConfig {
	/** In display order, any optimistic reorder already applied. */
	entries: MixedEntry[];
	onReorder: (sourceId: string, targetId: string, side: "before" | "after") => void;
	onStep: (id: string, delta: -1 | 1) => void;
	drag: Pick<ReturnType<typeof useReorderDrag>, "active" | "begin" | "rowRef">;
	/** ⌘1–9 hints are desktop-only: the browser keeps those keys in remote mode. */
	showDigitHints: boolean;
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
	/** Opens the space's unified board. A visible control of its own, never a
	 *  menu item: the board was reachable only from inside a member project. */
	onOpenSpaceBoard?: (space: Space) => void;
	onRenameSpace?: (space: Space, name: string) => void;
	onDeleteSpace?: (space: Space) => void;
	/** Step this space one position in the app-wide space order. */
	onMoveSpace?: (space: Space, delta: -1 | 1) => void;
	/** Toggles the space's own hide-on-camera flag. */
	onToggleSensitive?: (space: Space, sensitive: boolean) => void;
	/** Every space id in order — the visible groups are a filtered subset, so the
	 *  edges of `Move up` / `Move down` cannot be read off `groups`. */
	spaceOrder?: string[];
	/** The rail/sheet's current filter. Picking a specific space is a request to
	 *  see it, so a stale collapse from a previous session must not hide the very
	 *  group the user just asked for. */
	selectedSpaceId?: string | null;
	/** Mixed top-level order: replaces the per-group list with one reorderable one. */
	mixed?: MixedOrderConfig;
}

/** The pieces of one space block that only exist in the mixed top-level list. */
interface SpaceGroupMixed {
	dragEnabled: boolean;
	onGripPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	hint?: string;
	outerRef: (el: HTMLElement | null) => void;
	isDragged: boolean;
	/** Any block of the mixed list is being dragged: the list is one-line entries, evenly spaced. */
	dragActive: boolean;
}

interface SpaceGroupProps {
	space: Space;
	projectCount: number;
	isCollapsed: boolean;
	masked: boolean;
	needsYou: number;
	working: number;
	onToggleCollapsed: () => void;
	onEditProjects?: (space: Space) => void;
	onOpenSpaceBoard?: (space: Space) => void;
	onRenameSpace?: (space: Space, name: string) => void;
	onDeleteSpace?: (space: Space) => void;
	onToggleSensitive?: (space: Space, sensitive: boolean) => void;
	/** Undefined hides `Move up` / `Move down`. */
	onMove?: (space: Space, delta: -1 | 1) => void;
	canMoveUp: boolean;
	canMoveDown: boolean;
	renderRows: () => ReactNode;
	mixed?: SpaceGroupMixed;
}

/** One space block: header (collapse, open board, menu) and its indented member rows. */
function SpaceGroup({
	space,
	projectCount,
	isCollapsed,
	masked,
	needsYou,
	working,
	onToggleCollapsed,
	onEditProjects,
	onOpenSpaceBoard,
	onRenameSpace,
	onDeleteSpace,
	onToggleSensitive,
	onMove,
	canMoveUp,
	canMoveDown,
	renderRows,
	mixed,
}: SpaceGroupProps) {
	const t = useT();
	const block = (
		<div
			ref={mixed?.outerRef}
			className={
				mixed
					// The registered element is a surface of its own, so the drag preview
					// is opaque and the placeholder has an edge to dash.
					? `relative space-y-2 rounded-xl ${mixed.isDragged ? "border border-edge bg-raised px-3 py-2" : ""}`
					: `relative ${GROUP_CLASS}`
			}
			data-testid={`space-group-${space.id}`}
			data-reorder-placeholder={mixed?.isDragged || undefined}
		>
			<div className="flex items-center gap-2">
				{mixed?.dragEnabled && (
					<div className="hidden md:flex -ml-1.5 items-center select-none">
						{/* Pointer-only, like the project row's grip: the header menu's
						    Move up / Move down is the keyboard path. */}
						<span
							role="presentation"
							onPointerDown={mixed.onGripPointerDown}
							data-reorder-grip
							className="p-1.5 rounded-lg text-fg-3 transition-colors touch-none cursor-grab active:cursor-grabbing hover:text-fg hover:bg-elevated"
							title={t("spaces.dragSpace")}
						>
							<span
								aria-hidden="true"
								className="text-base leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{"\u{F01DB}"}
							</span>
						</span>
					</div>
				)}
				<button
					type="button"
					onClick={onToggleCollapsed}
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
					<SpaceIcon className="w-4 h-4 flex-shrink-0 text-fg-muted group-hover:text-fg-3" />
					<span className={`text-fg-2 text-sm font-semibold truncate ${masked ? MASK_CLASS : ""}`}>
						{space.name}
					</span>
					<span className={`text-fg-muted text-xs tabular-nums flex-shrink-0 ${masked ? MASK_CLASS : ""}`}>
						{t.plural("spaces.projectCount", projectCount)}
					</span>
					{mixed?.hint && <DigitHint digit={mixed.hint} />}
					{/* Words, no colour marker: a dot needs a legend, and the
					    only legend was this same line saying it out loud. */}
					{needsYou > 0 && (
						<span className={`flex-shrink-0 text-xs text-fg-3 ${masked ? MASK_CLASS : ""}`}>
							{t.plural("spaces.needYou", needsYou)}
						</span>
					)}
					{working > 0 && (
						<span className={`flex-shrink-0 text-xs text-fg-3 ${masked ? MASK_CLASS : ""}`}>
							{t.plural("spaces.working", working)}
						</span>
					)}
				</button>
				{/* Named and visible, not folded into the menu next to it: opening the
				    space's board is the group's primary action, and a menu would make
				    the board reachable only to someone who already knows it exists. */}
				{onOpenSpaceBoard && projectCount > 0 && (
					<button
						type="button"
						onClick={() => onOpenSpaceBoard(space)}
						className="flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge bg-raised px-2 py-1 text-xs font-medium text-fg-2 transition-colors hover:border-edge-active hover:bg-raised-hover hover:text-accent motion-safe:active:scale-[0.96]"
						data-testid={`space-open-board-${space.id}`}
					>
						<svg aria-hidden="true" focusable="false" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7m0 0H9m8 0v8" />
						</svg>
						{t("spaces.openBoard")}
					</button>
				)}
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
						onToggleSensitive={onToggleSensitive}
						touchTarget
						onMove={onMove}
						canMoveUp={canMoveUp}
						canMoveDown={canMoveDown}
					/>
				)}
			</div>
			{!isCollapsed && <div className={ROWS_CLASS}>{renderRows()}</div>}
		</div>
	);
	// The gap above a block sits outside the registered element and goes while a
	// drag is on, so every entry is spaced alike and the slots line up.
	return mixed ? <div className={mixed.dragActive ? "" : "pt-6"}>{block}</div> : block;
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
	onOpenSpaceBoard,
	onRenameSpace,
	onDeleteSpace,
	onMoveSpace,
	onToggleSensitive,
	spaceOrder,
	selectedSpaceId,
	mixed,
}: SpaceGroupedProjectsProps) {
	const t = useT();
	const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
	// A reorder shows at once; the spaces push that confirms it lands later.
	const [pendingOrder, setPendingOrder] = useState<ReadonlyMap<string, string[]>>(new Map());

	useEffect(() => {
		setPendingOrder((prev) => {
			if (prev.size === 0) return prev;
			const next = new Map(prev);
			for (const [spaceId, ids] of prev) {
				const space = groups.find((g) => g.space?.id === spaceId)?.space;
				const wanted = new Set(ids);
				const stored = space?.projectIds.filter((id) => wanted.has(id)) ?? [];
				if (!space || stored.join("\0") === ids.join("\0")) next.delete(spaceId);
			}
			return next.size === prev.size ? prev : next;
		});
	}, [groups]);

	// Deliberately keyed on `selectedSpaceId` alone: a manual re-collapse while
	// this space is still selected must stick, not get undone by this effect
	// reacting to its own `collapsed` write.
	useEffect(() => {
		if (!selectedSpaceId || selectedSpaceId === HOME_GROUP_ID) return;
		setCollapsed((prev) => {
			if (!prev.has(selectedSpaceId)) return prev;
			const next = new Set(prev);
			next.delete(selectedSpaceId);
			writeCollapsed(next);
			return next;
		});
	}, [selectedSpaceId]);

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
		setPendingOrder((prev) => new Map(prev).set(spaceId, ids));
		try {
			await api.request.reorderSpaceProjects({ spaceId, projectIds: ids });
		} catch (err) {
			setPendingOrder((prev) => {
				const next = new Map(prev);
				next.delete(spaceId);
				return next;
			});
			toast.error(t("spaces.failedUpdate", { error: String(err) }));
		}
	}

	function withPendingOrder(spaceId: string, members: Project[]): Project[] {
		const ids = pendingOrder.get(spaceId);
		if (!ids) return members;
		const rank = new Map(ids.map((id, i) => [id, i]));
		return [...members].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
	}

	function rowCtx(spaceId: string, members: Project[], project: Project, index: number): RowReorderCtx {
		const canReorder = members.length > 1;
		return {
			showReorder: canReorder,
			dragEnabled: canReorder,
			scope: {
				key: `space:${spaceId}`,
				ids: members.map((p) => p.id),
				commit: (sourceId, targetId, side) => void reorderWithinSpace(spaceId, members, sourceId, targetId, side),
			},
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

	function renderSpaceGroup(group: DashboardGroup & { space: Space }, extra: { mixed?: SpaceGroupMixed; collapsedNow?: boolean; move?: { onMove?: (space: Space, delta: -1 | 1) => void; canMoveUp: boolean; canMoveDown: boolean } }) {
		const space = group.space;
		const move = extra.move ?? {
			onMove: onMoveSpace && (spaceOrder?.length ?? 0) > 1 ? onMoveSpace : undefined,
			canMoveUp: (spaceOrder?.indexOf(space.id) ?? 0) > 0,
			canMoveDown: spaceOrder ? spaceOrder.indexOf(space.id) < spaceOrder.length - 1 : false,
		};
		return (
			<SpaceGroup
				key={space.id}
				space={space}
				projectCount={group.projects.length}
				isCollapsed={extra.collapsedNow ?? collapsed.has(space.id)}
				masked={isSpaceSensitive(space, sensitiveProjectIds)}
				needsYou={group.projects.reduce((sum, p) => sum + needsYouCountOf(p.id), 0)}
				working={group.projects.reduce((sum, p) => sum + workingCountOf(p.id), 0)}
				onToggleCollapsed={() => toggleCollapsed(space.id)}
				onEditProjects={onEditProjects}
				onOpenSpaceBoard={onOpenSpaceBoard}
				onRenameSpace={onRenameSpace}
				onDeleteSpace={onDeleteSpace}
				onToggleSensitive={onToggleSensitive}
				onMove={move.onMove}
				canMoveUp={move.canMoveUp}
				canMoveDown={move.canMoveDown}
				mixed={extra.mixed}
				renderRows={() =>
					withPendingOrder(space.id, group.projects).map((project, index, members) => (
						<div key={`${space.id}:${project.id}`}>
							{renderProject(project, rowCtx(space.id, members, project, index), space.id)}
						</div>
					))
				}
			/>
		);
	}

	if (mixed) {
		const { drag } = mixed;
		const displayedMixed = mixed.entries;
		const ids = displayedMixed.map(mixedEntryId);
		const dragActive = drag.active?.scope === MIXED_SCOPE_KEY;
		const badges = mixed.showDigitHints ? digitBadgeById(displayedMixed.slice(0, 9)) : {};
		const scope: ReorderScope = {
			key: MIXED_SCOPE_KEY,
			ids,
			commit: mixed.onReorder,
		};
		return (
			<>
				{displayedMixed.map((entry, index) => {
					const id = mixedEntryId(entry);
					const canDrag = ids.length > 1;
					if (entry.kind === "project") {
						const ctx: RowReorderCtx = {
							showReorder: true,
							dragEnabled: canDrag,
							scope,
							canMoveUp: index > 0,
							canMoveDown: index < ids.length - 1,
							onMoveUp: () => mixed.onStep(id, -1),
							onMoveDown: () => mixed.onStep(id, 1),
							digitHint: badges[id],
						};
						return <Fragment key={`mixed:${id}`}>{renderProject(entry.project, ctx, null)}</Fragment>;
					}
					return renderSpaceGroup(
						{ space: entry.space, projects: entry.projects },
						{
							// Every block shrinks to its header for the length of a drag, so the
							// whole list fits the screen and any slot is one pointer-move away.
							collapsedNow: dragActive || collapsed.has(entry.space.id),
							move: {
								onMove: ids.length > 1 ? (space, delta) => mixed.onStep(space.id, delta) : undefined,
								canMoveUp: index > 0,
								canMoveDown: index < ids.length - 1,
							},
							mixed: {
								dragEnabled: canDrag,
								onGripPointerDown: (event) => drag.begin(event, scope, id),
								hint: badges[id],
								outerRef: drag.rowRef(MIXED_SCOPE_KEY, id),
								isDragged: dragActive && drag.active?.id === id,
								dragActive,
							},
						},
					);
				})}
			</>
		);
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
								{group.projects.map((project) => (
									// The caller's node carries no key of its own.
									<Fragment key={`no-space:${project.id}`}>
										{renderBottomBlockProject(project, group.projects)}
									</Fragment>
								))}
							</div>
						</div>
					);
				}
				return renderSpaceGroup({ ...group, space: group.space }, {});
			})}
		</>
	);
}

export default SpaceGroupedProjects;
