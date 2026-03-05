import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";

const DEFAULT_KANBAN_WIDTH = 320;
const MIN_KANBAN_WIDTH = 300;
const MAX_KANBAN_RATIO = 0.6;
const LS_KEY = "dev3-split-kanban-width";

function readStoredWidth(): number {
	try {
		const v = localStorage.getItem(LS_KEY);
		if (v) {
			const n = Number(v);
			if (Number.isFinite(n) && n >= MIN_KANBAN_WIDTH) return n;
		}
	} catch { /* ignore */ }
	return DEFAULT_KANBAN_WIDTH;
}

interface SplitLayoutProps {
	kanbanContent: ReactNode;
	terminalContent: ReactNode;
}

function SplitLayout({ kanbanContent, terminalContent }: SplitLayoutProps) {
	const [kanbanWidth, setKanbanWidth] = useState(readStoredWidth);
	const panelRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	// Persist width to localStorage
	useEffect(() => {
		try {
			localStorage.setItem(LS_KEY, String(Math.round(kanbanWidth)));
		} catch { /* ignore */ }
	}, [kanbanWidth]);

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
		if (el) el.style.transition = "none";

		function onMove(ev: MouseEvent) {
			if (!dragging.current) return;
			const maxW = window.innerWidth * MAX_KANBAN_RATIO;
			const newW = Math.min(maxW, Math.max(MIN_KANBAN_WIDTH, startW + (ev.clientX - startX)));
			if (el) el.style.width = `${newW}px`;
		}

		function onUp(ev: MouseEvent) {
			dragging.current = false;
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			if (el) {
				el.style.transition = "";
				const maxW = window.innerWidth * MAX_KANBAN_RATIO;
				const finalW = Math.min(maxW, Math.max(MIN_KANBAN_WIDTH, startW + (ev.clientX - startX)));
				setKanbanWidth(finalW);
			}
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	}, [kanbanWidth]);

	function handleDoubleClick() {
		setKanbanWidth(DEFAULT_KANBAN_WIDTH);
		if (panelRef.current) {
			panelRef.current.style.width = `${DEFAULT_KANBAN_WIDTH}px`;
		}
	}

	return (
		<div className="flex-1 min-h-0 flex flex-row w-full">
			{/* Left: Kanban */}
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
