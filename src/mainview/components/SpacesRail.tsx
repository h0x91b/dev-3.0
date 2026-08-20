import { useRef, useState, type DragEvent } from "react";
import type { Space } from "../../shared/types";
import { HOME_GROUP_ID } from "../utils/spaceGroups";
import { MASK_CLASS } from "../sensitive-projects";
import { useT } from "../i18n";

/** Tailwind `lg` — must match the rail's `hidden lg:flex` classes below. */
export const SPACES_RAIL_MIN_WIDTH = 1024;

export interface SpaceActivitySplit {
	needsYou: number;
	working: number;
}

interface SpacesRailProps {
	spaces: Space[];
	/** Resolvable member count per space id (dangling ids already skipped). */
	projectCountOf: (spaceId: string) => number;
	/** Needs-you / working task split per space id (same split as the group headers). */
	activityOf: (spaceId: string) => SpaceActivitySplit;
	/** The computed Home group's split (projects in no space). */
	homeActivity: SpaceActivitySplit;
	/** Spaces whose name must be masked (a member project is sensitive). */
	maskedSpaceIds: ReadonlySet<string>;
	totalProjects: number;
	homeCount: number;
	/** null = All projects. `HOME_GROUP_ID` = the computed Home group. */
	selectedSpaceId: string | null;
	onSelect: (id: string | null) => void;
	onNewSpace: () => void;
	/** Persist a new space order (drag within the rail). Same write as the
	 *  dashboard header grip — drag only ever reorders, never membership. */
	onReorder?: (order: string[]) => void;
}

/**
 * A row's needs-you / working indicator: an amber dot for tasks calling the
 * user, a blue dot for agents working — each rendered only when non-zero.
 * Masked rows blur the numbers along with the name (they leak how much work a
 * private client has in flight).
 */
function ActivityDots({ split, masked }: { split: SpaceActivitySplit; masked: boolean }) {
	const t = useT();
	return (
		<>
			{split.needsYou > 0 && (
				<span
					aria-label={t("spaces.needYou", { count: String(split.needsYou) })}
					className={`flex items-center gap-1 flex-shrink-0 text-xs tabular-nums text-fg-3 ${masked ? MASK_CLASS : ""}`}
				>
					<span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-awake" />
					{split.needsYou}
				</span>
			)}
			{split.working > 0 && (
				<span
					aria-label={t("spaces.working", { count: String(split.working) })}
					className={`flex items-center gap-1 flex-shrink-0 text-xs tabular-nums text-fg-3 ${masked ? MASK_CLASS : ""}`}
				>
					<span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-accent" />
					{split.working}
				</span>
			)}
		</>
	);
}

/** Nerd Font nf-md-drag_horizontal_variant — the app's grip glyph. */
const GRIP_GLYPH = "\u{F01DB}";

/**
 * Dashboard rail: All projects, then one row per space, then the computed Home
 * group. Selecting an entry FILTERS the dashboard — it never navigates, so a
 * space stays a grouping and never becomes a place with a board of its own.
 *
 * The rail is also the ONE surface that reorders spaces. Pointer users drag a
 * row; everyone else uses reorder mode, because HTML5 drag does not exist on
 * touch and has no keyboard equivalent. Per-row step buttons were measured and
 * rejected: 224px minus padding leaves 180px, and a grip plus two arrows eats
 * ~74px of it, which starves the name a row exists to show.
 */
function SpacesRail({
	spaces,
	projectCountOf,
	activityOf,
	homeActivity,
	maskedSpaceIds,
	totalProjects,
	homeCount,
	selectedSpaceId,
	onSelect,
	onNewSpace,
	onReorder,
}: SpacesRailProps) {
	const t = useT();
	// The id lives in a ref as well as state: `drop` must not depend on a render
	// having happened since `dragstart` (state is only for the drag styling).
	const draggedRef = useRef<string | null>(null);
	const [dragged, setDragged] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<{ spaceId: string; side: "before" | "after" } | null>(null);
	const [reordering, setReordering] = useState(false);

	// Nothing to reorder with one space — the affordances hide rather than sit inert.
	const canReorder = !!onReorder && spaces.length > 1;
	// Leaving reorder mode is not something the user has to remember to do: the
	// mode is meaningless once the rows it reorders are gone.
	if (reordering && !canReorder) setReordering(false);

	function rowClass(active: boolean): string {
		return `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
			active ? "bg-accent/15 text-fg" : "text-fg-2 hover:bg-elevated-hover hover:text-fg"
		}`;
	}

	function commitReorder(targetId: string, side: "before" | "after") {
		const source = draggedRef.current;
		if (!onReorder || !source || source === targetId) return;
		const order = spaces.map((s) => s.id).filter((id) => id !== source);
		const at = order.indexOf(targetId);
		if (at === -1) return;
		order.splice(side === "after" ? at + 1 : at, 0, source);
		onReorder(order);
	}

	/** Move one space by one position. The keyboard and touch path. */
	function step(spaceId: string, delta: -1 | 1) {
		if (!onReorder) return;
		const order = spaces.map((s) => s.id);
		const from = order.indexOf(spaceId);
		const to = from + delta;
		if (from === -1 || to < 0 || to >= order.length) return;
		[order[from], order[to]] = [order[to], order[from]];
		onReorder(order);
	}

	function dragHandlers(spaceId: string) {
		// A single space has no order to change; in reorder mode the step buttons
		// own the interaction, so dragging is off to keep one story per mode.
		if (!canReorder || reordering) return {};
		return {
			draggable: true,
			onDragStart: (event: DragEvent<HTMLButtonElement>) => {
				draggedRef.current = spaceId;
				setDragged(spaceId);
				event.dataTransfer.setData("text/plain", `space:${spaceId}`);
				event.dataTransfer.effectAllowed = "move";
			},
			onDragEnd: () => {
				draggedRef.current = null;
				setDragged(null);
				setDropTarget(null);
			},
			onDragOver: (event: DragEvent<HTMLButtonElement>) => {
				if (!draggedRef.current || draggedRef.current === spaceId) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				const rect = event.currentTarget.getBoundingClientRect();
				setDropTarget({
					spaceId,
					side: event.clientY > rect.top + rect.height / 2 ? "after" : "before",
				});
			},
			onDragLeave: () => {
				setDropTarget((cur) => (cur?.spaceId === spaceId ? null : cur));
			},
			onDrop: (event: DragEvent<HTMLButtonElement>) => {
				event.preventDefault();
				// Read the side off the drop itself: the dragover state may not have
				// flushed yet, and the pointer is the only source of truth anyway.
				const rect = event.currentTarget.getBoundingClientRect();
				commitReorder(spaceId, event.clientY > rect.top + rect.height / 2 ? "after" : "before");
				draggedRef.current = null;
				setDragged(null);
				setDropTarget(null);
			},
		};
	}

	return (
		<aside
			className="hidden lg:flex w-56 flex-shrink-0 flex-col border-r border-edge overflow-y-auto py-4 px-3 gap-4"
			aria-label={t("spaces.railLabel")}
			data-testid="spaces-rail"
		>
			<div className="flex flex-col gap-1">
				<span className="px-2.5 text-fg-muted text-nano font-semibold uppercase tracking-[0.08em]">
					{t("spaces.railOverview")}
				</span>
				<button
					type="button"
					onClick={() => onSelect(null)}
					aria-pressed={selectedSpaceId === null}
					className={rowClass(selectedSpaceId === null)}
					data-testid="rail-all-projects"
				>
					<span className="flex-1 text-sm truncate">{t("spaces.railAllProjects")}</span>
					<span className="text-fg-muted text-xs tabular-nums">{totalProjects}</span>
				</button>
			</div>

			<div className="flex flex-col gap-1">
				<div className="flex items-center gap-1 px-2.5">
					<span className="flex-1 text-fg-muted text-nano font-semibold uppercase tracking-[0.08em]">
						{t("spaces.railSpaces")}
					</span>
					{/* Deliberately NOT the section label's uppercase nano: beside
					    `SPACES` that made two words read as a pair of column headings
					    instead of a label and a control (§9a.6 — a control must look
					    interactive next to static text). */}
					{canReorder && (
						<button
							type="button"
							onClick={() => setReordering((on) => !on)}
							aria-pressed={reordering}
							className={`text-xs rounded px-1.5 py-0.5 transition-colors ${
								reordering
									? "text-accent bg-accent/15"
									: "text-fg-3 hover:text-fg hover:bg-elevated-hover"
							}`}
							data-testid="rail-reorder-toggle"
						>
							{reordering ? t("spaces.reorderDone") : t("spaces.reorderStart")}
						</button>
					)}
				</div>
				{spaces.map((space, index) => {
					const active = selectedSpaceId === space.id;
					const isTarget = dropTarget?.spaceId === space.id;
					const masked = maskedSpaceIds.has(space.id);

					// Reorder mode: the row stops being a filter and becomes a thing
					// being moved. The activity dots and the project count go away —
					// they say nothing about position, and their width is what the step
					// buttons need.
					if (reordering) {
						return (
							<div
								key={space.id}
								className="w-full flex items-center gap-1 px-2.5 py-1 rounded-lg text-fg-2"
								data-testid={`rail-space-${space.id}`}
							>
								<span aria-hidden="true" className="text-fg-muted text-sm leading-none flex-shrink-0" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
									{GRIP_GLYPH}
								</span>
								<span className={`flex-1 min-w-0 text-sm truncate ${masked ? MASK_CLASS : ""}`}>
									{space.name}
								</span>
								<button
									type="button"
									onClick={() => step(space.id, -1)}
									disabled={index === 0}
									aria-label={t("spaces.moveUp", { name: space.name })}
									title={t("dashboard.moveProjectUp")}
									className="flex h-8 w-8 items-center justify-center rounded text-fg-3 hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40 disabled:hover:text-fg-3 disabled:hover:bg-transparent"
									data-testid={`rail-space-up-${space.id}`}
								>
									<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
								</button>
								<button
									type="button"
									onClick={() => step(space.id, 1)}
									disabled={index === spaces.length - 1}
									aria-label={t("spaces.moveDown", { name: space.name })}
									title={t("dashboard.moveProjectDown")}
									className="flex h-8 w-8 items-center justify-center rounded text-fg-3 hover:text-fg hover:bg-elevated transition-colors disabled:opacity-40 disabled:hover:text-fg-3 disabled:hover:bg-transparent"
									data-testid={`rail-space-down-${space.id}`}
								>
									<span aria-hidden="true" className="text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>{""}</span>
								</button>
							</div>
						);
					}

					return (
						<button
							key={space.id}
							type="button"
							onClick={() => onSelect(space.id)}
							aria-pressed={active}
							className={`relative ${rowClass(active)} ${dragged === space.id ? "opacity-50" : ""} ${
								canReorder ? "cursor-grab active:cursor-grabbing" : ""
							}`}
							data-testid={`rail-space-${space.id}`}
							{...dragHandlers(space.id)}
						>
							{isTarget && (
								<span
									aria-hidden="true"
									className={`absolute left-1 right-1 h-0.5 bg-accent rounded-full ${
										dropTarget.side === "before" ? "top-0" : "bottom-0"
									}`}
								/>
							)}
							{/* Resting grip: without it, only the cursor says the row drags,
							    and only after the pointer is already on it. */}
							{canReorder && (
								<span
									aria-hidden="true"
									className="text-fg-muted text-sm leading-none flex-shrink-0 -ml-1"
									style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
									title={t("spaces.reorderSpace")}
								>
									{GRIP_GLYPH}
								</span>
							)}
							<span className={`flex-1 text-sm truncate ${masked ? MASK_CLASS : ""}`}>
								{space.name}
							</span>
							<ActivityDots split={activityOf(space.id)} masked={masked} />
							{/* The count leaks how much work a private client has in flight, so
							    it is masked with the name, not left readable beside it. */}
							<span className={`text-fg-muted text-xs tabular-nums ${masked ? MASK_CLASS : ""}`}>
								{projectCountOf(space.id)}
							</span>
						</button>
					);
				})}
				{!reordering && homeCount > 0 && (
					<button
						type="button"
						onClick={() => onSelect(HOME_GROUP_ID)}
						aria-pressed={selectedSpaceId === HOME_GROUP_ID}
						className={rowClass(selectedSpaceId === HOME_GROUP_ID)}
						data-testid="rail-home"
					>
						{/* Home is computed, so it has no grip — but it still needs the
						    grip's width, or its name hangs left of every space above it. */}
						{canReorder && <span aria-hidden="true" className="w-[0.875rem] flex-shrink-0 -ml-1" />}
						<span className="flex-1 text-sm truncate">{t("spaces.homeGroup")}</span>
						<ActivityDots split={homeActivity} masked={false} />
						<span className="text-fg-muted text-xs tabular-nums">{homeCount}</span>
					</button>
				)}
			</div>

			<button
				type="button"
				onClick={onNewSpace}
				className="mt-auto flex items-center gap-2 px-2.5 py-2 rounded-lg text-fg-3 hover:text-fg hover:bg-elevated-hover transition-colors"
				data-testid="rail-new-space"
			>
				<svg aria-hidden="true" focusable="false" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
					<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
				</svg>
				<span className="text-sm">{t("spaces.newSpace")}</span>
			</button>
		</aside>
	);
}

export default SpacesRail;
