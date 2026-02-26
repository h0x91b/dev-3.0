import { useState, useRef, useCallback, useEffect } from "react";
import type { Task, Project } from "../../shared/types";
import { STATUS_COLORS } from "../../shared/types";
import { useT, statusKey } from "../i18n";

interface TaskInfoPanelProps {
	task: Task;
	project: Project;
}

const COLLAPSED_HEIGHT = 36;
const DEFAULT_HEIGHT = 200;
const MIN_HEIGHT = 80;
const MAX_RATIO = 0.33;

const LS_COLLAPSED = "dev3-panel-collapsed";
const LS_HEIGHT = "dev3-panel-height";

function readBool(key: string, fallback: boolean): boolean {
	try {
		const v = localStorage.getItem(key);
		if (v === "true") return true;
		if (v === "false") return false;
	} catch {}
	return fallback;
}

function readNumber(key: string, fallback: number): number {
	try {
		const v = localStorage.getItem(key);
		if (v !== null) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	} catch {}
	return fallback;
}

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

function TaskInfoPanel({ task, project }: TaskInfoPanelProps) {
	const t = useT();
	const [collapsed, setCollapsed] = useState(() => readBool(LS_COLLAPSED, true));
	const [panelHeight, setPanelHeight] = useState(() => readNumber(LS_HEIGHT, DEFAULT_HEIGHT));

	const panelRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	// Persist collapsed
	useEffect(() => {
		try { localStorage.setItem(LS_COLLAPSED, String(collapsed)); } catch {}
	}, [collapsed]);

	// Persist height
	useEffect(() => {
		try { localStorage.setItem(LS_HEIGHT, String(panelHeight)); } catch {}
	}, [panelHeight]);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((c) => !c);
	}, []);

	const onDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			if (collapsed) return;

			dragging.current = true;
			const startY = e.clientY;
			const startH = panelRef.current?.offsetHeight ?? panelHeight;
			const el = panelRef.current;

			if (el) el.style.transition = "none";

			function onMove(ev: MouseEvent) {
				if (!dragging.current) return;
				const maxH = window.innerHeight * MAX_RATIO;
				const newH = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)));
				if (el) el.style.height = `${newH}px`;
			}

			function onUp(ev: MouseEvent) {
				dragging.current = false;
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);

				if (el) {
					el.style.transition = "";
					const maxH = window.innerHeight * MAX_RATIO;
					const finalH = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)));
					setPanelHeight(finalH);
				}
			}

			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		},
		[collapsed, panelHeight],
	);

	const onHandleDoubleClick = useCallback(() => {
		setCollapsed((c) => !c);
	}, []);

	const statusColor = STATUS_COLORS[task.status];
	const height = collapsed ? COLLAPSED_HEIGHT : panelHeight;

	return (
		<div
			ref={panelRef}
			className="flex-shrink-0 border-b border-edge glass-header overflow-hidden transition-[height] duration-200 ease-out"
			style={{ height }}
		>
			{collapsed ? (
				/* ---- Collapsed: single row ---- */
				<div className="flex items-center h-full px-4 gap-3 min-w-0">
					<div
						className="w-2 h-2 rounded-full flex-shrink-0"
						style={{ background: statusColor }}
					/>
					<span className="text-fg-2 text-xs font-medium truncate">
						{t(statusKey(task.status))}
					</span>
					<span className="text-fg-muted text-xs">|</span>
					<span className="text-fg text-xs font-medium truncate flex-1">
						{task.title}
					</span>
					{task.branchName && (
						<>
							<span className="text-fg-muted text-xs">|</span>
							<span className="text-fg-3 text-xs font-mono truncate max-w-[200px]">
								{task.branchName}
							</span>
						</>
					)}
					<button
						onClick={toggleCollapsed}
						className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
						title={t("infoPanel.expand")}
					>
						<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
						</svg>
					</button>
				</div>
			) : (
				/* ---- Expanded ---- */
				<div className="flex flex-col h-full">
					{/* Header row with collapse button */}
					<div className="flex items-center px-4 py-2 gap-3 min-w-0">
						<div
							className="w-2 h-2 rounded-full flex-shrink-0"
							style={{ background: statusColor }}
						/>
						<span className="text-fg text-sm font-semibold truncate flex-1">
							{task.title}
						</span>
						<button
							onClick={toggleCollapsed}
							className="flex-shrink-0 p-1 rounded hover:bg-elevated transition-colors text-fg-3 hover:text-fg"
							title={t("infoPanel.collapse")}
						>
							<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
							</svg>
						</button>
					</div>

					{/* Metadata grid */}
					<div className="flex-1 overflow-auto px-4 pb-2">
						<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<span className="text-fg-3">{t("infoPanel.status")}</span>
							<span className="text-fg-2 font-medium" style={{ color: statusColor }}>
								{t(statusKey(task.status))}
							</span>

							{task.branchName && (
								<>
									<span className="text-fg-3">{t("infoPanel.branch")}</span>
									<span className="text-fg-2 font-mono">{task.branchName}</span>
								</>
							)}

							{task.description && (
								<>
									<span className="text-fg-3">{t("infoPanel.description")}</span>
									<span className="text-fg-2 whitespace-pre-wrap line-clamp-3">{task.description}</span>
								</>
							)}

							{task.worktreePath && (
								<>
									<span className="text-fg-3">{t("infoPanel.worktree")}</span>
									<span className="text-fg-3 font-mono truncate">{task.worktreePath}</span>
								</>
							)}

							<span className="text-fg-3">{t("infoPanel.created")}</span>
							<span className="text-fg-3">{formatDate(task.createdAt)}</span>

							<span className="text-fg-3">{t("infoPanel.updated")}</span>
							<span className="text-fg-3">{formatDate(task.updatedAt)}</span>
						</div>
					</div>

					{/* Drag handle */}
					<div
						className="flex-shrink-0 flex items-center justify-center h-[6px] cursor-row-resize group"
						onMouseDown={onDragStart}
						onDoubleClick={onHandleDoubleClick}
					>
						<div className="w-8 h-[3px] rounded-full bg-fg-muted/40 group-hover:bg-fg-muted/70 transition-colors" />
					</div>
				</div>
			)}
		</div>
	);
}

export default TaskInfoPanel;
