import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";

const DEFAULT_BOARD_WIDTH = 320;
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_KANBAN_WIDTH = 200;
const MAX_KANBAN_RATIO = 0.6;
const DRAG_THRESHOLD_PX = 3;
const LS_KEY_BOARD = "dev3-split-kanban-width";
const LS_KEY_SIDEBAR = "dev3-split-sidebar-width";

function readStoredWidth(key: string, fallback: number): number {
	try {
		const v = localStorage.getItem(key);
		if (v) {
			const n = Number(v);
			if (Number.isFinite(n) && n >= MIN_KANBAN_WIDTH) return n;
		}
	} catch { /* ignore */ }
	return fallback;
}

interface SplitLayoutProps {
	kanbanContent: ReactNode;
	terminalContent: ReactNode;
	mode?: "sidebar" | "board";
}

function SplitLayout({ kanbanContent, terminalContent, mode = "board" }: SplitLayoutProps) {
	const lsKey = mode === "sidebar" ? LS_KEY_SIDEBAR : LS_KEY_BOARD;
	const defaultWidth = mode === "sidebar" ? DEFAULT_SIDEBAR_WIDTH : DEFAULT_BOARD_WIDTH;

	const [kanbanWidth, setKanbanWidth] = useState(() => readStoredWidth(lsKey, defaultWidth));
	const panelRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	// Reset width when mode changes
	useEffect(() => {
		setKanbanWidth(readStoredWidth(lsKey, defaultWidth));
	}, [lsKey, defaultWidth]);

	// Persist width to localStorage
	useEffect(() => {
		try {
			localStorage.setItem(lsKey, String(Math.round(kanbanWidth)));
		} catch { /* ignore */ }
	}, [kanbanWidth, lsKey]);

	// Clamp width on window resize
	useEffect(() => {
		function handleResize() {
			const maxW = window.innerWidth * MAX_KANBAN_RATIO;
			setKanbanWidth((prev) => Math.min(prev, maxW));
		}
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	const onDragStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		dragging.current = true;
		const startX = e.clientX;
		const startW = panelRef.current?.offsetWidth ?? kanbanWidth;
		const el = panelRef.current;
		let didDrag = false;

		function onMove(ev: MouseEvent) {
			if (!dragging.current) return;
			const dx = Math.abs(ev.clientX - startX);
			if (!didDrag && dx < DRAG_THRESHOLD_PX) return;
			if (!didDrag) {
				didDrag = true;
				if (el) el.style.transition = "none";
			}
			const maxW = window.innerWidth * MAX_KANBAN_RATIO;
			const newW = Math.min(maxW, Math.max(MIN_KANBAN_WIDTH, startW + (ev.clientX - startX)));
			if (el) el.style.width = `${newW}px`;
		}

		function onUp(ev: MouseEvent) {
			dragging.current = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			if (el) el.style.transition = "";
			if (didDrag && el) {
				const maxW = window.innerWidth * MAX_KANBAN_RATIO;
				const finalW = Math.min(maxW, Math.max(MIN_KANBAN_WIDTH, startW + (ev.clientX - startX)));
				setKanbanWidth(finalW);
			}
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [kanbanWidth]);

	function handleDoubleClick() {
		setKanbanWidth(defaultWidth);
		if (panelRef.current) {
			panelRef.current.style.width = `${defaultWidth}px`;
		}
	}

	return (
		<div className="flex-1 min-h-0 flex flex-row w-full">
			{/* Left: Kanban / Sidebar */}
			<div
				ref={panelRef}
				className="flex-shrink-0 flex flex-col overflow-hidden transition-[width] duration-200"
				style={{ width: kanbanWidth }}
			>
				{kanbanContent}
			</div>

			{/* Divider */}
			<div
				className="flex-shrink-0 w-[5px] cursor-col-resize group flex items-center justify-center hover:bg-accent/10 transition-colors"
				onMouseDown={onDragStart}
				onDoubleClick={handleDoubleClick}
			>
				<div className="w-[3px] h-8 rounded-full bg-fg-muted/40 group-hover:bg-fg-muted/70 transition-colors" />
			</div>

			{/* Right: Terminal */}
			<div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
				{terminalContent}
			</div>
		</div>
	);
}

export default SplitLayout;
