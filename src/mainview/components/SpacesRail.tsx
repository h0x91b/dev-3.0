import { useRef, useState, type DragEvent } from "react";
import type { Space } from "../../shared/types";
import HelpSpot from "./HelpSpot";
import SpaceHeaderMenu, { SPACE_MENU_GLYPH } from "./SpaceHeaderMenu";
import { HOME_GROUP_ID } from "../utils/spaceGroups";
import { MASK_CLASS } from "../sensitive-projects";
import { useT } from "../i18n";

/**
 * Below this the rail is not rendered at all. Measured on the dashboard's own
 * container, not the viewport: the panel does not own the window (app chrome in
 * the desktop shell, a browser tab in remote mode), so the window's width is
 * not the width the rail has to fit into.
 */
export const SPACES_RAIL_MIN_WIDTH = 1024;

interface SpacesRailProps {
	spaces: Space[];
	/** Resolvable member count per space id (dangling ids already skipped). */
	projectCountOf: (spaceId: string) => number;
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
	/** The space's own actions, so the rail is the complete spaces surface and
	 *  not a filter that sends you to the centre column to rename anything. */
	onRenameSpace?: (space: Space, name: string) => void;
	onDeleteSpace?: (space: Space) => void;
	onMoveSpace?: (space: Space, delta: -1 | 1) => void;
	onEditProjects?: (space: Space) => void;
	onToggleSensitive?: (space: Space, sensitive: boolean) => void;
}

/*
 * No activity dots here. A row carried an amber and a blue number whose only
 * legend lived in the centre column's group headers, and four numbers on a
 * 180px row read as one clump — the name is what the row exists to show.
 */

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
	maskedSpaceIds,
	totalProjects,
	homeCount,
	selectedSpaceId,
	onSelect,
	onNewSpace,
	onReorder,
	onRenameSpace,
	onDeleteSpace,
	onMoveSpace,
	onEditProjects,
	onToggleSensitive,
}: SpacesRailProps) {
	const t = useT();
	// The id lives in a ref as well as state: `drop` must not depend on a render
	// having happened since `dragstart` (state is only for the drag styling).
	const draggedRef = useRef<string | null>(null);
	const [dragged, setDragged] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<{ spaceId: string; side: "before" | "after" } | null>(null);

	// Nothing to reorder with one space — the grip hides rather than sits inert.
	const canReorder = !!onReorder && spaces.length > 1;
	// Rename and delete come as a pair: half a menu is not a menu.
	const hasSpaceMenu = !!onRenameSpace && !!onDeleteSpace;

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
			onDragStart: (event: DragEvent<HTMLDivElement>) => {
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
			onDragOver: (event: DragEvent<HTMLDivElement>) => {
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
			onDrop: (event: DragEvent<HTMLDivElement>) => {
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
			className="flex w-56 flex-shrink-0 flex-col border-r border-edge overflow-y-auto py-4 px-3 gap-4"
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
					{/* No menu on a computed row, but the counts above it must stay in
					    one column: an invisible copy of the menu's own glyph is that
					    width by construction. */}
					{hasSpaceMenu && (
						<span
							aria-hidden="true"
							className="flex-shrink-0 -mr-1 p-1 invisible text-base leading-none"
							style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
						>
							{SPACE_MENU_GLYPH}
						</span>
					)}
				</button>
			</div>

			{/* The whole section is the help zone, not just the icon: what needs
			    explaining is what a space IS, and nothing on this screen said it. */}
			<div className="flex flex-col gap-1" data-help-id="dashboard.spaces">
				<span className="px-2.5 flex items-center gap-1.5 text-fg-muted text-nano font-semibold uppercase tracking-[0.08em]">
					{t("spaces.railSpaces")}
					<HelpSpot topicId="dashboard.spaces" />
				</span>
				{spaces.map((space, index) => {
					const active = selectedSpaceId === space.id;
					const isTarget = dropTarget?.spaceId === space.id;
					const masked = maskedSpaceIds.has(space.id);

					return (
						<div
							key={space.id}
							className={`group relative ${rowClass(active)} ${dragged === space.id ? "opacity-50" : ""} ${
								canReorder ? "cursor-grab active:cursor-grabbing" : ""
							}`}
							data-testid={`rail-space-row-${space.id}`}
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
							<button
								type="button"
								onClick={() => onSelect(space.id)}
								aria-pressed={active}
								className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
								data-testid={`rail-space-${space.id}`}
							>
								<span className={`flex-1 text-sm truncate ${masked ? MASK_CLASS : ""}`}>
									{space.name}
								</span>
								{/* The count leaks how much work a private client has in flight, so
								    it is masked with the name, not left readable beside it. */}
								<span className={`text-fg-muted text-xs tabular-nums ${masked ? MASK_CLASS : ""}`}>
									{projectCountOf(space.id)}
								</span>
							</button>
							{/* The menu keeps its width at rest — revealing it on hover would
							    shift every number in the rail the moment the pointer lands.
							    Only its ink waits for hover, focus, or selection. */}
							{onRenameSpace && onDeleteSpace && (
								<span
									className={`flex-shrink-0 -mr-1 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
										active ? "opacity-100" : "opacity-0"
									}`}
								>
									<SpaceHeaderMenu
										space={space}
										scope="rail-space"
										onRename={onRenameSpace}
										onDelete={onDeleteSpace}
										onEditProjects={onEditProjects}
										onToggleSensitive={onToggleSensitive}
										onMove={onMoveSpace && spaces.length > 1 ? onMoveSpace : undefined}
										canMoveUp={index > 0}
										canMoveDown={index < spaces.length - 1}
									/>
								</span>
							)}
						</div>
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
						<span className="text-fg-muted text-xs tabular-nums">{homeCount}</span>
						{/* No menu on a computed row, but the counts above it must stay
						    in one column: an invisible copy of the menu's own glyph is
						    that width by construction. */}
						{hasSpaceMenu && (
							<span
								aria-hidden="true"
								className="flex-shrink-0 -mr-1 p-1 invisible text-base leading-none"
								style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
							>
								{SPACE_MENU_GLYPH}
							</span>
						)}
					</button>
				)}
				{/* Ends the section it appends to, one row-gap below the last row.
				    Pinned to the bottom of the rail (`mt-auto`) it read as unrelated
				    chrome, and past ~8 spaces it scrolled out of reach entirely.
				    Drawn as the app's bordered secondary — the same shape the
				    dashboard header uses for this very action — because a row of
				    tinted text among rows of tinted text is a list item, not a
				    control. The border is what separates it from the filters above
				    it, so it does not take the rows' `rounded-lg`. */}
				<button
					type="button"
					onClick={onNewSpace}
					className="mt-1 w-full flex items-center justify-center gap-1.5 px-2.5 py-2 border border-edge rounded-xl text-fg-2 text-sm hover:text-fg hover:border-edge-active hover:bg-elevated-hover transition-[color,border-color,background-color,transform] active:scale-[0.96]"
					data-testid="rail-new-space"
				>
					<svg aria-hidden="true" focusable="false" className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
					</svg>
					{t("spaces.newSpace")}
				</button>
			</div>
		</aside>
	);
}

export default SpacesRail;
