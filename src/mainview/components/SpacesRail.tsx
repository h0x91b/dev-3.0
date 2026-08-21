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
 * Reordering here is drag only, by the resting grip. The keyboard and touch
 * path is `Move up` / `Move down` in the space header's own menu — a rail-local
 * reorder mode duplicated one gesture into a second visible control, and the
 * rail is 224px wide, which is the wrong place to spend width twice.
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

	// Nothing to reorder with one space — the grip hides rather than sits inert.
	const canReorder = !!onReorder && spaces.length > 1;

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

	function dragHandlers(spaceId: string) {
		// A single space has no order to change.
		if (!canReorder) return {};
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
				<span className="px-2.5 text-fg-muted text-nano font-semibold uppercase tracking-[0.08em]">
					{t("spaces.railSpaces")}
				</span>
				{spaces.map((space) => {
					const active = selectedSpaceId === space.id;
					const isTarget = dropTarget?.spaceId === space.id;
					const masked = maskedSpaceIds.has(space.id);

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
				{homeCount > 0 && (
					<button
						type="button"
						onClick={() => onSelect(HOME_GROUP_ID)}
						aria-pressed={selectedSpaceId === HOME_GROUP_ID}
						className={rowClass(selectedSpaceId === HOME_GROUP_ID)}
						data-testid="rail-home"
					>
						{/* Home is computed, so it has no grip — but it still needs the
						    grip's width, or its name hangs left of every space above it.
						    An invisible copy of the glyph is that width by construction;
						    a hand-written 14px was 5.6px too wide against the real font. */}
						{canReorder && (
							<span aria-hidden="true" className="invisible text-sm leading-none flex-shrink-0 -ml-1" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
								{GRIP_GLYPH}
							</span>
						)}
						<span className="flex-1 text-sm truncate">{t("spaces.homeGroup")}</span>
						<ActivityDots split={homeActivity} masked={false} />
						<span className="text-fg-muted text-xs tabular-nums">{homeCount}</span>
					</button>
				)}
				{/* Ends the section it appends to, one row-gap below the last row.
				    Pinned to the bottom of the rail (`mt-auto`) it read as unrelated
				    chrome, and past ~8 spaces it scrolled out of reach entirely. */}
				<button
					type="button"
					onClick={onNewSpace}
					className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-fg-3 hover:text-fg hover:bg-elevated-hover transition-colors"
					data-testid="rail-new-space"
				>
					{/* The plus sits in the grip's column — an invisible glyph donates
					    exactly its width, so the label starts where the space names do
					    and the icon is free to be a little wider than its slot. */}
					<span aria-hidden="true" className="relative flex-shrink-0 -ml-1 text-sm leading-none" style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}>
						<span className="invisible">{GRIP_GLYPH}</span>
						<svg focusable="false" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
						</svg>
					</span>
					<span className="text-sm">{t("spaces.newSpace")}</span>
				</button>
			</div>
		</aside>
	);
}

export default SpacesRail;
