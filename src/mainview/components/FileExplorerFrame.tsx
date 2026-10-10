import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
	clampExplorerWidth,
	FILE_EXPLORER_DEFAULT_WIDTH,
	FILE_EXPLORER_MAX_WIDTH,
	FILE_EXPLORER_MIN_WIDTH,
	REVEAL_FILE_EXPLORER_EVENT,
	setFileExplorerMode,
	setFileExplorerWidth,
	useFileExplorerPrefs,
} from "../file-explorer-prefs";
import { useT } from "../i18n";
import FileExplorer, { ExplorerRailGlyph } from "./FileExplorer";
import Tooltip from "./Tooltip";

const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 300;

interface FileExplorerFrameProps {
	projectId: string;
	taskId?: string | null;
	rootLabel: string;
	/** False where the panel must not appear (narrow viewport, immersive, a diff over the pane). */
	enabled: boolean;
	onOpenYazi?: () => void;
	children: ReactNode;
}

/**
 * Lays the file explorer beside `children`. Pinned, it is a docked column and
 * the content gives up width. Auto-hidden, only a rail is docked and the tree
 * slides over the content, so a terminal behind it never changes size.
 */
export default function FileExplorerFrame({ projectId, taskId, rootLabel, enabled, onOpenYazi, children }: FileExplorerFrameProps) {
	const t = useT();
	const prefs = useFileExplorerPrefs();
	const mode = enabled ? prefs.mode : "hidden";
	const [revealed, setRevealed] = useState<"hover" | "sticky" | null>(null);
	const [focusSignal, setFocusSignal] = useState(0);
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const hoverTimer = useRef<number | null>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const railRef = useRef<HTMLDivElement>(null);
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;

	const clearHoverTimer = () => {
		if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
		hoverTimer.current = null;
	};
	useEffect(() => clearHoverTimer, []);
	useEffect(() => {
		if (mode !== "autohide") setRevealed(null);
	}, [mode]);

	useEffect(() => {
		if (mode !== "autohide") return;
		const onToggle = () => {
			if (revealedRef.current) {
				setRevealed(null);
				return;
			}
			setRevealed("sticky");
			setFocusSignal((n) => n + 1);
		};
		window.addEventListener(REVEAL_FILE_EXPLORER_EVENT, onToggle);
		return () => window.removeEventListener(REVEAL_FILE_EXPLORER_EVENT, onToggle);
	}, [mode]);

	// A sticky reveal ends on Escape or a press anywhere outside the panel and rail.
	useEffect(() => {
		if (!revealed) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (overlayRef.current?.contains(target) || railRef.current?.contains(target)) return;
			// Menus portal to <body>; a press inside one is not a press outside.
			if ((target as Element).closest?.("[role=menu]")) return;
			setRevealed(null);
		};
		// Capture phase: closing the panel must not also reach the app's own
		// Escape, which steps the route back.
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !overlayRef.current?.contains(document.activeElement)) return;
			event.preventDefault();
			event.stopPropagation();
			setRevealed(null);
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [revealed]);

	const onHoverEnter = () => {
		clearHoverTimer();
		if (revealed) return;
		hoverTimer.current = window.setTimeout(() => setRevealed("hover"), HOVER_OPEN_DELAY_MS);
	};
	const onHoverLeave = () => {
		clearHoverTimer();
		if (revealed !== "hover") return;
		hoverTimer.current = window.setTimeout(() => setRevealed(null), HOVER_CLOSE_DELAY_MS);
	};

	const width = prefs.width;

	// Live resizing would refit the terminal on every pointer move, so a ghost
	// line follows the pointer and the width lands once, on release.
	const dragRef = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);
	const onResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { startX: event.clientX, startWidth: width, lastWidth: width };
		setDragWidth(width);
	}, [width]);
	const onResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		drag.lastWidth = clampExplorerWidth(drag.startWidth + event.clientX - drag.startX);
		setDragWidth(drag.lastWidth);
	}, []);
	const onResizeEnd = useCallback(() => {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = null;
		setDragWidth(null);
		setFileExplorerWidth(drag.lastWidth);
	}, []);

	const explorer = mode === "hidden" ? null : (
		<FileExplorer
			projectId={projectId}
			taskId={taskId}
			rootLabel={rootLabel}
			pinned={mode === "pinned"}
			onTogglePin={() => setFileExplorerMode(mode === "pinned" ? "autohide" : "pinned")}
			onHide={() => setFileExplorerMode("hidden")}
			onHandOff={mode === "autohide" ? () => setRevealed(null) : undefined}
			onOpenYazi={onOpenYazi}
			focusSignal={focusSignal}
		/>
	);

	// `children` keeps the same slot in every mode: a terminal that remounted on
	// each toggle would drop and re-open its PTY connection.
	return (
		<div className="h-full w-full flex min-w-0 min-h-0 relative">
			{mode === "pinned" && (
				<div className="h-full flex-shrink-0 min-h-0 border-r border-edge" style={{ width }} data-testid="file-explorer-pinned">
					{explorer}
				</div>
			)}
			{mode === "pinned" && (
				<div
					role="separator"
					tabIndex={0}
					aria-orientation="vertical"
					aria-label={t("fileExplorer.resize")}
					aria-valuemin={FILE_EXPLORER_MIN_WIDTH}
					aria-valuemax={FILE_EXPLORER_MAX_WIDTH}
					aria-valuenow={width}
					onPointerDown={onResizeStart}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onPointerCancel={onResizeEnd}
					onDoubleClick={() => setFileExplorerWidth(FILE_EXPLORER_DEFAULT_WIDTH)}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft") { event.preventDefault(); setFileExplorerWidth(width - 24); }
						else if (event.key === "ArrowRight") { event.preventDefault(); setFileExplorerWidth(width + 24); }
					}}
					className="group absolute top-0 bottom-0 z-10 flex w-[9px] -translate-x-1/2 cursor-col-resize touch-none items-center justify-center focus-visible:outline-none"
					style={{ left: width }}
				>
					<div className={`h-8 w-[3px] rounded-full transition-colors group-hover:bg-accent group-focus-visible:bg-accent ${dragWidth !== null ? "bg-accent" : "bg-fg-muted/40"}`} />
				</div>
			)}
			{mode === "pinned" && dragWidth !== null && (
				<div aria-hidden="true" className="absolute inset-0 z-[60] cursor-col-resize">
					<div className="absolute top-0 bottom-0 w-[2px] bg-accent" style={{ left: dragWidth }} />
				</div>
			)}
			{mode === "autohide" && (
				<div
					ref={railRef}
					className="h-full w-8 flex-shrink-0 flex flex-col items-center pt-1.5 bg-raised border-r border-edge"
					onMouseEnter={onHoverEnter}
					onMouseLeave={onHoverLeave}
					data-testid="file-explorer-rail"
				>
					<Tooltip content={t("fileExplorer.showFiles")}>
						<button
							type="button"
							aria-label={t("fileExplorer.showFiles")}
							aria-expanded={revealed !== null}
							onClick={() => {
								clearHoverTimer();
								if (revealed === "sticky") {
									setRevealed(null);
									return;
								}
								setRevealed("sticky");
								setFocusSignal((n) => n + 1);
							}}
							className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
								revealed ? "text-accent" : "text-fg-3 hover:text-fg"
							}`}
						>
							<ExplorerRailGlyph />
						</button>
					</Tooltip>
				</div>
			)}
			<div className="relative flex-1 min-w-0 min-h-0 flex flex-col">
				{children}
				{mode === "autohide" && revealed && (
					<div
						ref={overlayRef}
						className="absolute top-0 bottom-0 left-0 z-40 max-w-[90%] border-r border-edge shadow-2xl shadow-black/40"
						style={{ width }}
						onMouseEnter={onHoverEnter}
						onMouseLeave={onHoverLeave}
						onFocus={() => setRevealed("sticky")}
						data-testid="file-explorer-overlay"
					>
						{explorer}
					</div>
				)}
			</div>
		</div>
	);
}
