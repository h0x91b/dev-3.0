import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import {
	getSplitBoundaries,
	MAX_SPLIT_RATIO,
	MIN_SPLIT_RATIO,
	type SplitBoundary,
	type SplitTree,
} from "../../shared/split-tree";

/** Pointer target thickness. The visible grip is thinner; this is what the hand hits. */
const HIT_PX = 9;
/** A terminal narrower than this is useless, so no drag may produce one. */
const MIN_PANE_PX = 48;
const KEY_STEP = 0.02;
const KEY_STEP_COARSE = 0.1;

interface DragSession {
	pointerId: number;
	splitId: string;
	orientation: SplitBoundary["orientation"];
	startRatio: number;
	startCoord: number;
	branchPx: number;
	lastRatio: number;
	target: HTMLElement;
	previousCursor: string;
	previousUserSelect: string;
	rafId: number | null;
}

interface NativePaneDividersProps {
	tree: SplitTree;
	/** Display index (1-based) per pane id, for accessible names. */
	paneIndexById: Map<string, number>;
	/** Commit an absolute ratio for one boundary. Fires once, on release. */
	onCommitRatio: (splitId: string, ratio: number) => void;
}

/**
 * Draggable boundaries between native SplitTree panes: one `separator` per split.
 *
 * Only a ghost line follows the pointer. Committing every intermediate ratio would
 * resize every pane's PTY on every pointer move (SIGWINCH → full TUI repaint), so
 * the real ratio lands once, on release — same contract as the artifact divider.
 */
export default function NativePaneDividers({ tree, paneIndexById, onCommitRatio }: NativePaneDividersProps) {
	const t = useT();
	const layerRef = useRef<HTMLDivElement | null>(null);
	const sessionRef = useRef<DragSession | null>(null);
	const ghostRef = useRef<HTMLDivElement | null>(null);
	const [dragging, setDragging] = useState<{ splitId: string; orientation: SplitBoundary["orientation"] } | null>(null);

	const boundaries = getSplitBoundaries(tree);

	const clampRatio = useCallback((ratio: number, branchPx: number) => {
		const bounded = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
		if (branchPx <= MIN_PANE_PX * 2) return bounded;
		const floor = Math.max(MIN_SPLIT_RATIO, MIN_PANE_PX / branchPx);
		const ceiling = Math.min(MAX_SPLIT_RATIO, 1 - MIN_PANE_PX / branchPx);
		return Math.min(ceiling, Math.max(floor, bounded));
	}, []);

	const branchPixels = useCallback((boundary: SplitBoundary) => {
		const box = layerRef.current?.getBoundingClientRect();
		if (!box) return 0;
		return boundary.orientation === "horizontal" ? box.width * boundary.rect.width : box.height * boundary.rect.height;
	}, []);

	const endDrag = useCallback((commit: boolean, releaseCapture: boolean) => {
		const session = sessionRef.current;
		if (!session) return;
		sessionRef.current = null;
		if (session.rafId !== null) cancelAnimationFrame(session.rafId);
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
		if (releaseCapture && session.target.hasPointerCapture(session.pointerId)) {
			session.target.releasePointerCapture(session.pointerId);
		}
		setDragging(null);
		if (commit && session.lastRatio !== session.startRatio) {
			onCommitRatio(session.splitId, session.lastRatio);
		}
	}, [onCommitRatio]);

	const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, boundary: SplitBoundary) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const horizontal = boundary.orientation === "horizontal";
		event.currentTarget.setPointerCapture(event.pointerId);
		sessionRef.current = {
			pointerId: event.pointerId,
			splitId: boundary.splitId,
			orientation: boundary.orientation,
			startRatio: boundary.ratio,
			startCoord: horizontal ? event.clientX : event.clientY,
			branchPx: branchPixels(boundary),
			lastRatio: boundary.ratio,
			target: event.currentTarget,
			previousCursor: document.body.style.cursor,
			previousUserSelect: document.body.style.userSelect,
			rafId: null,
		};
		document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
		document.body.style.userSelect = "none";
		setDragging({ splitId: boundary.splitId, orientation: boundary.orientation });
	}, [branchPixels]);

	const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>, boundary: SplitBoundary) => {
		const session = sessionRef.current;
		if (!session || session.pointerId !== event.pointerId || !session.branchPx) return;
		const horizontal = session.orientation === "horizontal";
		const moved = (horizontal ? event.clientX : event.clientY) - session.startCoord;
		session.lastRatio = clampRatio(session.startRatio + moved / session.branchPx, session.branchPx);
		if (session.rafId !== null) return;
		session.rafId = requestAnimationFrame(() => {
			session.rafId = null;
			const ghost = ghostRef.current;
			if (!ghost) return;
			const offset = horizontal
				? boundary.rect.x + boundary.rect.width * session.lastRatio
				: boundary.rect.y + boundary.rect.height * session.lastRatio;
			if (horizontal) ghost.style.left = `${offset * 100}%`;
			else ghost.style.top = `${offset * 100}%`;
		});
	}, [clampRatio]);

	const nudge = useCallback((boundary: SplitBoundary, delta: number) => {
		onCommitRatio(boundary.splitId, clampRatio(boundary.ratio + delta, branchPixels(boundary)));
	}, [branchPixels, clampRatio, onCommitRatio]);

	// A drag that leaves the window, gets cancelled by the OS, or is escaped must not
	// silently commit wherever the pointer happened to be.
	useEffect(() => {
		if (!dragging) return;
		const finish = (event: PointerEvent) => {
			if (sessionRef.current?.pointerId !== event.pointerId) return;
			endDrag(event.type === "pointerup", true);
		};
		const abort = () => endDrag(false, true);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			abort();
		};
		const onHidden = () => { if (document.visibilityState === "hidden") abort(); };
		window.addEventListener("pointerup", finish, true);
		window.addEventListener("pointercancel", finish, true);
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("blur", abort);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			window.removeEventListener("pointerup", finish, true);
			window.removeEventListener("pointercancel", finish, true);
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("blur", abort);
			document.removeEventListener("visibilitychange", onHidden);
		};
	}, [dragging, endDrag]);

	useEffect(() => () => {
		const session = sessionRef.current;
		if (!session) return;
		if (session.rafId !== null) cancelAnimationFrame(session.rafId);
		document.body.style.cursor = session.previousCursor;
		document.body.style.userSelect = session.previousUserSelect;
		sessionRef.current = null;
	}, []);

	if (boundaries.length === 0) return null;

	const draggedBoundary = dragging ? boundaries.find((b) => b.splitId === dragging.splitId) ?? null : null;

	const paneName = (paneId: string) =>
		t("panes.paneLabel", { index: String(paneIndexById.get(paneId) ?? 1) });

	return (
		<div ref={layerRef} data-testid="native-pane-dividers" className="pointer-events-none absolute inset-0 z-20">
			{boundaries.map((boundary) => {
				const horizontal = boundary.orientation === "horizontal";
				const isDragging = dragging?.splitId === boundary.splitId;
				const percent = Math.round(boundary.ratio * 100);
				return (
					<div
						key={boundary.splitId}
						data-testid={`pane-divider-${boundary.splitId}`}
						data-split-id={boundary.splitId}
						data-dragging={isDragging ? "true" : "false"}
						role="separator"
						tabIndex={0}
						aria-orientation={horizontal ? "vertical" : "horizontal"}
						aria-label={t("panes.resizeDivider", { first: paneName(boundary.firstPaneId), second: paneName(boundary.secondPaneId) })}
						aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
						aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
						aria-valuenow={percent}
						aria-valuetext={t("panes.resizeDividerValue", { percent: String(percent) })}
						className={`group pointer-events-auto absolute flex touch-none items-center justify-center transition-colors focus-visible:outline-none ${
							horizontal ? "cursor-col-resize" : "cursor-row-resize"
						} ${isDragging ? "bg-accent/15" : "hover:bg-accent/10 focus-visible:bg-accent/10"}`}
						style={horizontal
							? {
								left: `calc(${boundary.position * 100}% - ${HIT_PX / 2}px)`,
								top: `${boundary.rect.y * 100}%`,
								width: `${HIT_PX}px`,
								height: `${boundary.rect.height * 100}%`,
							}
							: {
								top: `calc(${boundary.position * 100}% - ${HIT_PX / 2}px)`,
								left: `${boundary.rect.x * 100}%`,
								height: `${HIT_PX}px`,
								width: `${boundary.rect.width * 100}%`,
							}}
						onPointerDown={(event) => onPointerDown(event, boundary)}
						onPointerMove={(event) => onPointerMove(event, boundary)}
						onPointerUp={() => endDrag(true, true)}
						onPointerCancel={() => endDrag(false, true)}
						onLostPointerCapture={() => endDrag(true, false)}
						onDoubleClick={(event) => { event.stopPropagation(); onCommitRatio(boundary.splitId, 0.5); }}
						onClick={(event) => event.stopPropagation()}
						onKeyDown={(event) => {
							const back = horizontal ? "ArrowLeft" : "ArrowUp";
							const forward = horizontal ? "ArrowRight" : "ArrowDown";
							if (event.key !== back && event.key !== forward) return;
							event.preventDefault();
							event.stopPropagation();
							const step = event.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
							nudge(boundary, event.key === forward ? step : -step);
						}}
					>
						<div
							data-testid={`pane-divider-grip-${boundary.splitId}`}
							className={`rounded-full transition-colors ${horizontal ? "h-8 w-[3px]" : "w-8 h-[3px]"} ${
								isDragging ? "bg-accent" : "bg-fg-muted/60 group-hover:bg-accent group-focus-visible:bg-accent"
							}`}
						/>
					</div>
				);
			})}
			{draggedBoundary && (
				<div
					ref={ghostRef}
					data-testid="pane-divider-ghost"
					aria-hidden="true"
					className="absolute bg-accent"
					style={draggedBoundary.orientation === "horizontal"
						? {
							left: `${draggedBoundary.position * 100}%`,
							top: `${draggedBoundary.rect.y * 100}%`,
							height: `${draggedBoundary.rect.height * 100}%`,
							width: "2px",
						}
						: {
							top: `${draggedBoundary.position * 100}%`,
							left: `${draggedBoundary.rect.x * 100}%`,
							width: `${draggedBoundary.rect.width * 100}%`,
							height: "2px",
						}}
				/>
			)}
		</div>
	);
}
